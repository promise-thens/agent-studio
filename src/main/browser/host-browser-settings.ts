import { join } from 'node:path'
import { AtomicJsonWriter } from '../storage/atomic-json-file'

const SCHEMA_VERSION = 1
const MAX_FILE_BYTES = 4 * 1024

interface PersistedHostBrowserSettingsV1 {
  schemaVersion: typeof SCHEMA_VERSION
  enabled: boolean
  updatedAt: string
}

export interface HostBrowserSettingsStoreOptions {
  userDataPath: string
  writer?: AtomicJsonWriter
  now?: () => Date
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEnabled(value: unknown): boolean | null {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) return null
  if (value.enabled !== true && value.enabled !== false) return null
  if (typeof value.updatedAt !== 'string' || !value.updatedAt) return null
  return value.enabled
}

/**
 * 是否向 session 注入内置浏览器 MCP。缺省开；坏文件回退开启，避免一次损坏把能力关死。
 */
export class HostBrowserSettingsStore {
  readonly filePath: string
  private readonly writer: AtomicJsonWriter
  private readonly now: () => Date
  private enabled = true

  constructor(options: HostBrowserSettingsStoreOptions) {
    this.filePath = join(options.userDataPath, 'config', 'host-browser.json')
    this.writer = options.writer ?? new AtomicJsonWriter()
    this.now = options.now ?? (() => new Date())
  }

  async initialize(): Promise<boolean> {
    this.enabled = true
    try {
      const parsed = parseEnabled(await this.writer.read(this.filePath, MAX_FILE_BYTES))
      if (parsed !== null) this.enabled = parsed
    } catch {
      this.enabled = true
    }
    return this.enabled
  }

  isEnabled(): boolean {
    return this.enabled
  }

  async save(enabled: boolean): Promise<boolean> {
    if (enabled !== true && enabled !== false) {
      throw new Error('内置浏览器开关无效。')
    }
    const record: PersistedHostBrowserSettingsV1 = {
      schemaVersion: SCHEMA_VERSION,
      enabled,
      updatedAt: this.now().toISOString()
    }
    await this.writer.write(this.filePath, record)
    this.enabled = enabled
    return this.enabled
  }
}
