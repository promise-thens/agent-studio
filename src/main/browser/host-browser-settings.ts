import { join } from 'node:path'
import {
  DEFAULT_HOST_BROWSER_SETTINGS,
  parseHostBrowserSettings,
  type HostBrowserSettings
} from '../../shared/host-browser'
import { AtomicJsonWriter } from '../storage/atomic-json-file'

const SCHEMA_VERSION = 2
const LEGACY_SCHEMA_VERSION = 1
/** v2 最多 64 条 origin；4KB 会把合法黑名单当成损坏并回退出厂默认。 */
const MAX_FILE_BYTES = 256 * 1024

export interface HostBrowserSettingsStoreOptions {
  userDataPath: string
  writer?: AtomicJsonWriter
  now?: () => Date
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneSettings(settings: HostBrowserSettings): HostBrowserSettings {
  return {
    ...settings,
    agentPermissions: { ...settings.agentPermissions },
    syncBlacklist: [...settings.syncBlacklist]
  }
}

/**
 * 磁盘记录：v1 只认 enabled，其余出厂开放；v2 走完整 parse。
 * 缺文件、坏 JSON、未知版本一律回退出厂默认，避免一次损坏把能力关死。
 */
function parsePersistedHostBrowserSettings(value: unknown): HostBrowserSettings | null {
  if (!isRecord(value) || typeof value.updatedAt !== 'string' || !value.updatedAt) return null
  if (value.schemaVersion === LEGACY_SCHEMA_VERSION) {
    if (value.enabled !== true && value.enabled !== false) return null
    return cloneSettings({ ...DEFAULT_HOST_BROWSER_SETTINGS, enabled: value.enabled })
  }
  if (value.schemaVersion !== SCHEMA_VERSION) return null
  return parseHostBrowserSettings(value)
}

/**
 * 内置浏览器完整偏好。缺省开；坏文件回退出厂开放，避免一次损坏把能力关死。
 */
export class HostBrowserSettingsStore {
  readonly filePath: string
  private readonly writer: AtomicJsonWriter
  private readonly now: () => Date
  private settings: HostBrowserSettings = cloneSettings(DEFAULT_HOST_BROWSER_SETTINGS)

  constructor(options: HostBrowserSettingsStoreOptions) {
    this.filePath = join(options.userDataPath, 'config', 'host-browser.json')
    this.writer = options.writer ?? new AtomicJsonWriter()
    this.now = options.now ?? (() => new Date())
  }

  async initialize(): Promise<boolean> {
    this.settings = cloneSettings(DEFAULT_HOST_BROWSER_SETTINGS)
    try {
      const parsed = parsePersistedHostBrowserSettings(
        await this.writer.read(this.filePath, MAX_FILE_BYTES)
      )
      if (parsed !== null) this.settings = parsed
    } catch {
      this.settings = cloneSettings(DEFAULT_HOST_BROWSER_SETTINGS)
    }
    return this.settings.enabled
  }

  getSettings(): HostBrowserSettings {
    return cloneSettings(this.settings)
  }

  isEnabled(): boolean {
    return this.settings.enabled
  }

  async save(enabled: boolean): Promise<boolean> {
    if (enabled !== true && enabled !== false) {
      throw new Error('内置浏览器开关无效。')
    }
    return (await this.persist({ ...this.settings, enabled })).enabled
  }

  /**
   * 写入完整偏好。调用方必须先 parse；这里再 parse 一次，拒绝半份脏对象落盘。
   */
  async saveSettings(next: HostBrowserSettings): Promise<HostBrowserSettings> {
    const parsed = parseHostBrowserSettings(next)
    if (!parsed) {
      throw new Error('内置浏览器设置无效。')
    }
    return this.persist(parsed)
  }

  private async persist(next: HostBrowserSettings): Promise<HostBrowserSettings> {
    const record = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: this.now().toISOString(),
      ...next
    }
    await this.writer.write(this.filePath, record)
    this.settings = cloneSettings(next)
    return this.getSettings()
  }
}
