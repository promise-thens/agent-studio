import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SafeStorageAdapter } from '../provider/provider-config-store'
import { McpServerStore } from './mcp-server-store'

class FakeSafeStorage implements SafeStorageAdapter {
  constructor(
    private readonly available = true,
    private readonly backend: ReturnType<
      NonNullable<SafeStorageAdapter['getSelectedStorageBackend']>
    > = 'unknown'
  ) {}

  isEncryptionAvailable(): boolean {
    return this.available
  }

  encryptString(plainText: string): Buffer {
    return Buffer.from(`sealed:${plainText}`, 'utf8')
  }

  decryptString(encryptedValue: Buffer): string {
    const decoded = encryptedValue.toString('utf8')
    if (!decoded.startsWith('sealed:')) throw new Error('invalid fake ciphertext')
    return decoded.slice('sealed:'.length)
  }

  getSelectedStorageBackend(): ReturnType<
    NonNullable<SafeStorageAdapter['getSelectedStorageBackend']>
  > {
    return this.backend
  }
}

describe('McpServerStore', () => {
  const dirs: string[] = []

  afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function createStore(): Promise<{ store: McpServerStore; grokHome: string }> {
    const root = await mkdtemp(join(tmpdir(), 'mcp-store-'))
    dirs.push(root)
    const grokHome = join(root, 'grok-home')
    const store = new McpServerStore({
      userDataPath: root,
      grokHome,
      safeStorage: new FakeSafeStorage(),
      commandExists: async () => true
    })
    await store.initialize()
    return { store, grokHome }
  }

  it('假 Key 加密后 list 只有 hasSecret: true', async () => {
    const { store, grokHome } = await createStore()
    const summary = await store.upsert({
      name: 'github',
      enabled: true,
      transport: 'stdio',
      command: '/usr/bin/false',
      args: [],
      env: { API_KEY: 'sk-test-not-real' }
    })
    expect(summary.hasSecret).toBe(true)
    expect(JSON.stringify(store.list())).not.toContain('sk-test-not-real')
    const toml = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(grokHome, 'config.toml'), 'utf8')
    )
    expect(toml).toContain('[mcp_servers.github]')
    expect(toml).not.toContain('sk-test')
  })

  it('改 URL origin 后 hasSecret 变 false，旧密文删掉', async () => {
    const { store } = await createStore()
    await store.upsert({
      name: 'docs',
      enabled: true,
      transport: 'http',
      url: 'https://mcp.example.com/api',
      headers: { Authorization: 'Bearer sk-test-not-real' }
    })
    const updated = await store.upsert({
      name: 'docs',
      enabled: true,
      transport: 'http',
      url: 'https://other.example.com/api'
    })
    expect(updated.hasSecret).toBe(false)
    expect(updated.url).toContain('other.example.com')
  })

  it('相对路径 command 拒绝', async () => {
    const { store } = await createStore()
    await expect(
      store.upsert({
        name: 'local',
        enabled: true,
        transport: 'stdio',
        command: 'npx'
      })
    ).rejects.toThrow(/绝对路径/)
  })
})
