import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import {
  AGENT_OPERATION_TYPES,
  type AgentOperationTarget,
  type AgentOperationType,
  type AgentPermissionResolutionReason,
  type AgentPermissionRisk,
  type AgentPermissionScope,
  type OperationIntent
} from '../../shared/agent'

const MAX_IDENTIFIER_BYTES = 4 * 1024
const MAX_PATH_BYTES = 16 * 1024
const MAX_DISPLAY_TEXT_BYTES = 4 * 1024
const MAX_TARGETS = 32
const MAX_TRUSTED_EXTERNAL_ROOTS = 8

const RISK_ORDER: Record<AgentPermissionRisk, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3
}

const DEFAULT_RISK: Record<AgentOperationType, AgentPermissionRisk> = {
  'read-project': 'L0',
  'write-file': 'L1',
  'execute-command': 'L2',
  'delete-path': 'L3',
  'git-read': 'L0',
  'git-mutate': 'L2',
  'worktree-create': 'L2',
  'worktree-remove': 'L3',
  'network-egress': 'L2',
  browser: 'L3',
  screen: 'L3',
  clipboard: 'L3',
  unknown: 'L3'
}

const OPERATION_TARGET_KINDS: Record<AgentOperationType, readonly AgentOperationTarget['kind'][]> =
  {
    'read-project': ['project', 'path'],
    'write-file': ['path'],
    'execute-command': ['command', 'unknown'],
    'delete-path': ['path'],
    'git-read': ['git'],
    'git-mutate': ['git'],
    'worktree-create': ['worktree', 'path', 'project'],
    'worktree-remove': ['worktree', 'path'],
    'network-egress': ['origin', 'unknown'],
    browser: ['unknown'],
    screen: ['unknown'],
    clipboard: ['unknown'],
    unknown: ['unknown', 'path']
  }

const APP_SERVICE_OPERATIONS: Record<
  Extract<OperationIntent['initiator'], { kind: 'app' }>['service'],
  readonly AgentOperationType[]
> = {
  'command-runner': ['execute-command'],
  git: ['git-read', 'git-mutate'],
  worktree: ['worktree-create', 'worktree-remove'],
  other: ['read-project', 'write-file', 'delete-path', 'network-egress', 'unknown']
}

const DANGEROUS_GIT_TARGETS = new Set([
  'force-reset',
  'hard-reset',
  'force-push',
  'force-clean',
  'rewrite-history'
])

export type PermissionPolicyEvaluation =
  | { kind: 'allow'; risk: 'L0'; allowedScopes: [] }
  | {
      kind: 'approval'
      risk: AgentPermissionRisk
      allowedScopes: AgentPermissionScope[]
    }
  | {
      kind: 'deny'
      risk: AgentPermissionRisk
      reason: Extract<AgentPermissionResolutionReason, 'unsupported'>
      allowedScopes: []
    }

export interface ResolvedOperationIntent extends OperationIntent {
  executionRoot: string
  targets: AgentOperationTarget[]
}

export type PermissionPolicyErrorCode = 'invalid-intent' | 'invalid-target'

/** 策略错误只携带有限分类，路径和原始 Runtime 文案不得拼入消息。 */
export class PermissionPolicyError extends Error {
  constructor(
    readonly code: PermissionPolicyErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'PermissionPolicyError'
  }
}

/** Local 环境 ID 只由已确认的 Project 与 canonical root 派生，不提前持久化 Worktree 模型。 */
export function createLocalEnvironmentId(projectId: string, canonicalRoot: string): string {
  assertRequiredText(projectId, MAX_IDENTIFIER_BYTES, 'Project ID')
  assertRequiredText(canonicalRoot, MAX_PATH_BYTES, 'Execution root')
  const normalizedRoot = process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot
  const digest = createHash('sha256')
    .update('local\0')
    .update(projectId)
    .update('\0')
    .update(normalizedRoot)
    .digest('hex')
  return `local:${digest.slice(0, 32)}`
}

/**
 * 固定首期风险表。minimumRisk 只能升级，Runtime 或调用方不能用它降低默认风险。
 * Browser、Screen、Clipboard 在能力真正接入前直接拒绝。
 */
export function evaluatePermissionPolicy(intent: OperationIntent): PermissionPolicyEvaluation {
  validateOperationIntent(intent)
  const defaultRisk = DEFAULT_RISK[intent.operationType]
  const risk = maxRisk(defaultRisk, isDangerousGitMutation(intent) ? 'L3' : intent.minimumRisk)

  if (['browser', 'screen', 'clipboard'].includes(intent.operationType)) {
    return { kind: 'deny', risk, reason: 'unsupported', allowedScopes: [] }
  }
  // 共享记忆树是 Runtime 自己的笔记，不是项目逃逸；读/写不再打断 Grok 记东西。
  if (areAllPathTargetsInsideTrustedExternalRoots(intent) && risk !== 'L3') {
    if (intent.operationType === 'read-project' || intent.operationType === 'write-file') {
      return { kind: 'allow', risk: 'L0', allowedScopes: [] }
    }
  }
  if (risk === 'L0') return { kind: 'allow', risk, allowedScopes: [] }
  if (risk === 'L3') return { kind: 'approval', risk, allowedScopes: ['once'] }
  return { kind: 'approval', risk, allowedScopes: ['once', 'task'] }
}

/**
 * 把所有 path 目标解析到真实 execution root。不存在叶子使用最近存在祖先的 realpath，
 * 因此内部符号链接可以使用，但指向 root 外的链接会在副作用前被拒绝。
 */
export async function resolveOperationIntentTargets(
  intent: OperationIntent
): Promise<ResolvedOperationIntent> {
  validateOperationIntent(intent)
  const canonicalRoot = await resolveCanonicalRoot(intent.executionRoot)
  const expectedEnvironmentId = createLocalEnvironmentId(intent.projectId, canonicalRoot)
  if (intent.environmentId !== expectedEnvironmentId) {
    throw new PermissionPolicyError('invalid-target', 'Execution environment 与 Project 不匹配。')
  }
  const trustedExternalRoots = await resolveTrustedExternalRoots(intent.trustedExternalRoots)
  const targets: AgentOperationTarget[] = []

  for (const target of intent.targets) {
    if (target.kind === 'origin') {
      targets.push({ kind: 'origin', value: normalizeNetworkOrigin(target.value) })
      continue
    }
    if (target.kind !== 'path') {
      targets.push({ ...target })
      continue
    }
    const canonicalTarget = await resolveCanonicalTarget(
      canonicalRoot,
      target.value,
      trustedExternalRoots
    )
    if (
      isProtectedRootPath(canonicalTarget, canonicalRoot, trustedExternalRoots) &&
      ['write-file', 'delete-path', 'worktree-remove'].includes(intent.operationType)
    ) {
      throw new PermissionPolicyError('invalid-target', '不能对 execution root 本身执行该操作。')
    }
    targets.push({ kind: 'path', value: canonicalTarget })
  }

  return {
    ...intent,
    executionRoot: canonicalRoot,
    targets,
    ...(trustedExternalRoots.length ? { trustedExternalRoots } : {})
  }
}

/** 授权键使用 canonical target 和参数指纹；任何身份或约束不同都不能命中。 */
export function createOperationGrantKey(intent: ResolvedOperationIntent): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        initiator: intent.initiator,
        taskId: intent.taskId,
        projectId: intent.projectId,
        environmentId: intent.environmentId,
        operationType: intent.operationType,
        targets: intent.targets,
        parameterFingerprint: intent.parameterFingerprint
      })
    )
    .digest('hex')
}

/** 共享 DTO 的主进程形状校验；只接受有限字段，不把校验责任下放 Renderer。 */
export function validateOperationIntent(intent: OperationIntent): void {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new PermissionPolicyError('invalid-intent', '操作意图无效。')
  }
  if (!AGENT_OPERATION_TYPES.includes(intent.operationType)) {
    throw new PermissionPolicyError('invalid-intent', '操作类别无效。')
  }
  assertRequiredText(intent.taskId, MAX_IDENTIFIER_BYTES, 'Task ID')
  assertRequiredText(intent.turnId, MAX_IDENTIFIER_BYTES, 'Turn ID')
  assertRequiredText(intent.projectId, MAX_IDENTIFIER_BYTES, 'Project ID')
  assertRequiredText(intent.environmentId, MAX_IDENTIFIER_BYTES, 'Environment ID')
  assertRequiredText(intent.executionRoot, MAX_PATH_BYTES, 'Execution root')
  if (!isAbsolute(intent.executionRoot)) {
    throw new PermissionPolicyError('invalid-intent', 'Execution root 必须是绝对路径。')
  }
  validateTrustedExternalRoots(intent.trustedExternalRoots)
  assertRequiredText(intent.parameterFingerprint, MAX_IDENTIFIER_BYTES, '参数约束')
  assertRequiredText(intent.title, MAX_DISPLAY_TEXT_BYTES, '操作标题')
  assertRequiredText(intent.impact, MAX_DISPLAY_TEXT_BYTES, '操作影响')
  validateInitiator(intent)
  if (
    !Array.isArray(intent.targets) ||
    intent.targets.length === 0 ||
    intent.targets.length > MAX_TARGETS
  ) {
    throw new PermissionPolicyError('invalid-intent', '操作目标无效。')
  }
  for (const target of intent.targets) validateTarget(target)
  validateRequiredTargetKinds(intent)
  if (intent.minimumRisk && !Object.hasOwn(RISK_ORDER, intent.minimumRisk)) {
    throw new PermissionPolicyError('invalid-intent', '最低风险等级无效。')
  }
}

function validateInitiator(intent: OperationIntent): void {
  const initiator = intent.initiator
  if (!initiator || typeof initiator !== 'object' || Array.isArray(initiator)) {
    throw new PermissionPolicyError('invalid-intent', '操作发起者无效。')
  }
  if (initiator.kind === 'runtime') {
    if (!['grok', 'codex'].includes(initiator.runtimeId)) {
      throw new PermissionPolicyError('invalid-intent', 'Runtime 发起者无效。')
    }
    return
  }
  if (initiator.kind !== 'app' || !Object.hasOwn(APP_SERVICE_OPERATIONS, initiator.service)) {
    throw new PermissionPolicyError('invalid-intent', 'App 发起者无效。')
  }
  if (!APP_SERVICE_OPERATIONS[initiator.service].includes(intent.operationType)) {
    throw new PermissionPolicyError('invalid-intent', 'App 服务与操作类别不匹配。')
  }
}

function validateTarget(target: AgentOperationTarget): void {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new PermissionPolicyError('invalid-intent', '操作目标无效。')
  }
  if (
    !['path', 'project', 'origin', 'command', 'git', 'worktree', 'unknown'].includes(target.kind)
  ) {
    throw new PermissionPolicyError('invalid-intent', '操作目标类别无效。')
  }
  assertRequiredText(
    target.value,
    target.kind === 'path' ? MAX_PATH_BYTES : MAX_DISPLAY_TEXT_BYTES,
    '操作目标'
  )
  if (target.kind === 'origin') normalizeNetworkOrigin(target.value)
  if (target.kind === 'path' && hasParentTraversal(target.value)) {
    throw new PermissionPolicyError('invalid-target', '目标路径不能包含父目录跳转。')
  }
}

function validateRequiredTargetKinds(intent: OperationIntent): void {
  const kinds = new Set(intent.targets.map((target) => target.kind))
  const allowedKinds = new Set(OPERATION_TARGET_KINDS[intent.operationType])
  if (intent.targets.some((target) => !allowedKinds.has(target.kind))) {
    throw new PermissionPolicyError('invalid-intent', '操作包含不允许的目标类别。')
  }
  if (
    intent.targets.some((target) => target.kind === 'project' && target.value !== intent.projectId)
  ) {
    throw new PermissionPolicyError('invalid-target', 'Project 目标与操作身份不匹配。')
  }
  if (intent.operationType === 'read-project' && !kinds.has('project') && !kinds.has('path')) {
    throw new PermissionPolicyError('invalid-intent', '项目读取缺少受限目标。')
  }
  const requiresPath = ['write-file', 'delete-path'].includes(intent.operationType)
  if (requiresPath && !kinds.has('path')) {
    throw new PermissionPolicyError('invalid-intent', '该操作缺少路径目标。')
  }
  if (
    intent.operationType === 'execute-command' &&
    !kinds.has('command') &&
    !kinds.has('unknown')
  ) {
    throw new PermissionPolicyError('invalid-intent', '命令操作缺少受限目标。')
  }
  if (intent.operationType === 'network-egress') {
    if (!kinds.has('origin') && !kinds.has('unknown')) {
      throw new PermissionPolicyError('invalid-intent', '网络操作缺少受限目标。')
    }
    if (kinds.has('unknown') && intent.minimumRisk !== 'L3') {
      throw new PermissionPolicyError('invalid-intent', '未知网络目标必须按最高风险逐次确认。')
    }
  }
  if (['git-read', 'git-mutate'].includes(intent.operationType) && !kinds.has('git')) {
    throw new PermissionPolicyError('invalid-intent', 'Git 操作缺少受限目标。')
  }
  if (['worktree-create', 'worktree-remove'].includes(intent.operationType)) {
    if (!kinds.has('worktree') || (!kinds.has('path') && !kinds.has('project'))) {
      throw new PermissionPolicyError('invalid-intent', 'Worktree 操作缺少受限目标。')
    }
  }
  if (intent.operationType === 'worktree-remove' && !kinds.has('path')) {
    throw new PermissionPolicyError('invalid-intent', '移除 Worktree 必须包含明确路径。')
  }
}

/** 危险 Git 动作由结构化目标直接提升为 L3，不能依赖调用方自报 minimumRisk。 */
function isDangerousGitMutation(intent: OperationIntent): boolean {
  return (
    intent.operationType === 'git-mutate' &&
    intent.targets.some(
      (target) =>
        target.kind === 'git' && DANGEROUS_GIT_TARGETS.has(target.value.trim().toLowerCase())
    )
  )
}

/** 网络授权只绑定明确 HTTP(S) origin，禁止凭据、路径、query 或 hash 扩大授权语义。 */
function normalizeNetworkOrigin(value: string): string {
  try {
    const parsed = new URL(value)
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      (parsed.pathname !== '/' && parsed.pathname !== '') ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('unsafe-origin')
    }
    return parsed.origin
  } catch {
    throw new PermissionPolicyError('invalid-target', '网络目标必须是安全的 HTTP(S) origin。')
  }
}

function maxRisk(
  defaultRisk: AgentPermissionRisk,
  minimumRisk?: AgentPermissionRisk
): AgentPermissionRisk {
  if (!minimumRisk) return defaultRisk
  return RISK_ORDER[minimumRisk] > RISK_ORDER[defaultRisk] ? minimumRisk : defaultRisk
}

async function resolveCanonicalRoot(root: string): Promise<string> {
  try {
    const stats = await fs.stat(root)
    if (!stats.isDirectory()) throw new Error('not-directory')
    return await fs.realpath(root)
  } catch {
    throw new PermissionPolicyError('invalid-target', 'Execution root 当前不可用。')
  }
}

async function resolveCanonicalTarget(
  canonicalRoot: string,
  value: string,
  trustedExternalRoots: string[]
): Promise<string> {
  if (value.includes('\0') || hasParentTraversal(value)) {
    throw new PermissionPolicyError('invalid-target', '目标路径无效。')
  }
  const candidate = normalize(isAbsolute(value) ? value : resolve(canonicalRoot, value))
  const canonicalTarget = await realpathWithMissingLeaf(candidate)
  if (isPathInside(canonicalRoot, canonicalTarget)) return canonicalTarget
  if (trustedExternalRoots.some((root) => isPathInside(root, canonicalTarget)))
    return canonicalTarget
  throw new PermissionPolicyError('invalid-target', '目标路径超出 execution root。')
}

async function resolveTrustedExternalRoots(values: string[] | undefined): Promise<string[]> {
  if (!values?.length) return []
  const roots: string[] = []
  for (const value of values) {
    try {
      const canonical = await fs.realpath(value)
      const stats = await fs.stat(canonical)
      if (!stats.isDirectory()) continue
      if (!roots.some((existing) => samePath(existing, canonical))) roots.push(canonical)
    } catch {
      // 缺目录的信任根不能扩大授权；记忆目录应在 ensureShare 之后存在。
    }
  }
  return roots
}

function areAllPathTargetsInsideTrustedExternalRoots(intent: OperationIntent): boolean {
  const roots = intent.trustedExternalRoots
  if (!roots?.length) return false
  const pathTargets = intent.targets.filter((target) => target.kind === 'path')
  if (pathTargets.length === 0 || pathTargets.length !== intent.targets.length) return false
  return pathTargets.every((target) =>
    roots.some((root) => isPathInside(root, target.value) && target.value !== root)
  )
}

function isProtectedRootPath(
  canonicalTarget: string,
  canonicalRoot: string,
  trustedExternalRoots: string[]
): boolean {
  return (
    samePath(canonicalTarget, canonicalRoot) ||
    trustedExternalRoots.some((root) => samePath(canonicalTarget, root))
  )
}

function validateTrustedExternalRoots(values: unknown): void {
  if (values == null) return
  if (!Array.isArray(values) || values.length > MAX_TRUSTED_EXTERNAL_ROOTS) {
    throw new PermissionPolicyError('invalid-intent', '额外信任根无效。')
  }
  for (const value of values) {
    assertRequiredText(value, MAX_PATH_BYTES, '额外信任根')
    if (!isAbsolute(value) || hasParentTraversal(value)) {
      throw new PermissionPolicyError('invalid-intent', '额外信任根必须是绝对路径。')
    }
  }
}

function samePath(left: string, right: string): boolean {
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase()
  }
  return left === right
}

async function realpathWithMissingLeaf(candidate: string): Promise<string> {
  let existing = candidate
  const missingSegments: string[] = []
  while (true) {
    try {
      const canonicalAncestor = await fs.realpath(existing)
      return normalize(join(canonicalAncestor, ...missingSegments.reverse()))
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw new PermissionPolicyError('invalid-target', '目标路径当前不可访问。')
      }
      const parent = resolve(existing, '..')
      if (parent === existing) {
        throw new PermissionPolicyError('invalid-target', '目标路径当前不可访问。')
      }
      missingSegments.push(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
      existing = parent
    }
  }
}

function isPathInside(root: string, target: string): boolean {
  const comparedRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const comparedTarget = process.platform === 'win32' ? target.toLowerCase() : target
  const child = relative(comparedRoot, comparedTarget)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

function hasParentTraversal(value: string): boolean {
  return value.split(/[\\/]+/u).some((segment) => segment === '..')
}

function assertRequiredText(
  value: unknown,
  maxBytes: number,
  label: string
): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw new PermissionPolicyError('invalid-intent', `${label} 无效。`)
  }
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
