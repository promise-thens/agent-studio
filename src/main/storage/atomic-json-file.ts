import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

export interface AtomicJsonFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>
  chmod(path: string, mode: number): Promise<void>
  open(path: string, flags: string, mode?: number): Promise<fs.FileHandle>
  rename(oldPath: string, newPath: string): Promise<void>
  rm(path: string, options: { force?: boolean; recursive?: boolean }): Promise<void>
  readFile(path: string, encoding: 'utf8'): Promise<string>
}

const nodeFileSystem: AtomicJsonFileSystem = {
  mkdir: (path, options) => fs.mkdir(path, options),
  chmod: (path, mode) => fs.chmod(path, mode),
  open: (path, flags, mode) => fs.open(path, flags, mode),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  rm: (path, options) => fs.rm(path, options),
  readFile: (path, encoding) => fs.readFile(path, encoding)
}

export interface AtomicJsonWriterOptions {
  fileSystem?: Partial<AtomicJsonFileSystem>
  randomId?: () => string
}

/**
 * 为历史记录提供可断电恢复的原子 JSON 写入。
 * 文件先在同目录写入并同步，再 rename 替换；父目录同步在平台不支持时安全降级。
 */
export class AtomicJsonWriter {
  private readonly fileSystem: AtomicJsonFileSystem
  private readonly randomId: () => string
  private readonly queues = new Map<string, Promise<void>>()

  constructor(options: AtomicJsonWriterOptions = {}) {
    this.fileSystem = { ...nodeFileSystem, ...options.fileSystem }
    this.randomId = options.randomId ?? randomUUID
  }

  async ensureDirectory(path: string): Promise<void> {
    await this.fileSystem.mkdir(path, { recursive: true, mode: DIRECTORY_MODE })
    await this.safeChmod(path, DIRECTORY_MODE)
  }

  async write(path: string, value: unknown): Promise<void> {
    await this.enqueue(path, async () => {
      const directory = dirname(path)
      await this.ensureDirectory(directory)
      const temporaryPath = join(directory, `.${this.randomId()}.tmp`)
      let handle: fs.FileHandle | null = null

      try {
        handle = await this.fileSystem.open(temporaryPath, 'wx', FILE_MODE)
        await handle.writeFile(`${JSON.stringify(value)}\n`, { encoding: 'utf8' })
        await handle.sync()
        await handle.close()
        handle = null
        await this.fileSystem.rename(temporaryPath, path)
        await this.safeChmod(path, FILE_MODE)
        await this.syncDirectory(directory)
      } catch (error) {
        await handle?.close().catch(() => undefined)
        await this.fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined)
        throw error
      }
    })
  }

  async read(path: string, maxBytes: number): Promise<unknown> {
    const raw = await this.fileSystem.readFile(path, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error('记录内容超过安全上限。')
    return JSON.parse(raw) as unknown
  }

  async renameDurably(source: string, target: string): Promise<void> {
    await this.ensureDirectory(dirname(target))
    await this.fileSystem.rename(source, target)
    await this.syncDirectory(dirname(source))
    if (dirname(source) !== dirname(target)) await this.syncDirectory(dirname(target))
  }

  async removeDurably(path: string): Promise<void> {
    await this.fileSystem.rm(path, { recursive: true, force: true })
    await this.syncDirectory(dirname(path))
  }

  private async enqueue(path: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(path) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.queues.set(path, current)
    try {
      await current
    } finally {
      if (this.queues.get(path) === current) this.queues.delete(path)
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    let handle: fs.FileHandle | null = null
    try {
      handle = await this.fileSystem.open(path, 'r')
      await handle.sync()
    } catch (error) {
      if (!isUnsupportedDirectorySync(error)) throw error
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  private async safeChmod(path: string, mode: number): Promise<void> {
    await this.fileSystem.chmod(path, mode).catch(() => undefined)
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  return ['EINVAL', 'ENOTSUP', 'EBADF', 'EISDIR', 'EPERM'].includes(String(error.code))
}
