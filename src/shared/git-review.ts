import { parseValidationResult, type ValidationResult } from './command'

/**
 * 主进程解析结果。绝对路径只留在主进程，本任务不经 IPC 交给 Renderer。
 */
export type ProjectGitPresence =
  | { kind: 'git'; gitRoot: string; head: GitHeadState; nested: boolean }
  | { kind: 'non-git'; reason: 'no-repository' | 'parent-escaped' | 'git-unavailable' }
  | { kind: 'invalid'; reason: 'root-missing' | 'not-directory' | 'escaped' | 'unavailable' }

export interface GitHeadState {
  oid: string | null
  branch: string | null
  detached: boolean
}

export interface ResolvedProjectRoot {
  taskId: string
  projectId: string
  environmentId: string
  environmentKind: 'local'
  executionRoot: string
  git: ProjectGitPresence
  resolvedAt: string
  /**
   * execution root 的设备/inode 指纹。仅主进程用于识别同路径目录被替换。
   */
  rootFingerprint?: string
}

export type TaskChangePathKind = 'tracked' | 'untracked'
export type TaskChangeBaselineStatus = 'captured' | 'invalid' | 'unavailable'

export interface TaskChangePathSnapshot {
  path: string
  kind: TaskChangePathKind
  statusCode?: string
  contentHash?: string
  omitted?: 'too-large' | 'binary' | 'limit'
}

export interface TaskChangeBaseline {
  schemaVersion: 1
  taskId: string
  environmentId: string
  environmentKind: 'local'
  executionRoot: string
  gitRoot?: string
  baseCommit?: string
  headBranch?: string
  detached?: boolean
  nestedGit?: boolean
  gitPresence: ProjectGitPresence['kind']
  capturedAt: string
  status: TaskChangeBaselineStatus
  invalidReason?:
    | 'git-root-changed'
    | 'head-changed'
    | 'path-replaced'
    | 'root-missing'
    | 'project-unavailable'
    | 'nested-changed'
  porcelainSummary?: string
  preExistingPaths: TaskChangePathSnapshot[]
  truncated?: true
  /**
   * execution root 的设备/inode 指纹。仅主进程用于识别同路径目录被替换，不得当作 IPC 字段。
   */
  rootFingerprint?: string
}

export interface BaselineInvalidation {
  valid: boolean
  reason?: NonNullable<TaskChangeBaseline['invalidReason']>
}

/** 无法证明属于本 Task 的变化一律不得标成可安全撤销。 */
export type TaskChangeAttribution =
  | 'pre-existing'
  | 'task-added'
  | 'task-modified'
  | 'task-deleted'
  | 'overlap-unknown'
  | 'user-changed-after-task'

export interface TaskChangePath {
  path: string
  attribution: TaskChangeAttribution
  omitted?: 'too-large' | 'binary' | 'limit' | 'untracked' | 'truncated'
  contentHash?: string
}

export interface TaskChangeSet {
  taskId: string
  environmentId: string
  baselineStatus: TaskChangeBaselineStatus
  invalidReason?: TaskChangeBaseline['invalidReason']
  gitPresence: ProjectGitPresence['kind']
  baseCommit?: string
  generatedAt: string
  paths: TaskChangePath[]
  truncated?: true
  /** Task 4 才会给出可执行撤销；Task 2 一律不可一键撤销。 */
  revertible: false | { kind: 'none'; reason: string }
}

export type TurnCheckpointStatus = 'complete' | 'incomplete' | 'no-change'

export interface TurnChangeCheckpoint {
  schemaVersion: 1
  taskId: string
  turnId: string
  environmentId: string
  previousCheckpointId?: string
  capturedBeforeAt: string
  capturedAfterAt?: string
  status: TurnCheckpointStatus
  drift?: 'external' | 'baseline-invalid' | 'environment-mismatch'
  beforePaths: TaskChangePathSnapshot[]
  afterPaths?: TaskChangePathSnapshot[]
  affectedPaths: string[]
  attributionSummary?: Partial<Record<TaskChangeAttribution, number>>
}

export type FileDiffStatus =
  'ok' | 'truncated' | 'binary' | 'untracked' | 'missing' | 'too-large' | 'escaped' | 'unavailable'

export interface FileDiffResult {
  taskId: string
  path: string
  status: FileDiffStatus
  unifiedDiff?: string
  truncated?: true
}

export interface TaskChangeSetSummary {
  taskId: string
  environmentId: string
  baselineStatus: TaskChangeBaselineStatus
  invalidReason?: TaskChangeBaseline['invalidReason']
  gitPresence: ProjectGitPresence['kind']
  baseCommit?: string
  preExistingCount: number
  taskChangedCount: number
  unknownCount: number
  validations: ValidationResult[]
}

/**
 * IPC 返回的变更审阅视图。路径必须是 execution root 相对 posix 路径，
 * 不得夹带绝对路径、fingerprint 或完整 porcelain。
 */
export type TaskChangeSetQueryResult = TaskChangeSetSummary &
  Pick<TaskChangeSet, 'generatedAt' | 'paths' | 'truncated' | 'revertible'>

const TASK_CHANGE_ATTRIBUTIONS: readonly TaskChangeAttribution[] = [
  'pre-existing',
  'task-added',
  'task-modified',
  'task-deleted',
  'overlap-unknown',
  'user-changed-after-task'
]

const FILE_DIFF_STATUSES: readonly FileDiffStatus[] = [
  'ok',
  'truncated',
  'binary',
  'untracked',
  'missing',
  'too-large',
  'escaped',
  'unavailable'
]

const TURN_CHECKPOINT_STATUSES: readonly TurnCheckpointStatus[] = [
  'complete',
  'incomplete',
  'no-change'
]

const PATH_OMISSIONS = ['too-large', 'binary', 'limit', 'untracked', 'truncated'] as const
const SNAPSHOT_OMISSIONS = ['too-large', 'binary', 'limit'] as const
const MAX_REVIEW_PATH_BYTES = 4 * 1024
const MAX_UNIFIED_DIFF_BYTES = 64 * 1024
const MAX_CHANGE_SET_PATHS = 500
const MAX_CHECKPOINT_PATHS = 500
const MAX_REASON_BYTES = 4 * 1024

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasParentTraversal(value: string): boolean {
  return value.split(/[\\/]+/u).some((segment) => segment === '..')
}

function looksLikeAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value)
}

/**
 * Renderer 可见路径必须是相对 posix 路径。绝对路径、`..`、反斜杠和 NUL 一律丢弃。
 */
export function isSafeRelativePosixPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return false
  if (utf8Bytes(value) > MAX_REVIEW_PATH_BYTES) return false
  if (value.includes('\\') || looksLikeAbsolutePath(value) || hasParentTraversal(value))
    return false
  return true
}

function isStoreIdentity(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return false
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') return false
  return utf8Bytes(value) <= MAX_REVIEW_PATH_BYTES
}

function isAttribution(value: unknown): value is TaskChangeAttribution {
  return (
    typeof value === 'string' && (TASK_CHANGE_ATTRIBUTIONS as readonly string[]).includes(value)
  )
}

function parseTaskChangePath(value: unknown): TaskChangePath | null {
  if (
    !isPlainRecord(value) ||
    !isSafeRelativePosixPath(value.path) ||
    !isAttribution(value.attribution)
  ) {
    return null
  }
  const path: TaskChangePath = { path: value.path, attribution: value.attribution }
  if (typeof value.contentHash === 'string' && /^[0-9a-f]{32,128}$/i.test(value.contentHash)) {
    path.contentHash = value.contentHash.toLowerCase()
  }
  if (
    typeof value.omitted === 'string' &&
    (PATH_OMISSIONS as readonly string[]).includes(value.omitted)
  ) {
    path.omitted = value.omitted as TaskChangePath['omitted']
  }
  return path
}

function parsePathSnapshot(value: unknown): TaskChangePathSnapshot | null {
  if (!isPlainRecord(value) || !isSafeRelativePosixPath(value.path)) return null
  if (value.kind !== 'tracked' && value.kind !== 'untracked') return null
  const snapshot: TaskChangePathSnapshot = { path: value.path, kind: value.kind }
  if (typeof value.statusCode === 'string' && utf8Bytes(value.statusCode) <= 8) {
    snapshot.statusCode = value.statusCode
  }
  if (typeof value.contentHash === 'string' && /^[0-9a-f]{32,128}$/i.test(value.contentHash)) {
    snapshot.contentHash = value.contentHash.toLowerCase()
  }
  if (
    typeof value.omitted === 'string' &&
    (SNAPSHOT_OMISSIONS as readonly string[]).includes(value.omitted)
  ) {
    snapshot.omitted = value.omitted as TaskChangePathSnapshot['omitted']
  }
  return snapshot
}

function parseGitPresenceKind(value: unknown): ProjectGitPresence['kind'] | null {
  if (value === 'git' || value === 'non-git' || value === 'invalid') return value
  return null
}

function parseBaselineStatus(value: unknown): TaskChangeBaselineStatus | null {
  if (value === 'captured' || value === 'invalid' || value === 'unavailable') return value
  return null
}

function parseInvalidReason(value: unknown): TaskChangeBaseline['invalidReason'] | undefined {
  if (
    value === 'git-root-changed' ||
    value === 'head-changed' ||
    value === 'path-replaced' ||
    value === 'root-missing' ||
    value === 'project-unavailable' ||
    value === 'nested-changed'
  ) {
    return value
  }
  return undefined
}

function parseRevertible(value: unknown): TaskChangeSet['revertible'] | null {
  if (value === false) return false
  if (!isPlainRecord(value) || value.kind !== 'none' || typeof value.reason !== 'string')
    return null
  if (
    !value.reason.trim() ||
    value.reason.includes('\0') ||
    utf8Bytes(value.reason) > MAX_REASON_BYTES
  ) {
    return null
  }
  if (looksLikeAbsolutePath(value.reason))
    return { kind: 'none', reason: '当前版本不提供一键撤销。' }
  return { kind: 'none', reason: value.reason }
}

/**
 * 投影 IPC 变更列表。丢弃 fingerprint、绝对路径、porcelain 和未知字段。
 */
export function parseTaskChangeSetQueryResult(value: unknown): TaskChangeSetQueryResult | null {
  if (!isPlainRecord(value)) return null
  if (!isStoreIdentity(value.taskId) || !isStoreIdentity(value.environmentId)) return null
  const gitPresence = parseGitPresenceKind(value.gitPresence)
  const baselineStatus = parseBaselineStatus(value.baselineStatus)
  if (!gitPresence || !baselineStatus) return null
  if (typeof value.generatedAt !== 'string' || !value.generatedAt.trim()) return null
  if (!Number.isSafeInteger(value.preExistingCount) || Number(value.preExistingCount) < 0)
    return null
  if (!Number.isSafeInteger(value.taskChangedCount) || Number(value.taskChangedCount) < 0)
    return null
  if (!Number.isSafeInteger(value.unknownCount) || Number(value.unknownCount) < 0) return null
  if (!Array.isArray(value.paths) || value.paths.length > MAX_CHANGE_SET_PATHS) return null
  if (!Array.isArray(value.validations)) return null

  const paths: TaskChangePath[] = []
  for (const item of value.paths) {
    const parsed = parseTaskChangePath(item)
    if (!parsed) return null
    paths.push(parsed)
  }
  const validations: ValidationResult[] = []
  for (const item of value.validations) {
    const parsed = parseValidationResult(item)
    if (!parsed || parsed.taskId !== value.taskId) return null
    validations.push(parsed)
  }

  const revertible = parseRevertible(value.revertible)
  if (revertible === null) return null

  const result: TaskChangeSetQueryResult = {
    taskId: value.taskId,
    environmentId: value.environmentId,
    baselineStatus,
    gitPresence,
    generatedAt: value.generatedAt,
    preExistingCount: Number(value.preExistingCount),
    taskChangedCount: Number(value.taskChangedCount),
    unknownCount: Number(value.unknownCount),
    validations,
    paths,
    revertible
  }
  const invalidReason = parseInvalidReason(value.invalidReason)
  if (invalidReason) result.invalidReason = invalidReason
  if (typeof value.baseCommit === 'string' && /^[0-9a-f]{4,64}$/i.test(value.baseCommit)) {
    result.baseCommit = value.baseCommit.toLowerCase()
  }
  if (value.truncated === true) result.truncated = true
  return result
}

/**
 * 投影单文件 Diff。绝对路径或越界 path 直接拒绝，避免 Preload 把仓库外内容交给 Renderer。
 */
export function parseFileDiffResult(value: unknown): FileDiffResult | null {
  if (!isPlainRecord(value) || !isStoreIdentity(value.taskId)) return null
  if (typeof value.path !== 'string' || value.path.includes('\0')) return null
  if (looksLikeAbsolutePath(value.path) || value.path.includes('\\')) return null
  if (utf8Bytes(value.path) > MAX_REVIEW_PATH_BYTES) return null
  if (
    typeof value.status !== 'string' ||
    !(FILE_DIFF_STATUSES as readonly string[]).includes(value.status)
  ) {
    return null
  }
  // escaped 允许原样回显含 `..` 的相对请求，其它状态必须是安全相对路径。
  if (value.status !== 'escaped' && !isSafeRelativePosixPath(value.path) && value.path !== '') {
    return null
  }
  const result: FileDiffResult = {
    taskId: value.taskId,
    path: value.path,
    status: value.status as FileDiffStatus
  }
  if (typeof value.unifiedDiff === 'string') {
    if (value.unifiedDiff.includes('\0') || utf8Bytes(value.unifiedDiff) > MAX_UNIFIED_DIFF_BYTES) {
      return null
    }
    if (
      looksLikeAbsolutePath(value.unifiedDiff) ||
      /(?:^|\n)\/(?:Users|home|tmp)\//u.test(value.unifiedDiff)
    ) {
      return null
    }
    result.unifiedDiff = value.unifiedDiff
  }
  if (value.truncated === true) result.truncated = true
  return result
}

/**
 * 投影 Turn 检查点。before/after 只保留相对路径快照，丢弃 fingerprint 与绝对根。
 */
export function parseTurnChangeCheckpoint(value: unknown): TurnChangeCheckpoint | null {
  if (!isPlainRecord(value) || value.schemaVersion !== 1) return null
  if (!isStoreIdentity(value.taskId) || !isStoreIdentity(value.turnId)) return null
  if (!isStoreIdentity(value.environmentId)) return null
  if (typeof value.capturedBeforeAt !== 'string' || !value.capturedBeforeAt.trim()) return null
  if (
    typeof value.status !== 'string' ||
    !(TURN_CHECKPOINT_STATUSES as readonly string[]).includes(value.status)
  ) {
    return null
  }
  if (!Array.isArray(value.beforePaths) || value.beforePaths.length > MAX_CHECKPOINT_PATHS)
    return null
  if (!Array.isArray(value.affectedPaths) || value.affectedPaths.length > MAX_CHECKPOINT_PATHS) {
    return null
  }

  const beforePaths: TaskChangePathSnapshot[] = []
  for (const item of value.beforePaths) {
    const parsed = parsePathSnapshot(item)
    if (!parsed) return null
    beforePaths.push(parsed)
  }
  const affectedPaths: string[] = []
  for (const item of value.affectedPaths) {
    if (!isSafeRelativePosixPath(item)) return null
    affectedPaths.push(item)
  }

  const checkpoint: TurnChangeCheckpoint = {
    schemaVersion: 1,
    taskId: value.taskId,
    turnId: value.turnId,
    environmentId: value.environmentId,
    capturedBeforeAt: value.capturedBeforeAt,
    status: value.status as TurnCheckpointStatus,
    beforePaths,
    affectedPaths
  }
  if (
    typeof value.previousCheckpointId === 'string' &&
    isStoreIdentity(value.previousCheckpointId)
  ) {
    checkpoint.previousCheckpointId = value.previousCheckpointId
  }
  if (typeof value.capturedAfterAt === 'string' && value.capturedAfterAt.trim()) {
    checkpoint.capturedAfterAt = value.capturedAfterAt
  }
  if (
    value.drift === 'external' ||
    value.drift === 'baseline-invalid' ||
    value.drift === 'environment-mismatch'
  ) {
    checkpoint.drift = value.drift
  }
  if (value.afterPaths !== undefined) {
    if (!Array.isArray(value.afterPaths) || value.afterPaths.length > MAX_CHECKPOINT_PATHS)
      return null
    const afterPaths: TaskChangePathSnapshot[] = []
    for (const item of value.afterPaths) {
      const parsed = parsePathSnapshot(item)
      if (!parsed) return null
      afterPaths.push(parsed)
    }
    checkpoint.afterPaths = afterPaths
  }
  if (value.attributionSummary !== undefined && value.attributionSummary !== null) {
    if (!isPlainRecord(value.attributionSummary)) return null
    const summary: Partial<Record<TaskChangeAttribution, number>> = {}
    for (const [key, count] of Object.entries(value.attributionSummary)) {
      if (!isAttribution(key) || !Number.isSafeInteger(count) || Number(count) < 0) return null
      summary[key] = Number(count)
    }
    checkpoint.attributionSummary = summary
  }
  return checkpoint
}

const MAX_CHECKPOINT_LIST_ITEMS = 100

/** 检查点列表投影。任一条非法则整份拒绝，避免夹带绝对路径条目。 */
export function parseTurnChangeCheckpointList(value: unknown): TurnChangeCheckpoint[] | null {
  if (!Array.isArray(value) || value.length > MAX_CHECKPOINT_LIST_ITEMS) return null
  const items: TurnChangeCheckpoint[] = []
  for (const item of value) {
    const parsed = parseTurnChangeCheckpoint(item)
    if (!parsed) return null
    items.push(parsed)
  }
  return items
}
