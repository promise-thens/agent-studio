import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { parseTurnChangeCheckpoint, type TurnChangeCheckpoint } from '../../shared/git-review'
import { AtomicJsonWriter } from '../storage/atomic-json-file'

const MAX_CHECKPOINT_FILE_BYTES = 1024 * 1024
const MAX_IDENTIFIER_BYTES = 4 * 1024
const MAX_LIST_ITEMS = 100

export interface TurnChangeCheckpointStoreOptions {
  /** 注入的存储根；测试传入 tmpdir，生产由组装层注入 userData/git-review/checkpoints。 */
  rootDir: string
  writer?: AtomicJsonWriter
}

/**
 * 按 taskId + turnId 持久化 Turn 前后快照。不复制完整工作树或文件正文。
 */
export class TurnChangeCheckpointStore {
  readonly rootDir: string
  private readonly writer: AtomicJsonWriter

  constructor(options: TurnChangeCheckpointStoreOptions) {
    if (!isNonEmptyPath(options.rootDir)) {
      throw new Error('Git 审阅检查点存储根无效。')
    }
    this.rootDir = options.rootDir
    this.writer = options.writer ?? new AtomicJsonWriter()
  }

  async get(taskId: string, turnId: string): Promise<TurnChangeCheckpoint | null> {
    assertStoreIdentity(taskId)
    assertStoreIdentity(turnId)
    try {
      const raw = await this.writer.read(this.filePath(taskId, turnId), MAX_CHECKPOINT_FILE_BYTES)
      const parsed = parseTurnChangeCheckpoint(raw)
      if (!parsed || parsed.taskId !== taskId || parsed.turnId !== turnId) return null
      return parsed
    } catch {
      return null
    }
  }

  async list(taskId: string): Promise<TurnChangeCheckpoint[]> {
    assertStoreIdentity(taskId)
    let names: string[]
    try {
      names = await fs.readdir(this.taskDir(taskId))
    } catch {
      return []
    }
    const items: TurnChangeCheckpoint[] = []
    for (const name of names) {
      if (name.startsWith('.') || !name.endsWith('.json')) continue
      const turnId = name.slice(0, -'.json'.length)
      if (!isStoreIdentity(turnId)) continue
      const checkpoint = await this.get(taskId, turnId)
      if (checkpoint) items.push(checkpoint)
      if (items.length >= MAX_LIST_ITEMS) break
    }
    items.sort(
      (left, right) =>
        left.capturedBeforeAt.localeCompare(right.capturedBeforeAt) ||
        left.turnId.localeCompare(right.turnId)
    )
    return items
  }

  async put(checkpoint: TurnChangeCheckpoint): Promise<TurnChangeCheckpoint> {
    const parsed = parseTurnChangeCheckpoint(checkpoint)
    if (!parsed) throw new Error('Turn 变更检查点无效。')
    await this.writer.write(this.filePath(parsed.taskId, parsed.turnId), parsed)
    return parsed
  }

  private taskDir(taskId: string): string {
    const digest = createHash('sha256').update(taskId).digest('hex')
    return join(this.rootDir, digest)
  }

  private filePath(taskId: string, turnId: string): string {
    return join(this.taskDir(taskId), `${turnId}.json`)
  }
}

function assertStoreIdentity(value: string): void {
  if (!isStoreIdentity(value)) throw new Error('Turn 变更检查点身份无效。')
}

function isStoreIdentity(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return false
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') return false
  return Buffer.byteLength(value, 'utf8') <= MAX_IDENTIFIER_BYTES
}

function isNonEmptyPath(value: string): boolean {
  return value.length > 0 && !value.includes('\0')
}
