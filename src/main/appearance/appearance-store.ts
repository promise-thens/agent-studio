import { join } from 'node:path'
import {
  DEFAULT_APP_APPEARANCE_MODE,
  isAppAppearanceMode,
  type AppAppearanceMode
} from '../../shared/app-appearance'
import { AtomicJsonWriter } from '../storage/atomic-json-file'

const SCHEMA_VERSION = 1
const MAX_APPEARANCE_FILE_BYTES = 4 * 1024

interface PersistedAppearanceV1 {
  schemaVersion: typeof SCHEMA_VERSION
  mode: AppAppearanceMode
  updatedAt: string
}

export interface AppearanceStoreOptions {
  userDataPath: string
  writer?: AtomicJsonWriter
  now?: () => Date
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePersistedAppearance(value: unknown): AppAppearanceMode | null {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) return null
  if (!isAppAppearanceMode(value.mode)) return null
  if (typeof value.updatedAt !== 'string' || !value.updatedAt) return null
  return value.mode
}

/**
 * 持久化外观偏好。文件损坏或版本不认识时回退深色，避免把坏配置抛进 Renderer。
 */
export class AppearanceStore {
  readonly filePath: string
  private readonly writer: AtomicJsonWriter
  private readonly now: () => Date
  private mode: AppAppearanceMode = DEFAULT_APP_APPEARANCE_MODE

  constructor(options: AppearanceStoreOptions) {
    this.filePath = join(options.userDataPath, 'config', 'appearance.json')
    this.writer = options.writer ?? new AtomicJsonWriter()
    this.now = options.now ?? (() => new Date())
  }

  async initialize(): Promise<AppAppearanceMode> {
    this.mode = DEFAULT_APP_APPEARANCE_MODE
    try {
      const parsed = parsePersistedAppearance(
        await this.writer.read(this.filePath, MAX_APPEARANCE_FILE_BYTES)
      )
      if (parsed) this.mode = parsed
    } catch {
      this.mode = DEFAULT_APP_APPEARANCE_MODE
    }
    return this.mode
  }

  getMode(): AppAppearanceMode {
    return this.mode
  }

  async save(mode: AppAppearanceMode): Promise<AppAppearanceMode> {
    if (!isAppAppearanceMode(mode)) {
      throw new Error('外观模式无效。')
    }
    const record: PersistedAppearanceV1 = {
      schemaVersion: SCHEMA_VERSION,
      mode,
      updatedAt: this.now().toISOString()
    }
    await this.writer.write(this.filePath, record)
    this.mode = mode
    return this.mode
  }
}
