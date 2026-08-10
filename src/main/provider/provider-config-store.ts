import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
  ProviderAuthMode,
  ProviderConfigInput,
  ProviderConfigSummary
} from '../../shared/provider'

const SCHEMA_VERSION = 1
const MAX_CONFIG_BYTES = 1024 * 1024

type CredentialStorage = ProviderConfigSummary['credentialStorage']

interface PersistedProviderConfigV1 {
  schemaVersion: typeof SCHEMA_VERSION
  baseUrl: string
  authMode: ProviderAuthMode
  modelId: string
  modelDisplayName?: string
  encryptedApiKey?: string
  testedAt?: string
  updatedAt: string
}

interface RecoveryMetadata {
  baseUrl?: string
  authMode?: ProviderAuthMode
  modelId?: string
  modelDisplayName?: string
  testedAt?: string
  updatedAt?: string
}

export interface ProviderRuntimeConfig {
  baseUrl: string
  authMode: ProviderAuthMode
  modelId: string
  modelDisplayName?: string
  apiKey?: string
  testedAt?: string
  updatedAt: string
}

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encryptedValue: Buffer): string
  getSelectedStorageBackend?():
    'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown'
}

export interface ProviderConfigFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>
  chmod(path: string, mode: number): Promise<void>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(
    path: string,
    content: string,
    options: { encoding: 'utf8'; mode: number; flag: 'wx' }
  ): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  rm(path: string, options: { force: true }): Promise<void>
}

export interface ProviderConfigStoreOptions {
  userDataPath: string
  safeStorage: SafeStorageAdapter
  platform?: NodeJS.Platform
  now?: () => Date
  randomId?: () => string
  fileSystem?: Partial<ProviderConfigFileSystem>
}

export interface SaveProviderConfigOptions {
  testedAt?: string
}

const nodeFileSystem: ProviderConfigFileSystem = {
  mkdir: (path, options) => fs.mkdir(path, options),
  chmod: (path, mode) => fs.chmod(path, mode),
  readFile: (path, encoding) => fs.readFile(path, encoding),
  writeFile: (path, content, options) => fs.writeFile(path, content, options),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  rm: (path, options) => fs.rm(path, options)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAuthMode(value: unknown): value is ProviderAuthMode {
  return value === 'bearer' || value === 'none'
}

/** 持久化层接受 HTTP(S)，但仍拒绝可能夹带凭据或改变请求语义的 URL。 */
function isSafeBaseUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false

  try {
    const url = new URL(value)
    const isAllowedProtocol = url.protocol === 'https:' || url.protocol === 'http:'

    return (
      isAllowedProtocol &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0
    )
  } catch {
    return false
  }
}

function isSafeIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim() === value &&
    value.length <= 256 &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  )
}

function isOptionalDisplayName(value: unknown): value is string | undefined {
  return value === undefined || isSafeIdentifier(value)
}

function isOptionalIsoDate(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === 'string' &&
      value.length <= 64 &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value)
  )
}

function isStrictBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false
  }

  return Buffer.from(value, 'base64').toString('base64') === value
}

function parsePersistedConfig(value: unknown): PersistedProviderConfigV1 | null {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) return null
  if (!isSafeBaseUrl(value.baseUrl)) return null
  if (!isAuthMode(value.authMode)) return null
  if (!isSafeIdentifier(value.modelId)) return null
  if (!isOptionalDisplayName(value.modelDisplayName)) return null
  if (!isOptionalIsoDate(value.testedAt) || !isOptionalIsoDate(value.updatedAt)) return null
  if (value.updatedAt === undefined) return null

  if (value.encryptedApiKey !== undefined) {
    if (typeof value.encryptedApiKey !== 'string' || !isStrictBase64(value.encryptedApiKey)) {
      return null
    }
  }

  if (value.authMode === 'none' && value.encryptedApiKey !== undefined) return null

  return {
    schemaVersion: SCHEMA_VERSION,
    baseUrl: value.baseUrl,
    authMode: value.authMode,
    modelId: value.modelId,
    ...(value.modelDisplayName ? { modelDisplayName: value.modelDisplayName } : {}),
    ...(value.encryptedApiKey ? { encryptedApiKey: value.encryptedApiKey } : {}),
    ...(value.testedAt ? { testedAt: value.testedAt } : {}),
    updatedAt: value.updatedAt
  }
}

function extractRecoveryMetadata(value: unknown): RecoveryMetadata {
  if (!isRecord(value)) return {}

  return {
    ...(isSafeBaseUrl(value.baseUrl) ? { baseUrl: value.baseUrl } : {}),
    ...(isAuthMode(value.authMode) ? { authMode: value.authMode } : {}),
    ...(isSafeIdentifier(value.modelId) ? { modelId: value.modelId } : {}),
    ...(isOptionalDisplayName(value.modelDisplayName) && value.modelDisplayName
      ? { modelDisplayName: value.modelDisplayName }
      : {}),
    ...(isOptionalIsoDate(value.testedAt) && value.testedAt ? { testedAt: value.testedAt } : {}),
    ...(isOptionalIsoDate(value.updatedAt) && value.updatedAt ? { updatedAt: value.updatedAt } : {})
  }
}

function normalizeDisplayName(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

function getOrigin(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin
  } catch {
    return null
  }
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

/**
 * 在主进程中管理单一活动 Provider 配置。
 *
 * Renderer 只能获得 `ProviderConfigSummary`；包含明文 Key 的
 * `getRuntimeConfig()` 只能交给主进程 Runtime 适配器使用。
 */
export class ProviderConfigStore {
  readonly configDirectory: string
  readonly configPath: string

  private readonly safeStorage: SafeStorageAdapter
  private readonly platform: NodeJS.Platform
  private readonly now: () => Date
  private readonly randomId: () => string
  private readonly fileSystem: ProviderConfigFileSystem
  private initialized = false
  private persistedConfig: PersistedProviderConfigV1 | null = null
  private recoveryMetadata: RecoveryMetadata | null = null
  private sessionApiKey: string | undefined
  private credentialStorage: CredentialStorage

  constructor(options: ProviderConfigStoreOptions) {
    this.configDirectory = join(options.userDataPath, 'config')
    this.configPath = join(this.configDirectory, 'provider.json')
    this.safeStorage = options.safeStorage
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? randomUUID
    this.fileSystem = { ...nodeFileSystem, ...options.fileSystem }
    // 构造阶段可能早于 app.whenReady()，此处不得提前触碰 Electron safeStorage。
    this.credentialStorage = 'unavailable'
  }

  /** 从版本化配置文件恢复摘要，并验证 Bearer 密文在当前系统仍可解密。 */
  async initialize(): Promise<ProviderConfigSummary> {
    this.persistedConfig = null
    this.recoveryMetadata = null
    this.sessionApiKey = undefined
    this.credentialStorage = this.canPersistCredentialSecurely() ? 'secure' : 'session-only'

    let rawConfig: string
    try {
      rawConfig = await this.fileSystem.readFile(this.configPath, 'utf8')
    } catch (error) {
      if (isFileNotFound(error)) {
        this.initialized = true
        return this.getSummary()
      }

      this.initialized = true
      this.credentialStorage = 'corrupt'
      return this.getSummary()
    }

    if (Buffer.byteLength(rawConfig, 'utf8') > MAX_CONFIG_BYTES) {
      this.initialized = true
      this.credentialStorage = 'corrupt'
      return this.getSummary()
    }

    let parsedValue: unknown
    try {
      parsedValue = JSON.parse(rawConfig)
    } catch {
      this.initialized = true
      this.credentialStorage = 'corrupt'
      return this.getSummary()
    }

    const parsedConfig = parsePersistedConfig(parsedValue)
    if (!parsedConfig) {
      this.recoveryMetadata = extractRecoveryMetadata(parsedValue)
      this.initialized = true
      this.credentialStorage = 'corrupt'
      return this.getSummary()
    }

    this.persistedConfig = parsedConfig
    this.initialized = true

    if (parsedConfig.authMode === 'none') {
      this.credentialStorage = 'secure'
      return this.getSummary()
    }

    if (!parsedConfig.encryptedApiKey) {
      this.credentialStorage = this.canPersistCredentialSecurely() ? 'unavailable' : 'session-only'
      return this.getSummary()
    }

    if (!this.canPersistCredentialSecurely()) {
      this.credentialStorage = 'unavailable'
      return this.getSummary()
    }

    try {
      const decrypted = this.safeStorage.decryptString(
        Buffer.from(parsedConfig.encryptedApiKey, 'base64')
      )
      if (decrypted.length === 0) throw new Error('decrypted credential is empty')
      this.credentialStorage = 'secure'
    } catch {
      this.credentialStorage = 'corrupt'
    }

    return this.getSummary()
  }

  /** 返回不含密文和明文 Key 的可序列化摘要。 */
  getSummary(): ProviderConfigSummary {
    this.assertInitialized()

    if (this.credentialStorage === 'corrupt') {
      const metadata = this.persistedConfig ?? this.recoveryMetadata
      return {
        configured: false,
        ...(metadata?.baseUrl ? { baseUrl: metadata.baseUrl } : {}),
        ...(metadata?.authMode ? { authMode: metadata.authMode } : {}),
        ...(metadata?.modelId ? { modelId: metadata.modelId } : {}),
        ...(metadata?.modelDisplayName ? { modelDisplayName: metadata.modelDisplayName } : {}),
        hasApiKey: false,
        credentialStorage: 'corrupt',
        ...(metadata?.testedAt ? { testedAt: metadata.testedAt } : {}),
        ...(metadata?.updatedAt ? { updatedAt: metadata.updatedAt } : {})
      }
    }

    if (!this.persistedConfig) {
      return {
        configured: false,
        hasApiKey: false,
        credentialStorage: this.credentialStorage
      }
    }

    const hasApiKey =
      this.persistedConfig.authMode === 'bearer' &&
      (Boolean(this.sessionApiKey) ||
        (this.credentialStorage === 'secure' && Boolean(this.persistedConfig.encryptedApiKey)))
    const configured = this.persistedConfig.authMode === 'none' || hasApiKey

    return {
      configured,
      baseUrl: this.persistedConfig.baseUrl,
      authMode: this.persistedConfig.authMode,
      modelId: this.persistedConfig.modelId,
      ...(this.persistedConfig.modelDisplayName
        ? { modelDisplayName: this.persistedConfig.modelDisplayName }
        : {}),
      hasApiKey,
      credentialStorage: this.credentialStorage,
      ...(this.persistedConfig.testedAt ? { testedAt: this.persistedConfig.testedAt } : {}),
      updatedAt: this.persistedConfig.updatedAt
    }
  }

  /**
   * 仅供主进程内部读取 Runtime 配置。返回值含明文 Key，禁止经 IPC、日志或异常透传。
   */
  getRuntimeConfig(): ProviderRuntimeConfig | null {
    this.assertInitialized()
    if (!this.persistedConfig || this.credentialStorage === 'corrupt') return null

    if (this.persistedConfig.authMode === 'none') {
      return this.toRuntimeConfig(this.persistedConfig)
    }

    if (this.sessionApiKey) {
      return this.toRuntimeConfig(this.persistedConfig, this.sessionApiKey)
    }

    if (!this.persistedConfig.encryptedApiKey || !this.canPersistCredentialSecurely()) {
      return null
    }

    try {
      const apiKey = this.safeStorage.decryptString(
        Buffer.from(this.persistedConfig.encryptedApiKey, 'base64')
      )
      if (!apiKey) throw new Error('decrypted credential is empty')
      return this.toRuntimeConfig(this.persistedConfig, apiKey)
    } catch {
      this.credentialStorage = 'corrupt'
      return null
    }
  }

  /** 加密并原子保存配置；不安全后端只保留当前会话 Key，绝不明文落盘。 */
  async save(
    input: ProviderConfigInput,
    options: SaveProviderConfigOptions = {}
  ): Promise<ProviderConfigSummary> {
    this.assertInitialized()

    const updatedAt = this.now().toISOString()
    const testedAt = options.testedAt ?? updatedAt
    const baseConfig: PersistedProviderConfigV1 = {
      schemaVersion: SCHEMA_VERSION,
      baseUrl: input.baseUrl,
      authMode: input.authMode,
      modelId: input.modelId,
      ...(normalizeDisplayName(input.modelDisplayName)
        ? { modelDisplayName: normalizeDisplayName(input.modelDisplayName) }
        : {}),
      testedAt,
      updatedAt
    }

    if (input.authMode === 'none') {
      await this.writeAtomically(baseConfig)
      this.persistedConfig = baseConfig
      this.recoveryMetadata = null
      this.sessionApiKey = undefined
      this.credentialStorage = 'secure'
      return this.getSummary()
    }

    const apiKey = this.resolveApiKeyForSave(input)
    let nextConfig = baseConfig
    let nextStorage: CredentialStorage = 'session-only'

    if (this.canPersistCredentialSecurely()) {
      try {
        const encryptedBuffer = this.safeStorage.encryptString(apiKey)
        if (encryptedBuffer.length === 0) throw new Error('encrypted credential is empty')
        const encryptedApiKey = encryptedBuffer.toString('base64')
        nextConfig = { ...baseConfig, encryptedApiKey }
        nextStorage = 'secure'
      } catch {
        // Keychain/DPAPI 临时不可用时安全降级到内存，不写入伪加密或明文。
        nextStorage = 'session-only'
      }
    }

    await this.writeAtomically(nextConfig)
    this.persistedConfig = nextConfig
    this.recoveryMetadata = null
    this.sessionApiKey = nextStorage === 'session-only' ? apiKey : undefined
    this.credentialStorage = nextStorage
    return this.getSummary()
  }

  /** 删除磁盘配置并清空当前进程中的临时 Key。 */
  async clear(): Promise<ProviderConfigSummary> {
    this.assertInitialized()
    await this.fileSystem.rm(this.configPath, { force: true })

    this.persistedConfig = null
    this.recoveryMetadata = null
    this.sessionApiKey = undefined
    this.credentialStorage = this.canPersistCredentialSecurely() ? 'secure' : 'session-only'
    return this.getSummary()
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error('ProviderConfigStore 必须先完成 initialize()。')
    }
  }

  private canPersistCredentialSecurely(): boolean {
    try {
      if (!this.safeStorage.isEncryptionAvailable()) return false
      if (this.platform !== 'linux') return true

      const backend = this.safeStorage.getSelectedStorageBackend?.() ?? 'unknown'
      return (
        backend === 'gnome_libsecret' ||
        backend === 'kwallet' ||
        backend === 'kwallet5' ||
        backend === 'kwallet6'
      )
    } catch {
      return false
    }
  }

  private resolveApiKeyForSave(input: ProviderConfigInput): string {
    if (input.apiKey && input.apiKey.trim().length > 0) return input.apiKey

    const existingOrigin = this.persistedConfig ? getOrigin(this.persistedConfig.baseUrl) : null
    const nextOrigin = getOrigin(input.baseUrl)
    if (
      this.persistedConfig?.authMode === 'bearer' &&
      existingOrigin !== null &&
      existingOrigin === nextOrigin
    ) {
      const existingConfig = this.getRuntimeConfig()
      if (existingConfig?.apiKey) return existingConfig.apiKey
    }

    throw new Error('Bearer 认证需要提供 API Key；服务 origin 改变时必须重新输入。')
  }

  private toRuntimeConfig(
    config: PersistedProviderConfigV1,
    apiKey?: string
  ): ProviderRuntimeConfig {
    return {
      baseUrl: config.baseUrl,
      authMode: config.authMode,
      modelId: config.modelId,
      ...(config.modelDisplayName ? { modelDisplayName: config.modelDisplayName } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(config.testedAt ? { testedAt: config.testedAt } : {}),
      updatedAt: config.updatedAt
    }
  }

  /** 使用同目录临时文件和 rename 替换，失败时不触碰旧配置。 */
  private async writeAtomically(config: PersistedProviderConfigV1): Promise<void> {
    await this.fileSystem.mkdir(this.configDirectory, { recursive: true, mode: 0o700 })
    await this.applyModeBestEffort(this.configDirectory, 0o700)

    const temporaryPath = join(
      this.configDirectory,
      `provider.json.tmp-${process.pid}-${this.randomId()}`
    )
    const serialized = `${JSON.stringify(config, null, 2)}\n`

    try {
      await this.fileSystem.writeFile(temporaryPath, serialized, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
      await this.applyModeBestEffort(temporaryPath, 0o600)
      await this.fileSystem.rename(temporaryPath, this.configPath)
      await this.applyModeBestEffort(this.configPath, 0o600)
    } catch {
      try {
        await this.fileSystem.rm(temporaryPath, { force: true })
      } catch {
        // 清理失败也不能覆盖真正的原子写入错误，临时文件本身仍只包含密文。
      }
      throw new Error('无法安全保存模型服务配置，旧配置已保留。')
    }
  }

  private async applyModeBestEffort(path: string, mode: number): Promise<void> {
    if (this.platform === 'win32') return

    try {
      await this.fileSystem.chmod(path, mode)
    } catch {
      // 部分文件系统不支持 POSIX mode；写入时仍显式携带 0600/0700。
    }
  }
}
