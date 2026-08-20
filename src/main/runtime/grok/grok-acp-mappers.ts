import { createHash } from 'node:crypto'
import type * as acp from '@agentclientprotocol/sdk'
import type {
  AgentCapabilityId,
  AgentCapabilityState,
  AgentDiff,
  AgentOperationTarget,
  AgentOperationType,
  AgentPermissionRisk,
  AgentRuntimeCapabilitySnapshot,
  AgentTurnOutcome,
  AgentTurnUsage
} from '../../../shared/agent'
import type { AgentAvailableCommand } from '../../../shared/agent-available-command'
import type { AgentRuntimePermissionRequest } from '../../agent/agent-runtime-adapter'
import type { AgentEventDraft, AgentEventDraftBase } from '../../agent/event-normalizer'
import {
  createAgentRuntimeCapabilitySnapshot,
  updateAgentRuntimeCapabilitySnapshot,
  type AgentCapabilityInput
} from '../../agent/runtime-capabilities'

export const GROK_RUNTIME_ID = 'grok' as const

const MAX_PERMISSION_PAYLOAD_BYTES = 256 * 1024
const MAX_PERMISSION_DISPLAY_TEXT_BYTES = 4 * 1024
export const MAX_GROK_TOOL_CALL_ID_BYTES = 4 * 1024
const MAX_TOOL_CALL_PATCH_PATHS = 32
const MAX_TOOL_CALL_TARGET_PATHS = 32
const MAX_TOOL_CALL_PATH_BYTES = 16 * 1024
const MAX_TOOL_CALL_AUTHORIZATION_SNAPSHOT_BYTES = 64 * 1024
const MAX_TOOL_CALL_DIFF_HASH_INPUT_BYTES = 256 * 1024

type TextRedactor = (text: string) => string

/**
 * 当前 Turn 内可用于权限判断的 ACP 工具事实。
 * 这里只保留稳定结构化字段和 Diff 摘要，禁止缓存原始输入、输出、元数据或 Diff 正文。
 */
export type GrokToolCallAuthorizationSnapshot =
  GrokValidToolCallAuthorizationSnapshot | GrokInvalidToolCallAuthorizationSnapshot

export interface GrokValidToolCallAuthorizationSnapshot {
  integrity: 'valid'
  toolCallId: string
  kind?: acp.ToolKind
  locationPaths: string[]
  diffPaths: string[]
  diffFingerprint?: string
}

export interface GrokInvalidToolCallAuthorizationSnapshot {
  integrity: 'invalid'
  toolCallId: string
  reason: 'budget-exceeded' | 'target-conflict'
}

/** Grok 当前由标准 ACP 路径确认的静态能力；恢复能力必须等待握手证据。 */
const GROK_STATIC_CAPABILITIES: readonly AgentCapabilityInput[] = [
  ...[
    'runtime.connect',
    'session.create',
    'session.prompt.text',
    'session.cancel',
    'event.agent-message',
    'event.agent-thought',
    'event.plan',
    'event.tool',
    'event.diff',
    'permission.request'
  ].map((capabilityId): AgentCapabilityInput => ({
    capabilityId: capabilityId as AgentCapabilityId,
    support: 'native',
    maturity: 'stable',
    verification: 'declared',
    source: 'static'
  })),
  {
    capabilityId: 'usage.context',
    support: 'native',
    maturity: 'experimental',
    verification: 'declared',
    source: 'static',
    reason: 'Grok ACP Context Usage 当前按实验性能力接入。'
  },
  {
    capabilityId: 'usage.turn',
    support: 'native',
    maturity: 'experimental',
    verification: 'declared',
    source: 'static',
    reason: 'Grok ACP Turn Usage 当前按实验性能力接入。'
  }
]

/** 创建 Grok 静态能力基线，未经握手证实的 load/resume 保守标记为未验证。 */
export function createGrokCapabilitySnapshot(
  redactText?: TextRedactor
): AgentRuntimeCapabilitySnapshot {
  return createAgentRuntimeCapabilitySnapshot({
    runtimeId: GROK_RUNTIME_ID,
    capabilities: GROK_STATIC_CAPABILITIES,
    ...(redactText ? { redactText } : {})
  })
}

/**
 * 只投影 ACP initialize 标准字段并校验协商版本；_meta、认证方式和扩展字段全部丢弃。
 */
export function mapGrokInitializeCapabilitySnapshot(
  baseline: AgentRuntimeCapabilitySnapshot,
  response: acp.InitializeResponse,
  redactText: TextRedactor,
  protocolVersion: number
): AgentRuntimeCapabilitySnapshot {
  if (response.protocolVersion !== protocolVersion) {
    throw new Error(
      `ACP 协议版本不兼容：Runtime 返回 ${response.protocolVersion}，客户端支持 ${protocolVersion}。`
    )
  }

  const runtimeVersion = response.agentInfo?.version?.trim()
  let snapshot = createAgentRuntimeCapabilitySnapshot({
    runtimeId: GROK_RUNTIME_ID,
    ...(runtimeVersion ? { runtimeVersion: redactText(runtimeVersion) } : {}),
    protocolVersion: String(response.protocolVersion),
    capabilities: Object.values(baseline.capabilities),
    redactText
  })

  snapshot = updateAgentRuntimeCapabilitySnapshot(
    snapshot,
    response.agentCapabilities?.loadSession === true
      ? {
          capabilityId: 'session.load',
          support: 'native',
          maturity: 'stable',
          verification: 'declared',
          source: 'protocol'
        }
      : {
          capabilityId: 'session.load',
          support: 'unsupported',
          verification: 'declared',
          source: 'protocol',
          reason: 'Grok Runtime 未声明 ACP session/load 支持。'
        },
    { redactText }
  )

  return updateAgentRuntimeCapabilitySnapshot(
    snapshot,
    response.agentCapabilities?.sessionCapabilities?.resume != null
      ? {
          capabilityId: 'session.resume',
          support: 'native',
          maturity: 'stable',
          verification: 'declared',
          source: 'protocol'
        }
      : {
          capabilityId: 'session.resume',
          support: 'unsupported',
          verification: 'declared',
          source: 'protocol',
          reason: 'Grok Runtime 未声明 ACP session/resume 支持。'
        },
    { redactText }
  )
}

/**
 * 将 ACP SessionUpdate 显式投影为中性事件；未声明字段和未知事件不得越过 Adapter。
 */
export function mapGrokSessionUpdate(
  params: acp.SessionNotification,
  redactText: TextRedactor
): AgentEventDraft[] {
  const update = params.update
  const base = createGrokEventBase(params.sessionId, 'native')

  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      if (update.content.type !== 'text') return []
      return [
        {
          ...base,
          kind: 'agent-message',
          text: redactText(update.content.text),
          ...(update.messageId != null ? { messageId: update.messageId } : {})
        }
      ]
    case 'agent_thought_chunk':
      if (update.content.type !== 'text') return []
      return [
        {
          ...base,
          kind: 'agent-thought',
          text: redactText(update.content.text),
          ...(update.messageId != null ? { messageId: update.messageId } : {})
        }
      ]
    case 'tool_call': {
      const toolEvent: AgentEventDraft = {
        ...base,
        kind: 'tool-call',
        toolCallId: update.toolCallId,
        title: redactText(update.title),
        ...(update.status != null ? { status: update.status } : {})
      }
      return appendMappedDiffEvent(toolEvent, update.toolCallId, update.content, base, redactText)
    }
    case 'tool_call_update': {
      const toolEvent: AgentEventDraft = {
        ...base,
        kind: 'tool-update',
        toolCallId: update.toolCallId,
        ...(update.title != null ? { title: redactText(update.title) } : {}),
        ...(update.status != null ? { status: update.status } : {})
      }
      return appendMappedDiffEvent(toolEvent, update.toolCallId, update.content, base, redactText)
    }
    case 'plan':
      return [
        {
          ...base,
          kind: 'plan',
          entries: update.entries.map((entry) => ({
            content: redactText(entry.content),
            priority: entry.priority,
            status: entry.status
          }))
        }
      ]
    case 'usage_update':
      return [
        {
          ...createGrokEventBase(params.sessionId, 'experimental'),
          kind: 'usage',
          usage: {
            scope: 'context',
            usedTokens: update.used,
            limitTokens: update.size,
            ...(update.cost
              ? { cost: { amount: update.cost.amount, currency: update.cost.currency } }
              : {})
          }
        }
      ]
    case 'available_commands_update':
      // 斜杠命令走 mapGrokAvailableCommands 旁路快照，不进 Timeline 事件流
      return []
    case 'user_message_chunk':
    case 'plan_update':
    case 'plan_removed':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
      return []
    default:
      return [
        {
          ...createGrokEventBase(params.sessionId, 'unsupported'),
          kind: 'error',
          message: '收到当前版本暂不支持的 Runtime 事件，已安全忽略。',
          recoverable: true,
          code: 'unsupported-runtime-event'
        }
      ]
  }
}

/**
 * 将 ACP available_commands_update 投影为产品命令快照项。
 * 这是 session 旁路通道：只保留可展示字段并脱敏，不写入 AgentEvent / Timeline；
 * 条数上限与 name 形态校验留给 Preload 的 parseAvailableCommandSnapshot。
 */
export function mapGrokAvailableCommands(
  update: acp.AvailableCommandsUpdate,
  redactText: TextRedactor
): AgentAvailableCommand[] {
  const rawCommands = update.availableCommands
  if (!Array.isArray(rawCommands)) return []

  const commands: AgentAvailableCommand[] = []
  for (const item of rawCommands) {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) continue

    const { name, description, input } = item as {
      name?: unknown
      description?: unknown
      input?: { hint?: unknown } | null
    }
    if (typeof name !== 'string' || typeof description !== 'string') continue

    const command: AgentAvailableCommand = {
      name,
      description: redactText(description)
    }

    const hint = input == null ? undefined : input.hint
    if (typeof hint === 'string' && hint.length > 0) {
      command.inputHint = redactText(hint)
    }

    commands.push(command)
  }

  return commands
}

/** 将 ACP PromptResponse 收敛为中性 Turn 终态，丢弃 _meta 等协议扩展字段。 */
export function mapGrokPromptResponse(
  response: acp.PromptResponse,
  runtimeSessionId: string
): Extract<AgentEventDraft, { kind: 'turn-complete' }> {
  return {
    ...createGrokEventBase(runtimeSessionId, 'native'),
    kind: 'turn-complete',
    outcome: mapGrokStopReason(response.stopReason),
    ...(response.usage ? { usage: mapGrokTurnUsage(response.usage) } : {})
  }
}

/**
 * 将 ACP 稳定字段投影为主进程内部权限请求。
 * rawInput/rawOutput/_meta/name 一律丢弃；Diff 正文只生成不可逆参数摘要，不进入展示或持久化 DTO。
 */
export function mapGrokPermissionRequest(
  params: acp.RequestPermissionRequest,
  requestId: string,
  taskId: string,
  turnId: string,
  redactText: TextRedactor,
  executionSupported: boolean,
  authorizationSnapshot: GrokToolCallAuthorizationSnapshot = mergeGrokToolCallAuthorizationPatch(
    undefined,
    params.toolCall
  )
): AgentRuntimePermissionRequest | null {
  if (!isSafeGrokToolCallId(params.toolCall.toolCallId)) return null
  const title = limitPermissionDisplayText(
    redactText(params.toolCall.title ?? 'Grok Build 请求执行操作')
  )
  const mapped = mapGrokOperation(authorizationSnapshot)
  const request: AgentRuntimePermissionRequest = {
    requestId,
    runtimeId: GROK_RUNTIME_ID,
    taskId,
    turnId,
    runtimeSessionId: params.sessionId,
    toolCallId: params.toolCall.toolCallId,
    operationType: mapped.operationType,
    targets: mapped.targets,
    parameterFingerprint: mapped.parameterFingerprint,
    title: title.value,
    impact: mapped.impact,
    ...(mapped.minimumRisk ? { minimumRisk: mapped.minimumRisk } : {}),
    executionSupported: executionSupported && authorizationSnapshot.integrity === 'valid'
  }

  return isPermissionRequestWithinBudget(request) ? request : null
}

/**
 * 按 ACP patch 语义累积授权事实，但已观察到的 kind、目标或 Diff 证据不得被缩小或改写。
 * 预算超限和证据冲突都会生成粘性 invalid 墓碑，当前 ToolCall 生命周期内禁止恢复。
 */
export function mergeGrokToolCallAuthorizationPatch(
  previous: GrokToolCallAuthorizationSnapshot | undefined,
  patch: acp.ToolCallUpdate
): GrokToolCallAuthorizationSnapshot {
  if (!isSafeGrokToolCallId(patch.toolCallId)) {
    return invalidAuthorizationSnapshot(patch.toolCallId, 'budget-exceeded')
  }
  if (previous?.toolCallId === patch.toolCallId && previous.integrity === 'invalid') return previous
  const current =
    previous?.toolCallId === patch.toolCallId && previous.integrity === 'valid'
      ? previous
      : undefined
  if (countPatchPathEntries(patch) > MAX_TOOL_CALL_PATCH_PATHS) {
    return invalidAuthorizationSnapshot(patch.toolCallId, 'budget-exceeded')
  }
  let kind = current?.kind
  let locationPaths = current ? [...current.locationPaths] : []
  let diffPaths = current ? [...current.diffPaths] : []
  let diffFingerprint = current?.diffFingerprint

  if (patch.kind !== undefined) {
    if (patch.kind == null) {
      if (kind != null) return invalidAuthorizationSnapshot(patch.toolCallId, 'target-conflict')
      kind = undefined
    } else if (kind != null && patch.kind !== kind) {
      return invalidAuthorizationSnapshot(patch.toolCallId, 'target-conflict')
    } else {
      kind = patch.kind
    }
  }
  if (patch.locations !== undefined) {
    const nextLocations = collectPatchPaths(
      patch.toolCallId,
      (patch.locations ?? []).map((location) => location.path)
    )
    if (nextLocations.integrity === 'invalid') return nextLocations
    if (current && !isMonotonicPathEvidence(locationPaths, nextLocations.paths)) {
      return invalidAuthorizationSnapshot(patch.toolCallId, 'target-conflict')
    }
    locationPaths = nextLocations.paths
  }
  if (patch.content !== undefined) {
    const diffs = (patch.content ?? []).filter(
      (content): content is Extract<acp.ToolCallContent, { type: 'diff' }> =>
        content.type === 'diff'
    )
    const nextDiffPaths = collectPatchPaths(
      patch.toolCallId,
      diffs.map((diff) => diff.path)
    )
    if (nextDiffPaths.integrity === 'invalid') return nextDiffPaths
    if (current && !isMonotonicPathEvidence(diffPaths, nextDiffPaths.paths)) {
      return invalidAuthorizationSnapshot(patch.toolCallId, 'target-conflict')
    }
    const nextFingerprint = hashGrokDiffs(diffs)
    if (nextFingerprint === null) {
      return invalidAuthorizationSnapshot(patch.toolCallId, 'budget-exceeded')
    }
    if (current?.diffFingerprint && nextFingerprint !== current.diffFingerprint) {
      return invalidAuthorizationSnapshot(patch.toolCallId, 'target-conflict')
    }
    diffPaths = nextDiffPaths.paths
    diffFingerprint = nextFingerprint
  }

  const snapshot: GrokValidToolCallAuthorizationSnapshot = {
    integrity: 'valid',
    toolCallId: patch.toolCallId,
    ...(kind ? { kind } : {}),
    locationPaths,
    diffPaths,
    ...(diffFingerprint ? { diffFingerprint } : {})
  }
  if (
    uniqueNonEmptyPaths([...locationPaths, ...diffPaths]).length > MAX_TOOL_CALL_TARGET_PATHS ||
    authorizationSnapshotBytes(snapshot) > MAX_TOOL_CALL_AUTHORIZATION_SNAPSHOT_BYTES
  ) {
    return invalidAuthorizationSnapshot(patch.toolCallId, 'budget-exceeded')
  }
  return snapshot
}

/**
 * 比较两份授权快照是否表达同一组安全事实。
 * 路径顺序和行号不影响授权；kind、目标集合、Diff 摘要或 invalid 原因变化都必须视为改写。
 */
export function areGrokAuthorizationSnapshotsEquivalent(
  previous: GrokToolCallAuthorizationSnapshot,
  next: GrokToolCallAuthorizationSnapshot
): boolean {
  if (previous.toolCallId !== next.toolCallId || previous.integrity !== next.integrity) return false
  if (previous.integrity === 'invalid' && next.integrity === 'invalid') {
    return previous.reason === next.reason
  }
  if (previous.integrity !== 'valid' || next.integrity !== 'valid') return false
  return (
    previous.kind === next.kind &&
    previous.diffFingerprint === next.diffFingerprint &&
    haveSameStringSet(previous.locationPaths, next.locationPaths) &&
    haveSameStringSet(previous.diffPaths, next.diffPaths)
  )
}

function mapGrokOperation(snapshot: GrokToolCallAuthorizationSnapshot): {
  operationType: AgentOperationType
  targets: AgentOperationTarget[]
  parameterFingerprint: string
  impact: string
  minimumRisk?: AgentPermissionRisk
} {
  if (snapshot.integrity === 'invalid') {
    return {
      operationType: 'unknown',
      targets: [{ kind: 'unknown', value: 'Runtime 权限证据无效，已安全拒绝。' }],
      parameterFingerprint: `grok-acp:invalid:${snapshot.reason}:v1`,
      impact: 'Runtime 权限证据不完整或发生冲突，当前请求不允许执行。',
      minimumRisk: 'L3'
    }
  }
  const kind = snapshot.kind ?? 'other'
  const paths = collectGrokPermissionPaths(snapshot)
  const pathTargets = paths.map((value): AgentOperationTarget => ({ kind: 'path', value }))

  if ((kind === 'read' || kind === 'search') && pathTargets.length) {
    return {
      operationType: 'read-project',
      targets: pathTargets,
      parameterFingerprint: `grok-acp:${kind}:v1`,
      impact: '读取当前 Project 内的指定路径。'
    }
  }
  if (kind === 'edit' && pathTargets.length) {
    return {
      operationType: 'write-file',
      targets: pathTargets,
      parameterFingerprint: createGrokEditFingerprint(snapshot),
      impact: '修改当前 Project 内的指定文件。'
    }
  }
  if (kind === 'delete' && pathTargets.length) {
    return {
      operationType: 'delete-path',
      targets: pathTargets,
      parameterFingerprint: 'grok-acp:delete:v1',
      impact: '删除当前 Project 内的指定路径，此操作可能不可恢复。'
    }
  }
  if (kind === 'execute') {
    return {
      operationType: 'execute-command',
      targets: [{ kind: 'command', value: 'Runtime 未提供可信的结构化命令。' }],
      parameterFingerprint: 'grok-acp:execute:unknown-command:v1',
      impact: 'Runtime 请求执行命令，但当前 ACP 请求无法准确展示命令与参数。',
      minimumRisk: 'L3'
    }
  }
  if (kind === 'fetch') {
    return {
      operationType: 'network-egress',
      targets: [{ kind: 'unknown', value: 'Runtime 未提供可信的目标 origin。' }],
      parameterFingerprint: 'grok-acp:fetch:unknown-origin:v1',
      impact: 'Runtime 请求访问网络，但当前 ACP 请求无法准确展示目标和外发内容。',
      minimumRisk: 'L3'
    }
  }

  return {
    operationType: 'unknown',
    targets: pathTargets.length
      ? pathTargets
      : [{ kind: 'unknown', value: 'Runtime 未提供可验证的操作目标。' }],
    parameterFingerprint: `grok-acp:${kind}:unknown:v1`,
    impact: '当前 Runtime 请求无法准确映射为已识别操作，只能按未知高风险处理。',
    minimumRisk: 'L3'
  }
}

function collectGrokPermissionPaths(snapshot: GrokToolCallAuthorizationSnapshot): string[] {
  if (snapshot.integrity === 'invalid') return []
  return uniqueNonEmptyPaths([...snapshot.locationPaths, ...snapshot.diffPaths])
}

function uniqueNonEmptyPaths(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => typeof path === 'string' && path.trim()))]
}

function haveSameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const rightValues = new Set(right)
  return left.every((value) => rightValues.has(value))
}

/**
 * ACP Diff 是当前唯一稳定的编辑参数来源；只保存 SHA-256 摘要。
 * 没有可信 Diff 时绑定 toolCallId，使产品级 Task grant 无法扩展到后续编辑请求。
 */
function createGrokEditFingerprint(snapshot: GrokToolCallAuthorizationSnapshot): string {
  if (snapshot.integrity === 'invalid') return `grok-acp:invalid:${snapshot.reason}:v1`
  if (snapshot.diffFingerprint) return snapshot.diffFingerprint

  const digest = createHash('sha256').update(snapshot.toolCallId).digest('hex')
  return `grok-acp:edit:tool-call:sha256:${digest}`
}

function invalidAuthorizationSnapshot(
  toolCallId: string,
  reason: GrokInvalidToolCallAuthorizationSnapshot['reason']
): GrokInvalidToolCallAuthorizationSnapshot {
  return {
    integrity: 'invalid',
    toolCallId: isSafeGrokToolCallId(toolCallId) ? toolCallId : hashToolCallId(toolCallId),
    reason
  }
}

function collectPatchPaths(
  toolCallId: string,
  paths: string[]
): { integrity: 'valid'; paths: string[] } | GrokInvalidToolCallAuthorizationSnapshot {
  if (paths.length > MAX_TOOL_CALL_PATCH_PATHS) {
    return invalidAuthorizationSnapshot(toolCallId, 'budget-exceeded')
  }
  for (const path of paths) {
    if (Buffer.byteLength(path, 'utf8') > MAX_TOOL_CALL_PATH_BYTES) {
      return invalidAuthorizationSnapshot(toolCallId, 'budget-exceeded')
    }
  }
  const uniquePaths = uniqueNonEmptyPaths(paths)
  if (uniquePaths.length > MAX_TOOL_CALL_TARGET_PATHS) {
    return invalidAuthorizationSnapshot(toolCallId, 'budget-exceeded')
  }
  return { integrity: 'valid', paths: uniquePaths }
}

function countPatchPathEntries(patch: acp.ToolCallUpdate): number {
  const locationCount = patch.locations?.length ?? 0
  const diffCount = (patch.content ?? []).filter((content) => content.type === 'diff').length
  return locationCount + diffCount
}

/** 后续 patch 只能保持或扩张已观察目标；清空、缩小和替换都会失败关闭。 */
function isMonotonicPathEvidence(previous: string[], next: string[]): boolean {
  if (previous.length === 0) return true
  const nextPaths = new Set(next)
  return previous.every((path) => nextPaths.has(path))
}

/** Diff 使用分段增量哈希，并在读取无界正文前按 UTF-8 bytes 扣减总预算。 */
function hashGrokDiffs(
  diffs: Extract<acp.ToolCallContent, { type: 'diff' }>[]
): string | undefined | null {
  if (diffs.length === 0) return undefined
  const hash = createHash('sha256')
  let inputBytes = 0
  for (const diff of diffs) {
    const values = [
      { marker: 'path', value: diff.path },
      {
        marker:
          diff.oldText === undefined
            ? 'old:missing'
            : diff.oldText === null
              ? 'old:null'
              : 'old:text',
        value: diff.oldText ?? ''
      },
      { marker: 'new', value: diff.newText }
    ]
    for (const { marker, value } of values) {
      const markerBytes = Buffer.byteLength(marker, 'utf8')
      const valueBytes = Buffer.byteLength(value, 'utf8')
      inputBytes += 4 + markerBytes + 4 + valueBytes
      if (inputBytes > MAX_TOOL_CALL_DIFF_HASH_INPUT_BYTES) return null
      const markerLength = Buffer.allocUnsafe(4)
      markerLength.writeUInt32BE(markerBytes)
      hash.update(markerLength)
      hash.update(marker, 'utf8')
      const valueLength = Buffer.allocUnsafe(4)
      valueLength.writeUInt32BE(valueBytes)
      hash.update(valueLength)
      hash.update(value, 'utf8')
    }
  }
  return `grok-acp:edit:diff:sha256:${hash.digest('hex')}`
}

function authorizationSnapshotBytes(snapshot: GrokValidToolCallAuthorizationSnapshot): number {
  try {
    return Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export function isSafeGrokToolCallId(toolCallId: string): boolean {
  return (
    typeof toolCallId === 'string' &&
    Boolean(toolCallId.trim()) &&
    !toolCallId.includes('\0') &&
    Buffer.byteLength(toolCallId, 'utf8') <= MAX_GROK_TOOL_CALL_ID_BYTES
  )
}

function hashToolCallId(toolCallId: string): string {
  return `sha256:${createHash('sha256').update(String(toolCallId)).digest('hex')}`
}

export function createGrokEventBase(
  runtimeSessionId: string,
  capabilityState: AgentCapabilityState
): AgentEventDraftBase {
  return {
    runtimeId: GROK_RUNTIME_ID,
    runtimeSessionId,
    capabilityState
  }
}

function appendMappedDiffEvent(
  toolEvent: AgentEventDraft,
  toolCallId: string,
  content: acp.ToolCallContent[] | null | undefined,
  base: AgentEventDraftBase,
  redactText: TextRedactor
): AgentEventDraft[] {
  const diffs = mapGrokDiffs(content, redactText)
  if (diffs.length === 0) return [toolEvent]

  return [toolEvent, { ...base, kind: 'diff', toolCallId, diffs }]
}

function mapGrokDiffs(
  content: acp.ToolCallContent[] | null | undefined,
  redactText: TextRedactor
): AgentDiff[] {
  return (content ?? []).flatMap((item) =>
    item.type === 'diff'
      ? [
          {
            format: 'snapshot' as const,
            path: redactText(item.path),
            before: item.oldText == null ? null : redactText(item.oldText),
            after: redactText(item.newText)
          }
        ]
      : []
  )
}

function mapGrokStopReason(stopReason: acp.StopReason): AgentTurnOutcome {
  switch (stopReason) {
    case 'end_turn':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
    case 'refusal':
      return 'refused'
    case 'max_tokens':
    case 'max_turn_requests':
      return 'limit-reached'
  }
}

function mapGrokTurnUsage(usage: acp.Usage): AgentTurnUsage {
  return {
    scope: 'turn',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.thoughtTokens != null ? { thoughtTokens: usage.thoughtTokens } : {}),
    ...(usage.cachedReadTokens != null ? { cachedReadTokens: usage.cachedReadTokens } : {}),
    ...(usage.cachedWriteTokens != null ? { cachedWriteTokens: usage.cachedWriteTokens } : {})
  }
}

/** 权限展示文案按 UTF-8 bytes 截断，避免中文或 emoji 被切成无效编码。 */
function limitPermissionDisplayText(value: string): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= MAX_PERMISSION_DISPLAY_TEXT_BYTES) {
    return { value, truncated: false }
  }

  const characters: string[] = []
  let acceptedBytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (acceptedBytes + characterBytes > MAX_PERMISSION_DISPLAY_TEXT_BYTES) break
    characters.push(character)
    acceptedBytes += characterBytes
  }
  return { value: characters.join(''), truncated: true }
}

/** 标识符保持原值；若完整权限 DTO 仍超限，则整项拒绝而不破坏 ACP 回传标识。 */
function isPermissionRequestWithinBudget(request: AgentRuntimePermissionRequest): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(request), 'utf8') <= MAX_PERMISSION_PAYLOAD_BYTES
  } catch {
    return false
  }
}
