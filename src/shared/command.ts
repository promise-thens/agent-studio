/** 命令执行来源。user-terminal 仅预留身份，本阶段不实现 PTY 执行器。 */
export const COMMAND_EXECUTION_SOURCES = ['app-runner', 'runtime-tool', 'user-terminal'] as const
export type CommandExecutionSource = (typeof COMMAND_EXECUTION_SOURCES)[number]

/**
 * 证据可信度。app-enforced 只允许 App 自己执行的命令；
 * Runtime 上报不得伪装成 App 沙箱或 Broker 强制结果。
 */
export const COMMAND_TRUST_LEVELS = ['app-enforced', 'runtime-reported', 'unverified'] as const
export type CommandTrustLevel = (typeof COMMAND_TRUST_LEVELS)[number]

/**
 * 命令显式终态。未知退出、仅标题、超时、取消和启动失败都必须落在这些值上，
 * 禁止根据工具标题猜测成功。
 */
export const COMMAND_EXECUTION_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'timed-out',
  'cancelled',
  'start-failed',
  'unknown-exit',
  'title-only'
] as const
export type CommandExecutionStatus = (typeof COMMAND_EXECUTION_STATUSES)[number]

export const COMMAND_TRANSCRIPT_ENCODINGS = ['utf-8'] as const
export type CommandTranscriptEncoding = (typeof COMMAND_TRANSCRIPT_ENCODINGS)[number]

export const COMMAND_TRANSCRIPT_RETENTION_POLICIES = ['bounded', 'ephemeral'] as const
export type CommandTranscriptRetentionPolicy =
  (typeof COMMAND_TRANSCRIPT_RETENTION_POLICIES)[number]

/** 应用重启后必须能区分仍在、已过期、应收但找不到。 */
export const COMMAND_TRANSCRIPT_RETENTION_STATES = ['retained', 'expired', 'missing'] as const
export type CommandTranscriptRetentionState = (typeof COMMAND_TRANSCRIPT_RETENTION_STATES)[number]

export const VALIDATION_OUTCOMES = ['pass', 'fail', 'unknown'] as const
export type ValidationOutcome = (typeof VALIDATION_OUTCOMES)[number]

export const VALIDATION_OUTCOME_REASONS = [
  'non-zero-exit',
  'timed-out',
  'cancelled',
  'start-failed',
  'failed-status',
  'missing-exit-code',
  'unknown-status',
  'incomplete-list'
] as const
export type ValidationOutcomeReason = (typeof VALIDATION_OUTCOME_REASONS)[number]

/**
 * Runtime 标题/ACP status 与结构化退出事实冲突时的显式标记。
 * 不得根据标题把 status 改写成 succeeded。
 */
export const COMMAND_EVIDENCE_INCONSISTENCIES = [
  'title-success-nonzero-exit',
  'title-success-timed-out',
  'title-failure-zero-exit'
] as const
export type CommandEvidenceInconsistency = (typeof COMMAND_EVIDENCE_INCONSISTENCIES)[number]

/** 单字段 UTF-8 上限，避免异常长命令或身份进入 IPC。 */
export const MAX_COMMAND_FIELD_UTF8_BYTES = 4 * 1024

/** 单次验证最多引用的 commandId 数，防止结果对象膨胀。 */
export const MAX_VALIDATION_COMMAND_IDS = 32

const textEncoder = new TextEncoder()

/**
 * Renderer 只拿 transcript 身份与容量事实，禁止夹带任意文件系统路径。
 */
export interface CommandTranscriptRef {
  transcriptId: string
  availableBytes: number
  totalBytes?: number
  truncated: boolean
  encoding: CommandTranscriptEncoding
  retentionPolicy: CommandTranscriptRetentionPolicy
  retentionState: CommandTranscriptRetentionState
}

/** 单次 list 最多返回的证据条数，防止把整个 Task 的命令摘要一次打满 IPC。 */
export const MAX_COMMAND_EVIDENCE_LIST_ITEMS = 128

/** transcript chunk 分页：Renderer 只拿窗口，不能指定文件路径。 */
export const MAX_COMMAND_TRANSCRIPT_PAGE_LIMIT = 64
export const DEFAULT_COMMAND_TRANSCRIPT_PAGE_LIMIT = 32

export const COMMAND_TRANSCRIPT_STREAMS = ['stdout', 'stderr'] as const
export type CommandTranscriptStream = (typeof COMMAND_TRANSCRIPT_STREAMS)[number]

/** 有界 transcript 片段。禁止夹带 path。 */
export interface CommandTranscriptChunkView {
  stream: CommandTranscriptStream
  text: string
}

/**
 * 按 commandId 查询的 transcript 窗口。缺失文件时 retentionState 为 missing/expired，
 * 不得回传文件系统路径。
 */
export interface CommandTranscriptPage {
  taskId: string
  commandId: string
  transcriptId: string
  offset: number
  limit: number
  nextOffset?: number
  truncated: boolean
  retentionState: CommandTranscriptRetentionState
  chunks: CommandTranscriptChunkView[]
}

/**
 * 一次命令执行的可审阅事实。cwd 只记录相对 execution root 的路径，
 * 绝对根目录不得出现在共享契约里。
 */
export interface CommandExecutionEvidence {
  commandId: string
  taskId: string
  turnId: string
  environmentId: string
  source: CommandExecutionSource
  displayCommand: string
  cwd: string
  startedAt: string
  endedAt?: string
  exitCode?: number
  signal?: string
  timedOut: boolean
  status: CommandExecutionStatus
  transcriptRef: CommandTranscriptRef
  truncated: boolean
  trustLevel: CommandTrustLevel
  /** Runtime 工具身份；禁止放文件系统路径。 */
  toolCallId?: string
  /** 仅在确实见过 ACP permission request 时记录，禁止伪造 Broker 授权。 */
  approvalId?: string
  /** 标题/ACP status 与 exit/timeout 冲突；结构化事实仍是 source of truth。 */
  inconsistency?: CommandEvidenceInconsistency
  /** Runtime 声明了 output_file 但 App 未摄入文件内容。 */
  outputFileNotIngested?: true
}

/** 只读证据列表。truncated 表示达到条数上限后还有未返回项。 */
export interface CommandEvidencePage {
  items: CommandExecutionEvidence[]
  truncated?: true
  /** 终态落盘失败留下的缺口；有此标记时验证不得 pass。 */
  persistIncomplete?: true
}

/**
 * 验证结论必须引用真实 commandId。聊天文本和工具标题不能作为通过证据。
 */
export interface ValidationResult {
  validationId: string
  taskId: string
  turnId: string
  commandIds: string[]
  outcome: ValidationOutcome
  reason?: ValidationOutcomeReason
}

export function isCommandExecutionSource(value: unknown): value is CommandExecutionSource {
  return (
    typeof value === 'string' && (COMMAND_EXECUTION_SOURCES as readonly string[]).includes(value)
  )
}

export function isCommandTrustLevel(value: unknown): value is CommandTrustLevel {
  return typeof value === 'string' && (COMMAND_TRUST_LEVELS as readonly string[]).includes(value)
}

export function isCommandEvidenceInconsistency(
  value: unknown
): value is CommandEvidenceInconsistency {
  return (
    typeof value === 'string' &&
    (COMMAND_EVIDENCE_INCONSISTENCIES as readonly string[]).includes(value)
  )
}

export function isCommandExecutionStatus(value: unknown): value is CommandExecutionStatus {
  return (
    typeof value === 'string' && (COMMAND_EXECUTION_STATUSES as readonly string[]).includes(value)
  )
}

/**
 * 将未知 IPC/JSON 投影为 transcript 引用。路径字段一律丢弃；身份非法则整份拒绝。
 */
export function parseCommandTranscriptRef(value: unknown): CommandTranscriptRef | null {
  if (!isPlainRecord(value)) return null
  if (!isBoundedIdentifier(value.transcriptId)) return null
  if (!isNonNegativeSafeInteger(value.availableBytes)) return null
  if (typeof value.truncated !== 'boolean') return null
  if (value.encoding !== 'utf-8') return null
  if (
    typeof value.retentionPolicy !== 'string' ||
    !(COMMAND_TRANSCRIPT_RETENTION_POLICIES as readonly string[]).includes(value.retentionPolicy)
  ) {
    return null
  }
  if (
    typeof value.retentionState !== 'string' ||
    !(COMMAND_TRANSCRIPT_RETENTION_STATES as readonly string[]).includes(value.retentionState)
  ) {
    return null
  }

  const ref: CommandTranscriptRef = {
    transcriptId: value.transcriptId,
    availableBytes: value.availableBytes,
    truncated: value.truncated,
    encoding: 'utf-8',
    retentionPolicy: value.retentionPolicy as CommandTranscriptRetentionPolicy,
    retentionState: value.retentionState as CommandTranscriptRetentionState
  }

  if (value.totalBytes !== undefined && value.totalBytes !== null) {
    if (!isNonNegativeSafeInteger(value.totalBytes) || value.totalBytes < value.availableBytes) {
      return null
    }
    ref.totalBytes = value.totalBytes
  }

  return ref
}

/**
 * 将未知 IPC 载荷投影为 transcript 分页。路径字段一律丢弃；身份非法则整份拒绝。
 */
export function parseCommandTranscriptPage(value: unknown): CommandTranscriptPage | null {
  if (!isPlainRecord(value)) return null
  if (!isBoundedIdentifier(value.taskId)) return null
  if (!isBoundedIdentifier(value.commandId)) return null
  if (!isBoundedIdentifier(value.transcriptId)) return null
  if (!isNonNegativeSafeInteger(value.offset)) return null
  if (!isPositiveSafeInteger(value.limit) || value.limit > MAX_COMMAND_TRANSCRIPT_PAGE_LIMIT) {
    return null
  }
  if (typeof value.truncated !== 'boolean') return null
  if (
    typeof value.retentionState !== 'string' ||
    !(COMMAND_TRANSCRIPT_RETENTION_STATES as readonly string[]).includes(value.retentionState)
  ) {
    return null
  }
  if (!Array.isArray(value.chunks) || value.chunks.length > MAX_COMMAND_TRANSCRIPT_PAGE_LIMIT) {
    return null
  }

  const chunks: CommandTranscriptChunkView[] = []
  for (const item of value.chunks) {
    const chunk = parseCommandTranscriptChunkView(item)
    if (!chunk) return null
    chunks.push(chunk)
  }

  const page: CommandTranscriptPage = {
    taskId: value.taskId,
    commandId: value.commandId,
    transcriptId: value.transcriptId,
    offset: value.offset,
    limit: value.limit,
    truncated: value.truncated,
    retentionState: value.retentionState as CommandTranscriptRetentionState,
    chunks
  }
  if (value.nextOffset !== undefined && value.nextOffset !== null) {
    if (!isNonNegativeSafeInteger(value.nextOffset) || value.nextOffset <= value.offset) {
      return null
    }
    page.nextOffset = value.nextOffset
  }
  return page
}

function parseCommandTranscriptChunkView(value: unknown): CommandTranscriptChunkView | null {
  if (!isPlainRecord(value)) return null
  if (value.stream !== 'stdout' && value.stream !== 'stderr') return null
  if (typeof value.text !== 'string' || value.text.includes('\0')) return null
  if (utf8ByteLength(value.text) > MAX_COMMAND_FIELD_UTF8_BYTES * 64) return null
  return { stream: value.stream, text: value.text }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * 将未知对象投影为命令证据。结构或安全边界失败返回 null，不猜测成功。
 */
export function parseCommandExecutionEvidence(value: unknown): CommandExecutionEvidence | null {
  if (!isPlainRecord(value)) return null
  if (!isBoundedIdentifier(value.commandId)) return null
  if (!isBoundedIdentifier(value.taskId)) return null
  if (!isBoundedIdentifier(value.turnId)) return null
  if (!isBoundedIdentifier(value.environmentId)) return null
  if (!isCommandExecutionSource(value.source)) return null
  if (!isCommandTrustLevel(value.trustLevel)) return null
  if (!isTrustCompatible(value.source, value.trustLevel)) return null
  if (!isDisplayCommand(value.displayCommand)) return null
  if (!isRelativeCwd(value.cwd)) return null
  if (!isIsoTimestamp(value.startedAt)) return null
  if (typeof value.timedOut !== 'boolean') return null
  if (typeof value.truncated !== 'boolean') return null
  if (!isCommandExecutionStatus(value.status)) return null

  const transcriptRef = parseCommandTranscriptRef(value.transcriptRef)
  if (!transcriptRef) return null

  const evidence: CommandExecutionEvidence = {
    commandId: value.commandId,
    taskId: value.taskId,
    turnId: value.turnId,
    environmentId: value.environmentId,
    source: value.source,
    displayCommand: value.displayCommand,
    cwd: value.cwd,
    startedAt: value.startedAt,
    timedOut: value.timedOut,
    status: value.status,
    transcriptRef,
    truncated: value.truncated,
    trustLevel: value.trustLevel
  }

  if (value.endedAt !== undefined && value.endedAt !== null) {
    if (!isIsoTimestamp(value.endedAt)) return null
    evidence.endedAt = value.endedAt
  }

  if (value.exitCode !== undefined && value.exitCode !== null) {
    if (typeof value.exitCode !== 'number' || !Number.isSafeInteger(value.exitCode)) return null
    evidence.exitCode = value.exitCode
  }

  if (value.signal !== undefined && value.signal !== null) {
    if (!isCommandSignal(value.signal)) return null
    evidence.signal = value.signal
  }

  if (value.toolCallId !== undefined && value.toolCallId !== null) {
    if (!isOptionalEvidenceIdentity(value.toolCallId)) return null
    evidence.toolCallId = value.toolCallId
  }

  if (value.approvalId !== undefined && value.approvalId !== null) {
    if (!isOptionalEvidenceIdentity(value.approvalId)) return null
    evidence.approvalId = value.approvalId
  }

  if (value.inconsistency !== undefined && value.inconsistency !== null) {
    if (!isCommandEvidenceInconsistency(value.inconsistency)) return null
    evidence.inconsistency = value.inconsistency
  }

  if (value.outputFileNotIngested !== undefined && value.outputFileNotIngested !== null) {
    if (value.outputFileNotIngested !== true) return null
    evidence.outputFileNotIngested = true
  }

  // Timeline 可能直接展示 status；缺退出码或超时不得伪装成 succeeded。
  if (!isStatusConsistentWithFacts(evidence.status, evidence.timedOut, evidence.exitCode)) {
    return null
  }

  return evidence
}

/**
 * 列表截断或落盘缺口时，验证不得在不完整窗口上 pass。
 * 单条输出 truncated 仍不单独阻断 pass。
 */
export interface DeriveValidationOptions {
  listIncomplete?: boolean
}

/**
 * 只根据命令证据生成验证结论。聊天文本、工具标题不是参数，因此不能单独产生 pass。
 * fail 优先于 unknown；列表不完整时禁止 pass。
 */
export function deriveValidationResult(
  evidences: CommandExecutionEvidence[],
  validationId: string,
  options?: DeriveValidationOptions
): ValidationResult | null {
  if (!isBoundedIdentifier(validationId)) return null
  if (!Array.isArray(evidences) || evidences.length === 0) return null
  if (evidences.length > MAX_VALIDATION_COMMAND_IDS) return null

  const first = evidences[0]
  if (!first) return null

  const commandIds: string[] = []
  const seen = new Set<string>()
  let outcome: ValidationOutcome = 'pass'
  let reason: ValidationOutcomeReason | undefined

  for (const evidence of evidences) {
    if (evidence.taskId !== first.taskId || evidence.turnId !== first.turnId) return null
    if (!seen.has(evidence.commandId)) {
      seen.add(evidence.commandId)
      commandIds.push(evidence.commandId)
    }

    const classified = classifyCommandEvidence(evidence)
    if (classified.outcome === 'fail') {
      if (outcome !== 'fail') {
        outcome = 'fail'
        reason = classified.reason
      }
    } else if (classified.outcome === 'unknown' && outcome === 'pass') {
      outcome = 'unknown'
      reason = classified.reason
    }
  }

  if (commandIds.length === 0) return null

  // 列表被截断或落盘缺口时，可见成功项不能代表整轮结果。
  if (options?.listIncomplete && outcome === 'pass') {
    outcome = 'unknown'
    reason = 'incomplete-list'
  }

  const result: ValidationResult = {
    validationId,
    taskId: first.taskId,
    turnId: first.turnId,
    commandIds,
    outcome
  }
  if (outcome !== 'pass' && reason) result.reason = reason
  return result
}

/**
 * 只保留最新 N 条。升序列表若 slice(0, N) 会丢掉最近失败，让审阅假通过。
 */
export function takeLatestCommandEvidencePage(
  items: CommandExecutionEvidence[]
): CommandEvidencePage {
  if (!Array.isArray(items) || items.length <= MAX_COMMAND_EVIDENCE_LIST_ITEMS) {
    return { items: Array.isArray(items) ? items : [] }
  }
  return {
    items: items.slice(-MAX_COMMAND_EVIDENCE_LIST_ITEMS),
    truncated: true
  }
}

/**
 * Preload / IPC 入口：只保留可追溯的验证字段，丢弃聊天文案。
 */
export function parseValidationResult(value: unknown): ValidationResult | null {
  if (!isPlainRecord(value)) return null
  if (!isBoundedIdentifier(value.validationId)) return null
  if (!isBoundedIdentifier(value.taskId)) return null
  if (!isBoundedIdentifier(value.turnId)) return null
  if (!Array.isArray(value.commandIds) || value.commandIds.length === 0) return null
  if (value.commandIds.length > MAX_VALIDATION_COMMAND_IDS) return null
  if (
    typeof value.outcome !== 'string' ||
    !(VALIDATION_OUTCOMES as readonly string[]).includes(value.outcome)
  ) {
    return null
  }

  const commandIds: string[] = []
  const seen = new Set<string>()
  for (const commandId of value.commandIds) {
    if (!isBoundedIdentifier(commandId) || seen.has(commandId)) return null
    seen.add(commandId)
    commandIds.push(commandId)
  }

  const result: ValidationResult = {
    validationId: value.validationId,
    taskId: value.taskId,
    turnId: value.turnId,
    commandIds,
    outcome: value.outcome as ValidationOutcome
  }

  if (
    result.outcome !== 'pass' &&
    typeof value.reason === 'string' &&
    (VALIDATION_OUTCOME_REASONS as readonly string[]).includes(value.reason)
  ) {
    result.reason = value.reason as ValidationOutcomeReason
  }

  return result
}

function classifyCommandEvidence(evidence: CommandExecutionEvidence): {
  outcome: ValidationOutcome
  reason?: ValidationOutcomeReason
} {
  if (evidence.timedOut || evidence.status === 'timed-out') {
    return { outcome: 'fail', reason: 'timed-out' }
  }
  if (evidence.status === 'cancelled') {
    return { outcome: 'fail', reason: 'cancelled' }
  }
  if (evidence.status === 'start-failed') {
    return { outcome: 'fail', reason: 'start-failed' }
  }
  if (typeof evidence.exitCode === 'number' && evidence.exitCode !== 0) {
    return { outcome: 'fail', reason: 'non-zero-exit' }
  }
  if (evidence.status === 'failed') {
    return { outcome: 'fail', reason: 'failed-status' }
  }
  if (evidence.status === 'succeeded' && evidence.exitCode === 0 && evidence.timedOut === false) {
    return { outcome: 'pass' }
  }
  if (typeof evidence.exitCode !== 'number') {
    return { outcome: 'unknown', reason: 'missing-exit-code' }
  }
  return { outcome: 'unknown', reason: 'unknown-status' }
}

/**
 * status 必须能被退出码/超时事实支撑，避免未知退出被展示成成功。
 */
function isStatusConsistentWithFacts(
  status: CommandExecutionStatus,
  timedOut: boolean,
  exitCode: number | undefined
): boolean {
  if (status === 'succeeded') return exitCode === 0 && timedOut === false
  if (status === 'unknown-exit' || status === 'title-only') return exitCode === undefined
  if (status === 'timed-out') return timedOut === true
  return true
}

/**
 * App 强制执行不能套到 Runtime/用户终端来源上，避免审阅时误判沙箱边界。
 */
function isTrustCompatible(source: CommandExecutionSource, trustLevel: CommandTrustLevel): boolean {
  if (source === 'user-terminal') return trustLevel === 'unverified'
  if (trustLevel === 'app-enforced') return source === 'app-runner'
  if (trustLevel === 'runtime-reported') return source === 'runtime-tool'
  return true
}

/** cwd 只接受 posix 相对路径，`.` 表示 execution root。 */
function isRelativeCwd(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false
  if (utf8ByteLength(value) > MAX_COMMAND_FIELD_UTF8_BYTES) return false
  if (value.includes('\\') || value.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(value)) return false
  if (value === '.') return true
  const segments = value.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function isDisplayCommand(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    utf8ByteLength(value) <= MAX_COMMAND_FIELD_UTF8_BYTES
  )
}

function isCommandSignal(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    utf8ByteLength(value) <= 32
  )
}

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    !value.includes('\0') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    utf8ByteLength(value) <= MAX_COMMAND_FIELD_UTF8_BYTES
  )
}

/** 可选关联身份额外拒绝 `.` / `..`，避免被当成路径片段。 */
function isOptionalEvidenceIdentity(value: unknown): value is string {
  return isBoundedIdentifier(value) && value !== '.' && value !== '..'
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength
}
