import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProviderConfigInput } from '../../shared/provider'
import { ProviderConfigStore, type SafeStorageAdapter } from './provider-config-store'

type StorageBackend = ReturnType<NonNullable<SafeStorageAdapter['getSelectedStorageBackend']>>

class FakeSafeStorage implements SafeStorageAdapter {
  encryptCalls = 0
  availabilityChecks = 0

  constructor(
    private readonly available = true,
    private readonly backend: StorageBackend = 'unknown',
    private readonly failDecrypt = false
  ) {}

  isEncryptionAvailable(): boolean {
    this.availabilityChecks += 1
    return this.available
  }

  encryptString(plainText: string): Buffer {
    this.encryptCalls += 1
    return Buffer.from(`sealed:${plainText}`, 'utf8')
  }

  decryptString(encryptedValue: Buffer): string {
    if (this.failDecrypt) throw new Error('fake keychain reset')

    const decoded = encryptedValue.toString('utf8')
    if (!decoded.startsWith('sealed:')) throw new Error('invalid fake ciphertext')
    return decoded.slice('sealed:'.length)
  }

  getSelectedStorageBackend(): StorageBackend {
    return this.backend
  }
}

const bearerInput: ProviderConfigInput = {
  baseUrl: 'https://api.example.com/v1',
  authMode: 'bearer',
  apiKey: 'fake-test-api-key-never-real',
  modelId: 'actual-model-id',
  modelDisplayName: 'Actual Model Name'
}

describe('ProviderConfigStore', () => {
  let userDataPath: string

  beforeEach(async () => {
    userDataPath = await fs.mkdtemp(join(tmpdir(), 'agent-studio-store-'))
  })

  afterEach(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true })
  })

  it('加密保存后可在新实例中恢复，摘要和磁盘均不含明文 Key', async () => {
    const safeStorage = new FakeSafeStorage()
    const fixedNow = new Date('2026-08-07T08:00:00.000Z')
    const store = new ProviderConfigStore({
      userDataPath,
      safeStorage,
      platform: 'darwin',
      now: () => fixedNow,
      randomId: () => 'first-save'
    })

    expect(safeStorage.availabilityChecks).toBe(0)
    await store.initialize()
    const summary = await store.save(bearerInput)
    const rawConfig = await fs.readFile(store.configPath, 'utf8')
    const parsedConfig = JSON.parse(rawConfig) as Record<string, unknown>

    expect(summary).toEqual({
      configured: true,
      baseUrl: bearerInput.baseUrl,
      authMode: 'bearer',
      modelId: bearerInput.modelId,
      modelDisplayName: bearerInput.modelDisplayName,
      hasApiKey: true,
      credentialStorage: 'secure',
      testedAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString()
    })
    expect(rawConfig).not.toContain(bearerInput.apiKey as string)
    expect(parsedConfig).toMatchObject({
      schemaVersion: 1,
      modelId: 'actual-model-id',
      modelDisplayName: 'Actual Model Name'
    })
    expect(parsedConfig.encryptedApiKey).toEqual(expect.any(String))

    if (process.platform !== 'win32') {
      const directoryStat = await fs.stat(store.configDirectory)
      const fileStat = await fs.stat(store.configPath)
      expect(directoryStat.mode & 0o777).toBe(0o700)
      expect(fileStat.mode & 0o777).toBe(0o600)
    }

    const restartedStore = new ProviderConfigStore({
      userDataPath,
      safeStorage,
      platform: 'darwin'
    })
    const restartedSummary = await restartedStore.initialize()

    expect(restartedSummary.configured).toBe(true)
    expect(restartedSummary.hasApiKey).toBe(true)
    expect(restartedStore.getRuntimeConfig()).toEqual({
      baseUrl: bearerInput.baseUrl,
      authMode: 'bearer',
      modelId: bearerInput.modelId,
      modelDisplayName: bearerInput.modelDisplayName,
      apiKey: bearerInput.apiKey,
      testedAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString()
    })
  })

  it('公网 HTTP 的 Bearer 配置加密保存后可在重启时恢复', async () => {
    const safeStorage = new FakeSafeStorage()
    const publicHttpInput: ProviderConfigInput = {
      ...bearerInput,
      baseUrl: 'http://api.example.com/v1'
    }
    const store = new ProviderConfigStore({ userDataPath, safeStorage, platform: 'darwin' })

    await store.initialize()
    await store.save(publicHttpInput)

    const rawConfig = await fs.readFile(store.configPath, 'utf8')
    expect(rawConfig).not.toContain(publicHttpInput.apiKey as string)

    const restartedStore = new ProviderConfigStore({
      userDataPath,
      safeStorage,
      platform: 'darwin'
    })
    const summary = await restartedStore.initialize()

    expect(summary).toMatchObject({
      configured: true,
      baseUrl: publicHttpInput.baseUrl,
      hasApiKey: true,
      credentialStorage: 'secure'
    })
    expect(restartedStore.getRuntimeConfig()?.apiKey).toBe(publicHttpInput.apiKey)
  })

  it('无认证 Provider 不要求或保存 Key', async () => {
    const store = new ProviderConfigStore({
      userDataPath,
      safeStorage: new FakeSafeStorage(false),
      platform: 'linux',
      now: () => new Date('2026-08-07T08:10:00.000Z')
    })

    await store.initialize()
    const summary = await store.save({
      baseUrl: 'http://127.0.0.1:11434/v1',
      authMode: 'none',
      modelId: 'local-model'
    })

    expect(summary.configured).toBe(true)
    expect(summary.hasApiKey).toBe(false)
    expect(summary.credentialStorage).toBe('secure')
    expect(store.getRuntimeConfig()?.apiKey).toBeUndefined()
    expect(await fs.readFile(store.configPath, 'utf8')).not.toContain('encryptedApiKey')
  })

  it('损坏 JSON 和未知版本会进入可恢复的 corrupt 状态', async () => {
    const configDirectory = join(userDataPath, 'config')
    const configPath = join(configDirectory, 'provider.json')
    await fs.mkdir(configDirectory, { recursive: true })
    await fs.writeFile(configPath, '{broken json', 'utf8')

    const brokenStore = new ProviderConfigStore({
      userDataPath,
      safeStorage: new FakeSafeStorage(),
      platform: 'darwin'
    })

    expect(await brokenStore.initialize()).toEqual({
      configured: false,
      hasApiKey: false,
      credentialStorage: 'corrupt'
    })

    await fs.writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 999,
        baseUrl: bearerInput.baseUrl,
        authMode: 'bearer',
        modelId: bearerInput.modelId,
        modelDisplayName: bearerInput.modelDisplayName,
        encryptedApiKey: 'ZmFrZQ==',
        updatedAt: '2026-08-07T08:20:00.000Z'
      }),
      'utf8'
    )

    const unknownVersionStore = new ProviderConfigStore({
      userDataPath,
      safeStorage: new FakeSafeStorage(),
      platform: 'darwin'
    })
    const summary = await unknownVersionStore.initialize()

    expect(summary).toMatchObject({
      configured: false,
      baseUrl: bearerInput.baseUrl,
      authMode: 'bearer',
      modelId: bearerInput.modelId,
      modelDisplayName: bearerInput.modelDisplayName,
      hasApiKey: false,
      credentialStorage: 'corrupt'
    })
    expect(unknownVersionStore.getRuntimeConfig()).toBeNull()
  })

  it('Keychain 解密失败时保留非敏感元数据并要求重新输入 Key', async () => {
    const store = new ProviderConfigStore({
      userDataPath,
      safeStorage: new FakeSafeStorage(),
      platform: 'darwin',
      now: () => new Date('2026-08-07T08:30:00.000Z')
    })
    await store.initialize()
    await store.save(bearerInput)

    const restartedStore = new ProviderConfigStore({
      userDataPath,
      safeStorage: new FakeSafeStorage(true, 'unknown', true),
      platform: 'darwin'
    })
    const summary = await restartedStore.initialize()

    expect(summary).toMatchObject({
      configured: false,
      baseUrl: bearerInput.baseUrl,
      authMode: 'bearer',
      modelId: bearerInput.modelId,
      modelDisplayName: bearerInput.modelDisplayName,
      hasApiKey: false,
      credentialStorage: 'corrupt'
    })
    expect(restartedStore.getRuntimeConfig()).toBeNull()
  })

  it('原子 rename 失败时保留旧配置并清理临时文件', async () => {
    const safeStorage = new FakeSafeStorage()
    const originalStore = new ProviderConfigStore({
      userDataPath,
      safeStorage,
      platform: 'darwin',
      now: () => new Date('2026-08-07T08:40:00.000Z')
    })
    await originalStore.initialize()
    await originalStore.save(bearerInput)
    const originalContent = await fs.readFile(originalStore.configPath, 'utf8')

    const failingStore = new ProviderConfigStore({
      userDataPath,
      safeStorage,
      platform: 'darwin',
      now: () => new Date('2026-08-07T08:41:00.000Z'),
      randomId: () => 'rename-failure',
      fileSystem: {
        rename: async () => {
          throw new Error('injected rename failure')
        }
      }
    })
    await failingStore.initialize()

    await expect(
      failingStore.save({
        ...bearerInput,
        apiKey: 'fake-replacement-key',
        modelId: 'replacement-model'
      })
    ).rejects.toThrow('旧配置已保留')

    expect(await fs.readFile(failingStore.configPath, 'utf8')).toBe(originalContent)
    expect(failingStore.getSummary().modelId).toBe(bearerInput.modelId)
    expect(failingStore.getRuntimeConfig()?.apiKey).toBe(bearerInput.apiKey)
    expect(await fs.readdir(failingStore.configDirectory)).toEqual(['provider.json'])
  })

  it('Linux basic_text 只在当前会话保留 Key，重启后不会伪装成已配置', async () => {
    const unsafeStorage = new FakeSafeStorage(true, 'basic_text')
    const store = new ProviderConfigStore({
      userDataPath,
      safeStorage: unsafeStorage,
      platform: 'linux',
      now: () => new Date('2026-08-07T08:50:00.000Z')
    })
    await store.initialize()
    const summary = await store.save(bearerInput)
    const rawConfig = await fs.readFile(store.configPath, 'utf8')

    expect(summary.configured).toBe(true)
    expect(summary.credentialStorage).toBe('session-only')
    expect(unsafeStorage.encryptCalls).toBe(0)
    expect(rawConfig).not.toContain(bearerInput.apiKey as string)
    expect(rawConfig).not.toContain('encryptedApiKey')
    expect(store.getRuntimeConfig()?.apiKey).toBe(bearerInput.apiKey)

    const restartedStore = new ProviderConfigStore({
      userDataPath,
      safeStorage: new FakeSafeStorage(true, 'basic_text'),
      platform: 'linux'
    })
    const restartedSummary = await restartedStore.initialize()

    expect(restartedSummary.configured).toBe(false)
    expect(restartedSummary.hasApiKey).toBe(false)
    expect(restartedSummary.credentialStorage).toBe('session-only')
    expect(restartedSummary.modelId).toBe(bearerInput.modelId)
    expect(restartedStore.getRuntimeConfig()).toBeNull()
  })

  it('清除配置会同时删除磁盘文件和当前会话 Key', async () => {
    const store = new ProviderConfigStore({
      userDataPath,
      safeStorage: new FakeSafeStorage(true, 'basic_text'),
      platform: 'linux'
    })
    await store.initialize()
    await store.save(bearerInput)

    const summary = await store.clear()

    expect(summary).toEqual({
      configured: false,
      hasApiKey: false,
      credentialStorage: 'session-only'
    })
    expect(store.getRuntimeConfig()).toBeNull()
    await expect(fs.access(store.configPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
