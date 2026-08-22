import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { ProjectAvailability } from '../../shared/task-history'
import type {
  BaselineInvalidation,
  ResolvedProjectRoot,
  TaskChangeBaseline,
  TaskChangePathKind,
  TaskChangePathSnapshot
} from '../../shared/git-review'
import { redactSensitiveText } from '../security/sensitive-redaction'
import { AtomicJsonWriter } from '../storage/atomic-json-file'
import {
  isPathInsideRoot,
  resolveProjectRoot,
  runReadOnlyGit,
  sameCanonicalPath,
  toPosixRelativePath,
  type ReadOnlyGitOptions
} from '../project/project-root-resolver'

const MAX_BASELINE_FILE_BYTES = 512 * 1024
const MAX_IDENTIFIER_BYTES = 4 * 1024
const DEFAULT_MAX_PATHS = 200
const DEFAULT_MAX_HASH_FILE_BYTES = 256 * 1024
const DEFAULT_MAX_HASH_TOTAL_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_PORCELAIN_CHARS = 8 * 1024
const BINARY_SAMPLE_BYTES = 8 * 1024
const MAX_STATUS_CODE_CHARS = 8

export interface CaptureTaskChangeBaselineOptions {
  now?: () => string
  gitExecutable?: string
  sourceEnvironment?: NodeJS.ProcessEnv
  maxPaths?: number
  maxHashFileBytes?: number
  maxHashTotalBytes?: number
  maxPorcelainChars?: number
}

export interface TaskChangeBaselineStoreOptions {
  /** 注入的存储根；测试传入 tmpdir，生产由组装层注入 userData/git-review。 */
  rootDir: string
  writer?: AtomicJsonWriter
}

export interface EnsureTaskChangeBaselineDependencies {
  store: TaskChangeBaselineStore
  getProjectAvailability: (projectId: string) => Promise<ProjectAvailability>
  now?: () => string
  gitExecutable?: string
  sourceEnvironment?: NodeJS.ProcessEnv
}

/**
 * 在首个写 Turn 前记录 base commit 与已有脏路径。
 * 只保存哈希和限长 porcelain，不把用户文件正文写入 JSON。
 */
export async function captureTaskChangeBaseline(
  resolved: ResolvedProjectRoot,
  options: CaptureTaskChangeBaselineOptions = {}
): Promise<TaskChangeBaseline> {
  const now = options.now ?? (() => new Date().toISOString())
  const capturedAt = now()
  const base: TaskChangeBaseline = {
    schemaVersion: 1,
    taskId: resolved.taskId,
    environmentId: resolved.environmentId,
    environmentKind: 'local',
    executionRoot: resolved.executionRoot,
    gitPresence: resolved.git.kind,
    capturedAt,
    status: 'captured',
    preExistingPaths: [],
    ...(resolved.rootFingerprint ? { rootFingerprint: resolved.rootFingerprint } : {})
  }

  if (resolved.git.kind === 'invalid') {
    return { ...base, status: 'unavailable' }
  }
  if (resolved.git.kind === 'non-git') {
    return {
      ...base,
      status: resolved.git.reason === 'git-unavailable' ? 'unavailable' : 'captured'
    }
  }

  const git = resolved.git
  const gitOptions: ReadOnlyGitOptions = {
    gitExecutable: options.gitExecutable,
    sourceEnvironment: options.sourceEnvironment,
    allowedRoot: resolved.executionRoot
  }
  const status = await runReadOnlyGit(
    git.gitRoot,
    ['-c', 'core.quotepath=false', 'status', '--porcelain=v2', '--untracked-files=all'],
    gitOptions
  )

  const withGitIdentity: TaskChangeBaseline = {
    ...base,
    gitRoot: git.gitRoot,
    ...(git.head.oid ? { baseCommit: git.head.oid } : {}),
    ...(git.head.branch ? { headBranch: git.head.branch } : {}),
    detached: git.head.detached,
    nestedGit: git.nested
  }

  if (!status.ok && status.unavailable) {
    return { ...withGitIdentity, status: 'unavailable' }
  }

  let preExistingPaths: TaskChangePathSnapshot[] = []
  let truncated: true | undefined
  let porcelainSummary: string | undefined
  if (status.ok) {
    porcelainSummary = boundPorcelainSummary(
      status.stdout,
      resolved.executionRoot,
      git.gitRoot,
      options.maxPorcelainChars ?? DEFAULT_MAX_PORCELAIN_CHARS
    )
    const snapshot = await snapshotPreExistingPaths(
      status.stdout,
      resolved.executionRoot,
      git.gitRoot,
      options
    )
    preExistingPaths = snapshot.paths
    if (snapshot.truncated) truncated = true
  } else {
    truncated = true
  }

  return {
    ...withGitIdentity,
    status: 'captured',
    preExistingPaths,
    ...(porcelainSummary ? { porcelainSummary } : {}),
    ...(truncated ? { truncated: true } : {})
  }
}

/**
 * 基线一旦因 Git root / HEAD / 路径 / 项目可用性漂移而失效，就必须停止自动归因，且不得偷偷重建。
 */
export function evaluateBaselineValidity(
  baseline: TaskChangeBaseline,
  currentResolved: ResolvedProjectRoot,
  projectAvailability: ProjectAvailability
): BaselineInvalidation {
  if (projectAvailability.state !== 'available') {
    return { valid: false, reason: 'project-unavailable' }
  }
  if (currentResolved.git.kind === 'invalid') {
    if (currentResolved.git.reason === 'root-missing') {
      return { valid: false, reason: 'root-missing' }
    }
    return { valid: false, reason: 'path-replaced' }
  }
  if (!sameCanonicalPath(baseline.executionRoot, currentResolved.executionRoot)) {
    return { valid: false, reason: 'path-replaced' }
  }
  if (
    baseline.rootFingerprint &&
    currentResolved.rootFingerprint &&
    baseline.rootFingerprint !== currentResolved.rootFingerprint
  ) {
    return { valid: false, reason: 'path-replaced' }
  }

  const currentGitRoot =
    currentResolved.git.kind === 'git' ? currentResolved.git.gitRoot : undefined
  if (baseline.gitPresence !== currentResolved.git.kind || baseline.gitRoot !== currentGitRoot) {
    return { valid: false, reason: 'git-root-changed' }
  }

  const currentNested = currentResolved.git.kind === 'git' ? currentResolved.git.nested : false
  if (Boolean(baseline.nestedGit) !== currentNested) {
    return { valid: false, reason: 'nested-changed' }
  }

  if (baseline.gitPresence === 'git' && currentResolved.git.kind === 'git') {
    if ((baseline.baseCommit ?? null) !== currentResolved.git.head.oid) {
      return { valid: false, reason: 'head-changed' }
    }
  }
  return { valid: true }
}

/**
 * 按 taskId+environmentId 持久化基线。已存在且仍 captured 则不覆盖；invalid 后拒绝 recapture。
 */
export class TaskChangeBaselineStore {
  readonly rootDir: string
  private readonly writer: AtomicJsonWriter

  constructor(options: TaskChangeBaselineStoreOptions) {
    if (!isNonEmptyPath(options.rootDir)) {
      throw new Error('Git 审阅存储根无效。')
    }
    this.rootDir = options.rootDir
    this.writer = options.writer ?? new AtomicJsonWriter()
  }

  async get(taskId: string, environmentId: string): Promise<TaskChangeBaseline | null> {
    assertStoreIdentity(taskId)
    assertStoreIdentity(environmentId)
    try {
      const raw = await this.writer.read(
        this.filePath(taskId, environmentId),
        MAX_BASELINE_FILE_BYTES
      )
      return parseTaskChangeBaseline(raw)
    } catch {
      return null
    }
  }

  async put(baseline: TaskChangeBaseline): Promise<TaskChangeBaseline> {
    const parsed = parseTaskChangeBaseline(baseline)
    if (!parsed) throw new Error('任务变更基线无效。')
    const existing = await this.get(parsed.taskId, parsed.environmentId)
    if (existing?.status === 'invalid') return existing
    if (existing?.status === 'captured' && parsed.status === 'captured') return existing
    await this.writer.write(this.filePath(parsed.taskId, parsed.environmentId), parsed)
    return parsed
  }

  private filePath(taskId: string, environmentId: string): string {
    const digest = createHash('sha256')
      .update(taskId)
      .update('\0')
      .update(environmentId)
      .digest('hex')
    return join(this.rootDir, `${digest}.json`)
  }
}

/**
 * TaskExecutor 可选 hook：每次 start 都评估，但只在首次为 (taskId, environmentId) 捕获。
 * 失效后写入 invalidReason，绝不自动 recapture。
 */
export function createEnsureTaskChangeBaseline(
  deps: EnsureTaskChangeBaselineDependencies
): (input: {
  taskId: string
  projectId: string
  environmentId: string
  executionRoot: string
}) => Promise<void> {
  return async (input) => {
    const resolved = await resolveProjectRoot({
      taskId: input.taskId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      environmentKind: 'local',
      executionRoot: input.executionRoot,
      now: deps.now,
      gitExecutable: deps.gitExecutable,
      sourceEnvironment: deps.sourceEnvironment
    })
    const existing = await deps.store.get(input.taskId, input.environmentId)
    if (existing?.status === 'invalid') return

    let availability: ProjectAvailability
    try {
      availability = await deps.getProjectAvailability(input.projectId)
    } catch {
      availability = { state: 'unavailable', message: 'Project 当前不可用。' }
    }

    if (existing?.status === 'captured') {
      const validity = evaluateBaselineValidity(existing, resolved, availability)
      if (validity.valid) return
      await deps.store.put({
        ...existing,
        status: 'invalid',
        ...(validity.reason ? { invalidReason: validity.reason } : {})
      })
      return
    }

    const baseline = await captureTaskChangeBaseline(resolved, {
      now: deps.now,
      gitExecutable: deps.gitExecutable,
      sourceEnvironment: deps.sourceEnvironment
    })
    await deps.store.put(baseline)
  }
}

interface PorcelainEntry {
  path: string
  kind: TaskChangePathKind
  statusCode: string
}

async function snapshotPreExistingPaths(
  stdout: string,
  executionRoot: string,
  gitRoot: string,
  options: CaptureTaskChangeBaselineOptions
): Promise<{ paths: TaskChangePathSnapshot[]; truncated: boolean }> {
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS
  const maxFileBytes = options.maxHashFileBytes ?? DEFAULT_MAX_HASH_FILE_BYTES
  const maxTotalBytes = options.maxHashTotalBytes ?? DEFAULT_MAX_HASH_TOTAL_BYTES
  const entries = parsePorcelainV2(stdout)
  const paths: TaskChangePathSnapshot[] = []
  let truncated = false
  let hashedBytes = 0

  for (const entry of entries) {
    const relativePath = toExecutionRelativePath(executionRoot, gitRoot, entry.path)
    if (!relativePath) continue
    if (paths.length >= maxPaths) {
      truncated = true
      paths.push({ path: relativePath, kind: entry.kind, omitted: 'limit' })
      break
    }
    const absolutePath = resolve(gitRoot, entry.path)
    const hashed = await hashWorkingTreeFile(
      absolutePath,
      maxFileBytes,
      maxTotalBytes - hashedBytes
    )
    const snapshot: TaskChangePathSnapshot = {
      path: relativePath,
      kind: entry.kind,
      statusCode: entry.statusCode.slice(0, MAX_STATUS_CODE_CHARS)
    }
    if (hashed.kind === 'hash') {
      snapshot.contentHash = hashed.contentHash
      hashedBytes += hashed.bytes
    } else if (hashed.kind === 'omitted') {
      snapshot.omitted = hashed.omitted
    }
    paths.push(snapshot)
  }
  return { paths, truncated }
}

async function hashWorkingTreeFile(
  absolutePath: string,
  maxFileBytes: number,
  remainingTotalBytes: number
): Promise<
  | { kind: 'hash'; contentHash: string; bytes: number }
  | { kind: 'omitted'; omitted: 'too-large' | 'binary' }
  | { kind: 'skip' }
> {
  let handle: fs.FileHandle | null = null
  try {
    const stats = await fs.stat(absolutePath)
    if (!stats.isFile()) return { kind: 'skip' }
    if (stats.size > maxFileBytes || stats.size > remainingTotalBytes) {
      return { kind: 'omitted', omitted: 'too-large' }
    }
    handle = await fs.open(absolutePath, 'r')
    const sampleSize = Math.min(stats.size, BINARY_SAMPLE_BYTES)
    const sample = Buffer.alloc(sampleSize)
    await handle.read(sample, 0, sampleSize, 0)
    if (sample.includes(0)) return { kind: 'omitted', omitted: 'binary' }
    const contents = Buffer.alloc(stats.size)
    if (stats.size > 0) await handle.read(contents, 0, stats.size, 0)
    return {
      kind: 'hash',
      contentHash: createHash('sha256').update(contents).digest('hex'),
      bytes: stats.size
    }
  } catch {
    return { kind: 'skip' }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function parsePorcelainV2(stdout: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = []
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('? ')) {
      entries.push({ path: line.slice(2), kind: 'untracked', statusCode: '?' })
      continue
    }
    if (line.startsWith('! ')) continue
    const ordinary = line.match(/^1 (\S+) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/u)
    if (ordinary?.[1] && ordinary[2]) {
      entries.push({ path: ordinary[2], kind: 'tracked', statusCode: ordinary[1] })
      continue
    }
    const renamed = line.match(/^2 (\S+) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/u)
    if (renamed?.[1] && renamed[2]) {
      const [path] = renamed[2].split('\t')
      if (path) entries.push({ path, kind: 'tracked', statusCode: renamed[1] })
      continue
    }
    const unmerged = line.match(/^u (\S+) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/u)
    if (unmerged?.[1] && unmerged[2]) {
      entries.push({ path: unmerged[2], kind: 'tracked', statusCode: unmerged[1] })
    }
  }
  return entries
}

function toExecutionRelativePath(
  executionRoot: string,
  gitRoot: string,
  gitRelativePath: string
): string | null {
  if (
    !gitRelativePath ||
    gitRelativePath.includes('\0') ||
    isAbsolute(gitRelativePath) ||
    hasParentTraversal(gitRelativePath)
  ) {
    return null
  }
  const absolutePath = resolve(gitRoot, gitRelativePath)
  if (!isPathInsideRoot(executionRoot, absolutePath) || !isPathInsideRoot(gitRoot, absolutePath)) {
    return null
  }
  return toPosixRelativePath(executionRoot, absolutePath)
}

function boundPorcelainSummary(
  stdout: string,
  executionRoot: string,
  gitRoot: string,
  maxChars: number
): string | undefined {
  const stripped = stdout.replaceAll(executionRoot, '.').replaceAll(gitRoot, '.')
  const redacted = redactSensitiveText(stripped)
  const trimmed = redacted.trim()
  if (!trimmed) return undefined
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed
}

function parseTaskChangeBaseline(value: unknown): TaskChangeBaseline | null {
  if (!isPlainRecord(value) || value.schemaVersion !== 1) return null
  if (!isStoreIdentity(value.taskId) || !isStoreIdentity(value.environmentId)) return null
  if (value.environmentKind !== 'local') return null
  if (
    typeof value.executionRoot !== 'string' ||
    !value.executionRoot ||
    value.executionRoot.includes('\0')
  ) {
    return null
  }
  if (
    value.gitPresence !== 'git' &&
    value.gitPresence !== 'non-git' &&
    value.gitPresence !== 'invalid'
  ) {
    return null
  }
  if (typeof value.capturedAt !== 'string' || !value.capturedAt) return null
  if (value.status !== 'captured' && value.status !== 'invalid' && value.status !== 'unavailable') {
    return null
  }
  if (!Array.isArray(value.preExistingPaths)) return null
  const preExistingPaths: TaskChangePathSnapshot[] = []
  for (const item of value.preExistingPaths) {
    const parsed = parsePathSnapshot(item)
    if (!parsed) return null
    preExistingPaths.push(parsed)
  }
  const baseline: TaskChangeBaseline = {
    schemaVersion: 1,
    taskId: value.taskId,
    environmentId: value.environmentId,
    environmentKind: 'local',
    executionRoot: value.executionRoot,
    gitPresence: value.gitPresence,
    capturedAt: value.capturedAt,
    status: value.status,
    preExistingPaths
  }
  if (typeof value.gitRoot === 'string') baseline.gitRoot = value.gitRoot
  if (typeof value.baseCommit === 'string') baseline.baseCommit = value.baseCommit
  if (typeof value.headBranch === 'string') baseline.headBranch = value.headBranch
  if (typeof value.detached === 'boolean') baseline.detached = value.detached
  if (typeof value.nestedGit === 'boolean') baseline.nestedGit = value.nestedGit
  if (isInvalidReason(value.invalidReason)) baseline.invalidReason = value.invalidReason
  if (typeof value.porcelainSummary === 'string') baseline.porcelainSummary = value.porcelainSummary
  if (value.truncated === true) baseline.truncated = true
  if (typeof value.rootFingerprint === 'string') baseline.rootFingerprint = value.rootFingerprint
  return baseline
}

function parsePathSnapshot(value: unknown): TaskChangePathSnapshot | null {
  if (
    !isPlainRecord(value) ||
    typeof value.path !== 'string' ||
    !value.path ||
    value.path.includes('\0')
  ) {
    return null
  }
  if (value.kind !== 'tracked' && value.kind !== 'untracked') return null
  const snapshot: TaskChangePathSnapshot = { path: value.path, kind: value.kind }
  if (typeof value.statusCode === 'string') snapshot.statusCode = value.statusCode
  if (typeof value.contentHash === 'string') snapshot.contentHash = value.contentHash
  if (value.omitted === 'too-large' || value.omitted === 'binary' || value.omitted === 'limit') {
    snapshot.omitted = value.omitted
  }
  return snapshot
}

function isInvalidReason(
  value: unknown
): value is NonNullable<TaskChangeBaseline['invalidReason']> {
  return (
    value === 'git-root-changed' ||
    value === 'head-changed' ||
    value === 'path-replaced' ||
    value === 'root-missing' ||
    value === 'project-unavailable' ||
    value === 'nested-changed'
  )
}

function assertStoreIdentity(value: string): void {
  if (!isStoreIdentity(value)) throw new Error('任务变更基线身份无效。')
}

function isStoreIdentity(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return false
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') return false
  return Buffer.byteLength(value, 'utf8') <= MAX_IDENTIFIER_BYTES
}

function isNonEmptyPath(value: string): boolean {
  return value.length > 0 && !value.includes('\0')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasParentTraversal(value: string): boolean {
  return value.split(/[\\/]+/u).some((segment) => segment === '..')
}
