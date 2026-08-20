import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SafeStorageAdapter } from '../provider/provider-config-store'
import { McpServerStore } from './mcp-server-store'
import {
  listProjectMcpServers,
  removeUserMcpServer,
  syncUserMcpFromHome,
  writeUserMcpServer
} from './grok-user-mcp-sync'

class FakeSafeStorage implements SafeStorageAdapter {
  isEncryptionAvailable(): boolean {
    return true
  }

  encryptString(plainText: string): Buffer {
    return Buffer.from(`sealed:${plainText}`, 'utf8')
  }

  decryptString(encryptedValue: Buffer): string {
    return encryptedValue.toString('utf8').slice('sealed:'.length)
  }
}

describe('用户 MCP 双向同步', () => {
  const dirs: string[] = []

  afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function createStore(): Promise<{
    store: McpServerStore
    grokHome: string
    userConfigPath: string
  }> {
    const root = await mkdtemp(join(tmpdir(), 'mcp-sync-'))
    dirs.push(root)
    const grokHome = join(root, 'grok-home')
    const userConfigPath = join(root, '.grok', 'config.toml')
    await mkdir(join(root, '.grok'), { recursive: true })
    const store = new McpServerStore({
      userDataPath: root,
      grokHome,
      safeStorage: new FakeSafeStorage(),
      commandExists: async () => true
    })
    await store.initialize()
    return { store, grokHome, userConfigPath }
  }

  it('用户 toml 有 github + env，sync 后 list 有 hasSecret，App toml 不含 sk-test', async () => {
    const { store, grokHome, userConfigPath } = await createStore()
    await writeFile(
      userConfigPath,
      `[ui]
vim_mode = true

[mcp_servers.github]
command = "/usr/bin/false"
args = []
enabled = true

[mcp_servers.github.env]
API_KEY = "sk-test-not-real"
`,
      'utf8'
    )
    await syncUserMcpFromHome({ userConfigPath, store })
    const listed = store.list()
    expect(listed.some((item) => item.name === 'github' && item.hasSecret)).toBe(true)
    const appToml = await readFile(join(grokHome, 'config.toml'), 'utf8')
    expect(appToml).not.toContain('sk-test')
  })

  it('upsert 后用户临时 toml 出现 docs 表，且原有 [ui] 仍在', async () => {
    const { store, userConfigPath } = await createStore()
    await writeFile(userConfigPath, '[ui]\nvim_mode = true\n', 'utf8')
    await store.upsert({
      name: 'docs',
      enabled: true,
      transport: 'http',
      url: 'https://example.com/mcp'
    })
    await writeUserMcpServer({
      userConfigPath,
      server: {
        name: 'docs',
        enabled: true,
        transport: 'http',
        url: 'https://example.com/mcp'
      }
    })
    const text = await readFile(userConfigPath, 'utf8')
    expect(text).toContain('[mcp_servers.docs]')
    expect(text).toContain('vim_mode = true')
  })

  it('delete 后用户 toml 不再有该表，[models] 仍在', async () => {
    const { userConfigPath } = await createStore()
    await writeFile(
      userConfigPath,
      `[models]
default = "grok-build"

[mcp_servers.docs]
url = "https://example.com/mcp"
enabled = true
`,
      'utf8'
    )
    await removeUserMcpServer({ userConfigPath, name: 'docs' })
    const text = await readFile(userConfigPath, 'utf8')
    expect(text).not.toContain('[mcp_servers.docs]')
    expect(text).toContain('[models]')
  })

  it('用户 toml 损坏时 sync 失败、store 不变', async () => {
    const { store, userConfigPath } = await createStore()
    await writeFile(userConfigPath, '[[[broken', 'utf8')
    await expect(syncUserMcpFromHome({ userConfigPath, store })).rejects.toThrow()
    expect(store.list()).toEqual([])
  })

  it('项目 toml 在 workspace 外的 symlink → 跳过', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-project-'))
    dirs.push(root)
    const workspace = join(root, 'project')
    const outside = join(root, 'outside.toml')
    await mkdir(join(workspace, '.grok'), { recursive: true })
    await writeFile(
      outside,
      `[mcp_servers.stolen]
url = "https://example.com/mcp"
`,
      'utf8'
    )
    try {
      await symlink(outside, join(workspace, '.grok', 'config.toml'))
    } catch (error) {
      if (process.platform === 'win32') return
      throw error
    }
    expect(await listProjectMcpServers(workspace)).toEqual([])
  })
})
