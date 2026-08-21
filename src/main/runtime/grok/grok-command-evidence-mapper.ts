import { createHash } from 'node:crypto'
import type * as acp from '@agentclientprotocol/sdk'
import {
  MAX_COMMAND_FIELD_UTF8_BYTES,
  parseCommandExecutionEvidence,
  type CommandEvidenceInconsistency,
  type CommandExecutionEvidence,
  type CommandExecutionStatus,
  type CommandTrustLevel
} from '../../../shared/command'
import {
  MAX_COMMAND_TRANSCRIPT_BYTES,
  type CommandTranscriptChunk
} from '../../command/command-evidence-store'
import { redactSensitiveText } from '../../security/sensitive-redaction'

/**
 * 当前冻结的 Grok execute 上报字段。ACP SDK 把 rawInput/rawOutput 标成 unknown；
 * 下列名字来自计划与现有 fixture（`rawInput.command`），不是 SDK 保证。
 * 字段缺失或类型变化必须降级为 unknown，禁止猜测或把未验证对象送进通用证据。
 */
export const GROK_COMMAND_EVIDENCE_FIELD_FREEZE = {
  acpSdk: '@agentclientprotocol/sdk@1.3.0',
  protocolVersion: 1,
  grokCliObserved: 'grok 1.0.5',
  rawInput: ['command'] as const,
  rawOutput: ['exit_code', 'timed_out', 'output', 'output_file'] as const
} as const

const FALLBACK_DISPLAY_COMMAND = 'Runtime 命令'
const textEncoder = new TextEncoder()

export interface GrokCommandToolFacts {
  toolCallId: string
  taskId: string
  turnId: string
  environmentId: string
  kind?: acp.ToolKind | null
  title?: string | null
  status?: acp.ToolCallStatus | null
  rawInput?: unknown
  rawOutput?: unknown
  approvalId?: string
  startedAt: string
  endedAt?: string
}

export interface GrokCommandToolPatch {
  toolCallId: string
  kind?: acp.ToolKind | null
  title?: string | null
  status?: acp.ToolCallStatus | null
  rawInput?: unknown
  rawOutput?: unknown
}

export interface GrokCommandEvidenceIdentity {
  taskId: string
  turnId: string
  environmentId: string
  approvalId?: string
  nowIso: string
}

export interface GrokCommandEvidenceMapping {
  evidence: CommandExecutionEvidence
  chunks: CommandTranscriptChunk[]
}

type TextRedactor = (text: string) => string

interface ParsedGrokCommandRawInput {
  command?: string
}

interface ParsedGrokCommandRawOutput {
  exitCode?: number
  timedOut?: boolean
  output?: string
  outputFilePresent: boolean
}

/**
 * 将 ACP tool_call / tool_call_update 累积为命令事实。
 * 未出现的字段保持旧值；rawInput/rawOutput 一旦出现则整体替换，不与旧对象深合并。
 */
export function accumulateGrokCommandToolFacts(
  previous: GrokCommandToolFacts | undefined,
  patch: GrokCommandToolPatch,
  identity: GrokCommandEvidenceIdentity
): GrokCommandToolFacts {
  const current = previous?.toolCallId === patch.toolCallId ? previous : undefined
  const facts: GrokCommandToolFacts = {
    toolCallId: patch.toolCallId,
    taskId: identity.taskId,
    turnId: identity.turnId,
    environmentId: identity.environmentId,
    startedAt: current?.startedAt ?? identity.nowIso
  }

  const kind = patch.kind !== undefined && patch.kind !== null ? patch.kind : current?.kind
  const title = patch.title !== undefined && patch.title !== null ? patch.title : current?.title
  const status =
    patch.status !== undefined && patch.status !== null ? patch.status : current?.status
  if (kind) facts.kind = kind
  if (title) facts.title = title
  if (status) facts.status = status
  if (patch.rawInput !== undefined) facts.rawInput = patch.rawInput
  else if (current && 'rawInput' in current) facts.rawInput = current.rawInput
  if (patch.rawOutput !== undefined) facts.rawOutput = patch.rawOutput
  else if (current && 'rawOutput' in current) facts.rawOutput = current.rawOutput

  const approvalId = identity.approvalId ?? current?.approvalId
  if (approvalId) facts.approvalId = approvalId
  if (
    isTerminalToolStatus(status) ||
    hasStructuredExit(parseGrokCommandRawOutput(facts.rawOutput))
  ) {
    facts.endedAt = identity.nowIso
  } else if (current?.endedAt) {
    facts.endedAt = current.endedAt
  }
  return facts
}

/**
 * execute 工具，或 rawInput.command 为字符串时才视为命令证据候选。
 * 读/改文件等工具即使带未验证 rawInput 也不能当成命令。
 */
export function isGrokCommandEvidenceCandidate(facts: GrokCommandToolFacts): boolean {
  return facts.kind === 'execute' || parseGrokCommandRawInput(facts.rawInput).command != null
}

/**
 * 命令身份必须能通过 CommandEvidenceStore 单段校验。
 * 优先可读拼接；无法清洗时回退到 task/turn/toolCallId 的 SHA-256。
 */
export function deriveGrokRuntimeCommandId(
  taskId: string,
  turnId: string,
  toolCallId: string
): string {
  const hashed = `rt_${createHash('sha256')
    .update(`${taskId}\0${turnId}\0${toolCallId}`)
    .digest('hex')}`
  const readable = `rt_${sanitizeIdentitySegment(turnId)}_${sanitizeIdentitySegment(toolCallId)}`
  return isStoreSafeIdentity(readable) ? readable : hashed
}

/**
 * 把已冻结的 Grok 命令字段投影为 runtime-tool 证据。
 *
 * 安全边界：
 * - 不得把 rawInput/rawOutput 原对象送进证据或权限目标。
 * - 默认不跟随 output_file；即使路径看起来在 execution root 内也不在本层读盘。
 * - trustLevel 只能是 runtime-reported / unverified，禁止 app-enforced。
 * - 标题成功不能覆盖非零退出或超时。
 */
export function mapGrokCommandEvidence(
  facts: GrokCommandToolFacts,
  redactText: TextRedactor
): GrokCommandEvidenceMapping | null {
  if (!isGrokCommandEvidenceCandidate(facts)) return null
  if (!isStoreSafeIdentity(facts.taskId) || !isStoreSafeIdentity(facts.turnId)) return null
  if (!isStoreSafeIdentity(facts.environmentId)) return null

  const rawInput = parseGrokCommandRawInput(facts.rawInput)
  const rawOutput = parseGrokCommandRawOutput(facts.rawOutput)
  const commandId = deriveGrokRuntimeCommandId(facts.taskId, facts.turnId, facts.toolCallId)
  const transcriptId = `tx_${commandId}`
  if (!isStoreSafeIdentity(commandId) || !isStoreSafeIdentity(transcriptId)) return null

  const displayCommand = resolveDisplayCommand(rawInput.command, facts.title, redactText)
  const {
    chunks,
    availableBytes,
    totalBytes,
    truncated: outputTruncated
  } = mapOutputChunks(rawOutput.output, redactText)
  const truncated = outputTruncated || rawOutput.outputFilePresent
  const timedOut = rawOutput.timedOut === true
  const hasStructuredFields =
    rawInput.command != null || rawOutput.exitCode != null || rawOutput.timedOut != null
  const status = resolveStatus({
    acpStatus: facts.status,
    exitCode: rawOutput.exitCode,
    timedOut,
    hasCommand: rawInput.command != null
  })
  const trustLevel: CommandTrustLevel = hasStructuredFields ? 'runtime-reported' : 'unverified'
  const inconsistency = resolveInconsistency({
    title: facts.title,
    acpStatus: facts.status,
    exitCode: rawOutput.exitCode,
    timedOut
  })

  const evidence: CommandExecutionEvidence = {
    commandId,
    taskId: facts.taskId,
    turnId: facts.turnId,
    environmentId: facts.environmentId,
    source: 'runtime-tool',
    displayCommand,
    cwd: '.',
    startedAt: facts.startedAt,
    timedOut,
    status,
    transcriptRef: {
      transcriptId,
      availableBytes,
      totalBytes,
      truncated,
      encoding: 'utf-8',
      retentionPolicy: 'bounded',
      retentionState: 'retained'
    },
    truncated,
    trustLevel
  }
  if (facts.endedAt) evidence.endedAt = facts.endedAt
  // unknown-exit / title-only 契约禁止携带数值 exitCode。
  if (
    typeof rawOutput.exitCode === 'number' &&
    status !== 'title-only' &&
    status !== 'unknown-exit'
  ) {
    evidence.exitCode = rawOutput.exitCode
  }
  if (isStoreSafeIdentity(facts.toolCallId)) evidence.toolCallId = facts.toolCallId
  if (facts.approvalId && isStoreSafeIdentity(facts.approvalId)) {
    evidence.approvalId = facts.approvalId
  }
  if (inconsistency) evidence.inconsistency = inconsistency
  if (rawOutput.outputFilePresent) evidence.outputFileNotIngested = true

  const parsed = parseCommandExecutionEvidence(evidence)
  if (!parsed) return null
  return { evidence: parsed, chunks }
}

function parseGrokCommandRawInput(value: unknown): ParsedGrokCommandRawInput {
  if (!isPlainRecord(value)) return {}
  if (
    typeof value.command !== 'string' ||
    value.command.includes('\0') ||
    value.command.length === 0
  ) {
    return {}
  }
  return { command: value.command }
}

/**
 * 只读取冻结字段。output_file 无论相对还是绝对都只记“存在”，默认不 realpath、不读盘。
 */
function parseGrokCommandRawOutput(value: unknown): ParsedGrokCommandRawOutput {
  if (!isPlainRecord(value)) return { outputFilePresent: false }
  const parsed: ParsedGrokCommandRawOutput = {
    outputFilePresent: hasOutputFileDeclaration(value.output_file)
  }
  if (typeof value.exit_code === 'number' && Number.isSafeInteger(value.exit_code)) {
    parsed.exitCode = value.exit_code
  }
  if (typeof value.timed_out === 'boolean') parsed.timedOut = value.timed_out
  if (typeof value.output === 'string' && !value.output.includes('\0')) {
    parsed.output = value.output
  }
  return parsed
}

function hasOutputFileDeclaration(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

function resolveDisplayCommand(
  command: string | undefined,
  title: string | null | undefined,
  redactText: TextRedactor
): string {
  const fromCommand = command ? boundDisplayCommand(redactCommandText(command, redactText)) : ''
  if (fromCommand) return fromCommand
  const fromTitle = title ? boundDisplayCommand(redactCommandText(title, redactText)) : ''
  return fromTitle || FALLBACK_DISPLAY_COMMAND
}

function resolveStatus(input: {
  acpStatus?: acp.ToolCallStatus | null
  exitCode?: number
  timedOut: boolean
  hasCommand: boolean
}): CommandExecutionStatus {
  if (input.timedOut) return 'timed-out'
  if (typeof input.exitCode === 'number') {
    return input.exitCode === 0 ? 'succeeded' : 'failed'
  }
  if (input.acpStatus === 'pending' || input.acpStatus === 'in_progress') return 'running'
  if (input.acpStatus === 'failed') return 'failed'
  if (input.hasCommand) return 'unknown-exit'
  return 'title-only'
}

function resolveInconsistency(input: {
  title?: string | null
  acpStatus?: acp.ToolCallStatus | null
  exitCode?: number
  timedOut: boolean
}): CommandEvidenceInconsistency | undefined {
  const titleSuccess = input.acpStatus === 'completed' || impliesSuccess(input.title)
  const titleFailure = input.acpStatus === 'failed' || impliesFailure(input.title)
  if (titleSuccess && input.timedOut) return 'title-success-timed-out'
  if (titleSuccess && typeof input.exitCode === 'number' && input.exitCode !== 0) {
    return 'title-success-nonzero-exit'
  }
  if (titleFailure && input.exitCode === 0 && input.timedOut === false) {
    return 'title-failure-zero-exit'
  }
  return undefined
}

function impliesSuccess(title: string | null | undefined): boolean {
  if (!title) return false
  return /(?:^|\b)(?:passed|success|succeeded|ok)(?:\b|$)|成功|通过/i.test(title)
}

function impliesFailure(title: string | null | undefined): boolean {
  if (!title) return false
  return /(?:^|\b)(?:fail|failed|error)(?:\b|$)|失败|错误/i.test(title)
}

function mapOutputChunks(
  output: string | undefined,
  redactText: TextRedactor
): {
  chunks: CommandTranscriptChunk[]
  availableBytes: number
  totalBytes: number
  truncated: boolean
} {
  if (output == null || output.length === 0) {
    return { chunks: [], availableBytes: 0, totalBytes: 0, truncated: false }
  }
  const redacted = redactCommandText(output, redactText)
  const totalBytes = utf8ByteLength(redacted)
  if (totalBytes <= MAX_COMMAND_TRANSCRIPT_BYTES) {
    return {
      chunks: [{ stream: 'stdout', text: redacted }],
      availableBytes: totalBytes,
      totalBytes,
      truncated: false
    }
  }
  const text = truncateUtf8(redacted, MAX_COMMAND_TRANSCRIPT_BYTES)
  const availableBytes = utf8ByteLength(text)
  return {
    chunks: text.length > 0 ? [{ stream: 'stdout', text }] : [],
    availableBytes,
    totalBytes,
    truncated: true
  }
}

function redactCommandText(text: string, redactText: TextRedactor): string {
  try {
    return redactText(redactSensitiveText(text))
  } catch {
    return '敏感错误信息已隐藏。'
  }
}

function boundDisplayCommand(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return truncateUtf8(trimmed, MAX_COMMAND_FIELD_UTF8_BYTES)
}

function isTerminalToolStatus(status: acp.ToolCallStatus | null | undefined): boolean {
  return status === 'completed' || status === 'failed'
}

function hasStructuredExit(output: ParsedGrokCommandRawOutput): boolean {
  return output.exitCode != null || output.timedOut === true
}

function sanitizeIdentitySegment(value: string): string {
  return value.replace(/[/\\\0]+/g, '_').replace(/^\.+$/, '')
}

function isStoreSafeIdentity(value: string): boolean {
  return (
    Boolean(value.trim()) &&
    !value.includes('\0') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..' &&
    utf8ByteLength(value) <= MAX_COMMAND_FIELD_UTF8_BYTES
  )
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const encoded = Buffer.from(text, 'utf8')
  if (encoded.byteLength <= maxBytes) return text
  return encoded.subarray(0, maxBytes).toString('utf8')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength
}
