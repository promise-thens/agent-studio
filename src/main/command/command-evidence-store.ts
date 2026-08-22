import { promises as fs } from 'node:fs'
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

    const bounded = boundTranscriptChunks(sanitizeChunks(input.chunks), input.totalBytes)
    const truncated = input.truncated || bounded.truncated
    const record: CommandTranscriptRecord = {
      transcriptId: input.transcriptId,
      commandId: input.commandId,
      taskId: input.taskId,
      encoding: 'utf-8',
      truncated,
      totalBytes: bounded.totalBytes,
      availableBytes: bounded.availableBytes,
      chunks: bounded.chunks
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

  /**
   * 列出单个 Task 下已通过契约校验的证据。身份必须是单段标识。
   * 临时文件、坏 JSON 和跨 Task 串入项一律跳过，不把路径交给调用方。
   */
  async listEvidence(taskId: string): Promise<CommandExecutionEvidence[]> {
    assertStoreIdentity(taskId)
    let names: string[]
    try {
      names = await fs.readdir(this.commandsDir(taskId))
    } catch {
      return []
    }

    const items: CommandExecutionEvidence[] = []
    for (const name of names) {
      if (name.startsWith('.') || !name.endsWith('.json')) continue
      const commandId = name.slice(0, -'.json'.length)
      if (!isStoreIdentity(commandId)) continue
      const evidence = await this.readEvidence(taskId, commandId)
      if (evidence && evidence.taskId === taskId) items.push(evidence)
    }
    items.sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) ||
        left.commandId.localeCompare(right.commandId)
    )
    return items
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

  private commandsDir(taskId: string): string {
    return join(this.rootDir, taskId, 'commands')
  }

  private evidencePath(taskId: string, commandId: string): string {
    return join(this.commandsDir(taskId), `${commandId}.json`)
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
 * 写入侧强制执行字节/条数上限。Task 3 mapper 也会走这里，不能只依赖 runner 采集端截断。
 */
function boundTranscriptChunks(
  chunks: CommandTranscriptChunk[],
  reportedTotalBytes: number
): {
  chunks: CommandTranscriptChunk[]
  availableBytes: number
  totalBytes: number
  truncated: boolean
} {
  const originalBytes = chunks.reduce((sum, chunk) => sum + utf8ByteLength(chunk.text), 0)
  const totalBytes = Math.max(reportedTotalBytes, originalBytes)
  const bounded: CommandTranscriptChunk[] = []
  let storedBytes = 0
  let truncated = false

  for (const chunk of chunks) {
    if (
      bounded.length >= MAX_COMMAND_TRANSCRIPT_CHUNKS ||
      storedBytes >= MAX_COMMAND_TRANSCRIPT_BYTES
    ) {
      truncated = true
      break
    }
    const chunkBytes = utf8ByteLength(chunk.text)
    const remaining = MAX_COMMAND_TRANSCRIPT_BYTES - storedBytes
    if (chunkBytes <= remaining) {
      bounded.push(chunk)
      storedBytes += chunkBytes
      continue
    }
    const text = truncateUtf8(chunk.text, remaining)
    if (text.length > 0) {
      bounded.push({ stream: chunk.stream, text })
      storedBytes += utf8ByteLength(text)
    }
    truncated = true
    break
  }

  if (storedBytes < totalBytes) truncated = true
  return { chunks: bounded, availableBytes: storedBytes, totalBytes, truncated }
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const encoded = Buffer.from(text, 'utf8')
  if (encoded.byteLength <= maxBytes) return text
  return encoded.subarray(0, maxBytes).toString('utf8')
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
