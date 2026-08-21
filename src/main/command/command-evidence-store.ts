import { join } from 'node:path'
import {
  parseCommandExecutionEvidence,
  parseCommandTranscriptRef,
  type CommandExecutionEvidence,
  type CommandTranscriptRef
} from '../../shared/command'
import { AtomicJsonWriter } from '../storage/atomic-json-file'

/**
 * 与 Task 历史单事件 MAX_EVENT_BYTES（256KiB）同量级。
 * 命令输出只持久化有界摘要，避免拖垮 IPC 和磁盘。
 */
export const MAX_COMMAND_TRANSCRIPT_BYTES = 256 * 1024

/** 限制 JSON 数组条目，防止极碎 chunk 把文件本身撑爆。 */
export const MAX_COMMAND_TRANSCRIPT_CHUNKS = 512

const MAX_IDENTIFIER_BYTES = 4 * 1024
const MAX_EVIDENCE_FILE_BYTES = 64 * 1024
const MAX_TRANSCRIPT_FILE_BYTES = 512 * 1024
const EVIDENCE_SCHEMA_VERSION = 1
const TRANSCRIPT_SCHEMA_VERSION = 1
const textEncoder = new TextEncoder()

export interface CommandTranscriptChunk {
  stream: 'stdout' | 'stderr'
  text: string
}

export interface CommandTranscriptWriteInput {
  transcriptId: string
  commandId: string
  taskId: string
  chunks: CommandTranscriptChunk[]
  totalBytes: number
  truncated: boolean
}

export interface CommandTranscriptRecord {
  transcriptId: string
  commandId: string
  taskId: string
  encoding: 'utf-8'
  truncated: boolean
  totalBytes: number
  availableBytes: number
  chunks: CommandTranscriptChunk[]
}

export interface CommandEvidenceStoreOptions {
  /** 注入的存储根；测试传入 tmpdir，生产由组装层注入，不在本模块调用 app.getPath。 */
  rootDir: string
  writer?: AtomicJsonWriter
}

/**
 * 主进程命令证据仓库。Renderer 只拿 CommandTranscriptRef，不得出现文件系统路径。
 */
export class CommandEvidenceStore {
  readonly rootDir: string
  private readonly writer: AtomicJsonWriter

  constructor(options: CommandEvidenceStoreOptions) {
    if (!isNonEmptyPath(options.rootDir)) {
      throw new Error('命令证据存储根无效。')
    }
    this.rootDir = options.rootDir
    this.writer = options.writer ?? new AtomicJsonWriter()
  }

  /** 先落有界 transcript，再生成不含路径的引用。 */
  async writeTranscript(input: CommandTranscriptWriteInput): Promise<CommandTranscriptRef> {
    assertStoreIdentity(input.taskId)
    assertStoreIdentity(input.commandId)
    assertStoreIdentity(input.transcriptId)
    if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 0) {
      throw new Error('transcript 字节计数无效。')
    }

    const chunks = sanitizeChunks(input.chunks)
    const availableBytes = utf8ByteLength(chunks.map((chunk) => chunk.text).join(''))
    const truncated = input.truncated || availableBytes < input.totalBytes
    const record: CommandTranscriptRecord = {
      transcriptId: input.transcriptId,
      commandId: input.commandId,
      taskId: input.taskId,
      encoding: 'utf-8',
      truncated,
      totalBytes: Math.max(input.totalBytes, availableBytes),
      availableBytes,
      chunks
    }

    await this.writer.write(this.transcriptPath(input.taskId, input.transcriptId), {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      transcriptId: record.transcriptId,
      commandId: record.commandId,
      taskId: record.taskId,
      encoding: record.encoding,
      truncated: record.truncated,
      totalBytes: record.totalBytes,
      availableBytes: record.availableBytes,
      chunks: record.chunks
    })

    const ref: CommandTranscriptRef = {
      transcriptId: record.transcriptId,
      availableBytes: record.availableBytes,
      totalBytes: record.totalBytes,
      truncated: record.truncated,
      encoding: 'utf-8',
      retentionPolicy: 'bounded',
      retentionState: 'retained'
    }
    const parsed = parseCommandTranscriptRef(ref)
    if (!parsed) throw new Error('命令 transcript 引用无效。')
    return parsed
  }

  /** 只持久化已通过共享契约校验的证据，禁止夹带 path 字段。 */
  async writeEvidence(evidence: CommandExecutionEvidence): Promise<void> {
    assertStoreIdentity(evidence.taskId)
    assertStoreIdentity(evidence.commandId)
    const parsed = parseCommandExecutionEvidence(evidence)
    if (!parsed) throw new Error('命令证据无效。')
    await this.writer.write(this.evidencePath(evidence.taskId, evidence.commandId), {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      evidence: parsed
    })
  }

  async readEvidence(taskId: string, commandId: string): Promise<CommandExecutionEvidence | null> {
    assertStoreIdentity(taskId)
    assertStoreIdentity(commandId)
    try {
      const raw = await this.writer.read(
        this.evidencePath(taskId, commandId),
        MAX_EVIDENCE_FILE_BYTES
      )
      if (!isPlainRecord(raw)) return null
      return parseCommandExecutionEvidence(raw.evidence)
    } catch {
      return null
    }
  }

  async readTranscript(
    taskId: string,
    transcriptId: string
  ): Promise<CommandTranscriptRecord | null> {
    assertStoreIdentity(taskId)
    assertStoreIdentity(transcriptId)
    try {
      const raw = await this.writer.read(
        this.transcriptPath(taskId, transcriptId),
        MAX_TRANSCRIPT_FILE_BYTES
      )
      return parseTranscriptRecord(raw)
    } catch {
      return null
    }
  }

  private evidencePath(taskId: string, commandId: string): string {
    return join(this.rootDir, taskId, 'commands', `${commandId}.json`)
  }

  private transcriptPath(taskId: string, transcriptId: string): string {
    return join(this.rootDir, taskId, 'transcripts', `${transcriptId}.json`)
  }
}

function parseTranscriptRecord(value: unknown): CommandTranscriptRecord | null {
  if (!isPlainRecord(value)) return null
  if (value.schemaVersion !== TRANSCRIPT_SCHEMA_VERSION) return null
  if (typeof value.transcriptId !== 'string' || !isStoreIdentity(value.transcriptId)) return null
  if (typeof value.commandId !== 'string' || !isStoreIdentity(value.commandId)) return null
  if (typeof value.taskId !== 'string' || !isStoreIdentity(value.taskId)) return null
  if (value.encoding !== 'utf-8') return null
  if (typeof value.truncated !== 'boolean') return null
  if (
    typeof value.totalBytes !== 'number' ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes < 0
  ) {
    return null
  }
  if (
    typeof value.availableBytes !== 'number' ||
    !Number.isSafeInteger(value.availableBytes) ||
    value.availableBytes < 0
  ) {
    return null
  }
  if (value.totalBytes < value.availableBytes) return null
  const chunks = sanitizeChunks(value.chunks)
  return {
    transcriptId: value.transcriptId,
    commandId: value.commandId,
    taskId: value.taskId,
    encoding: 'utf-8',
    truncated: value.truncated,
    totalBytes: value.totalBytes,
    availableBytes: value.availableBytes,
    chunks
  }
}

function sanitizeChunks(value: unknown): CommandTranscriptChunk[] {
  if (!Array.isArray(value)) return []
  const chunks: CommandTranscriptChunk[] = []
  for (const item of value.slice(0, MAX_COMMAND_TRANSCRIPT_CHUNKS)) {
    if (!isPlainRecord(item)) continue
    if (item.stream !== 'stdout' && item.stream !== 'stderr') continue
    if (typeof item.text !== 'string' || item.text.includes('\0')) continue
    if (item.text.length === 0) continue
    chunks.push({ stream: item.stream, text: item.text })
  }
  return chunks
}

/**
 * 存储身份只能是单段标识，禁止 `.` / `..` / 分隔符，避免 join 后逃出 rootDir。
 */
function assertStoreIdentity(value: string): void {
  if (!isStoreIdentity(value)) throw new Error('命令证据身份无效。')
}

function isStoreIdentity(value: string): boolean {
  if (!value.trim() || value.includes('\0') || value.includes('/') || value.includes('\\')) {
    return false
  }
  if (value === '.' || value === '..') return false
  return utf8ByteLength(value) <= MAX_IDENTIFIER_BYTES
}

function isNonEmptyPath(value: string): boolean {
  return value.length > 0 && !value.includes('\0')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength
}
