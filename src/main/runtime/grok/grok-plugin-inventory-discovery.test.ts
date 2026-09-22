import { promises as fs } from 'node:fs'
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getManagedGrokHome } from '../../provider/grok-provider-config'
import { listGrokPlugins } from './grok-plugin-inventory'
import {
  listGrokPluginDiscoveries,
  readInstalledPluginRegistry,
  resolveGrokPluginDiscoveryDirectory
} from './grok-plugin-inventory-discovery'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** 测试仅创建隔离目录，不访问真实用户插件或配置。 */
async function fixture(): Promise<{ app: string; osHome: string; home: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'plugin-discovery-')))
  roots.push(root)
  const app = join(root, 'app')
  const osHome = join(root, 'user')
  await mkdir(app)
  await mkdir(osHome)
  return { app, osHome, home: getManagedGrokHome(app) }
}

/** 只写受限清单，测试不运行任何插件脚本。 */
async function plugin(path: string, name: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await writeFile(
    join(path, 'plugin.json'),
    JSON.stringify({ name, displayName: 'bad\u007flabel' })
  )
}

describe('插件只读来源发现', () => {
  it('缺失目录不创建；同名 App 残留与用户插件保持独立且不能启停', async () => {
    const { app, osHome, home } = await fixture()
    const empty = await listGrokPluginDiscoveries(app, osHome)
    expect(empty.items).toEqual([])
    expect(empty.sources.map((source) => source.state)).toEqual(['missing', 'missing'])
    await expect(realpath(home)).rejects.toMatchObject({ code: 'ENOENT' })
    const appPlugin = join(home, 'installed-plugins', 'demo-hash')
    const userPlugin = join(osHome, '.grok', 'installed-plugins', 'demo-hash')
    await plugin(appPlugin, 'demo')
    await plugin(userPlugin, 'demo')
    const snapshot = await listGrokPluginDiscoveries(app, osHome)
    expect(snapshot.items.map((item) => item.discoveryId)).toEqual([
      'app:installed-plugins:demo-hash',
      'user:installed-plugins:demo-hash'
    ])
    expect(snapshot.items.every((item) => item.displayName === 'demo')).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain(osHome)
    expect(await listGrokPlugins(app)).toEqual([])
    expect(
      await resolveGrokPluginDiscoveryDirectory(app, snapshot.items[1].discoveryId, osHome)
    ).toBe(userPlugin)
    expect(await resolveGrokPluginDiscoveryDirectory(app, '../escape', osHome)).toBeNull()
  })

  it.each(['empty', 'invalid', 'missing'] as const)('注册表 %s 不复活安装残留', async (state) => {
    const { app, osHome, home } = await fixture()
    await plugin(join(home, 'installed-plugins', 'leftover'), 'demo')
    if (state !== 'missing') {
      await writeFile(
        join(home, 'installed-plugins', 'registry.json'),
        state === 'empty' ? '{"version":1,"repos":{}}' : '{broken'
      )
    }
    expect((await readInstalledPluginRegistry(home)).state).toBe(state)
    expect(await listGrokPlugins(app)).toEqual([])
    expect((await listGrokPluginDiscoveries(app, osHome)).items).toHaveLength(1)
  })

  it('部分坏注册项不阻断合法项，仓库键与插件身份分开验证', async () => {
    const { app, home } = await fixture()
    await plugin(join(home, 'installed-plugins', 'demo-hash'), 'demo')
    await writeFile(
      join(home, 'installed-plugins', 'registry.json'),
      JSON.stringify({
        version: 1,
        repos: {
          'demo-hash': { plugins: { demo: {} } },
          '../outside': { plugins: { outside: {} } },
          broken: { plugins: { other: {} } }
        }
      })
    )
    expect(await readInstalledPluginRegistry(home)).toMatchObject({
      state: 'partial',
      rejectedCount: 2,
      entries: [{ pluginId: 'demo' }]
    })
    expect((await listGrokPlugins(app)).map((item) => item.pluginId)).toEqual(['demo'])
  })

  it('用户 symlink、坏清单和无清单仅报告状态，定位不跟随越界', async () => {
    const { app, osHome } = await fixture()
    const root = join(osHome, '.grok', 'plugins')
    await mkdir(join(root, 'unknown'), { recursive: true })
    await mkdir(join(root, 'broken'))
    await writeFile(join(root, 'broken', 'plugin.json'), '{broken')
    await symlink(app, join(root, 'escape'))
    const snapshot = await listGrokPluginDiscoveries(app, osHome)
    expect(snapshot.items.map((item) => [item.directoryName, item.state])).toEqual([
      ['broken', 'invalid'],
      ['escape', 'invalid'],
      ['unknown', 'unidentified']
    ])
    expect(snapshot.items.every((item) => !item.pluginId)).toBe(true)
    expect(await resolveGrokPluginDiscoveryDirectory(app, 'user:plugins:escape', osHome)).toBeNull()
  })

  it('定位不接受整体 .grok 根目录链接到来源边界之外', async () => {
    const { app, osHome } = await fixture()
    const outsideHome = join(app, 'outside-grok')
    await plugin(join(outsideHome, 'plugins', 'demo'), 'demo')
    await symlink(outsideHome, join(osHome, '.grok'))

    await expect(
      resolveGrokPluginDiscoveryDirectory(app, 'user:plugins:demo', osHome)
    ).resolves.toBeNull()
  })

  it('清单打开后若同一路径换成另一 inode，则发现项保持无效', async () => {
    const { app, osHome } = await fixture()
    const directory = join(osHome, '.grok', 'plugins', 'demo')
    await plugin(directory, 'demo')
    const manifestPath = join(directory, 'plugin.json')
    const originalOpen = fs.open.bind(fs)
    let replaced = false
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (!replaced && args[0] === manifestPath) {
        await rename(manifestPath, `${manifestPath}.opened`)
        await writeFile(manifestPath, JSON.stringify({ name: 'replaced' }))
        replaced = true
      }
      return handle
    })

    const snapshot = await listGrokPluginDiscoveries(app, osHome)
    expect(snapshot.items).toMatchObject([{ directoryName: 'demo', state: 'invalid' }])
    expect(replaced).toBe(true)
  })

  it('定位前目录换成同路径新 inode 时拒绝 reveal', async () => {
    const { app, osHome } = await fixture()
    const directory = join(osHome, '.grok', 'plugins', 'demo')
    await plugin(directory, 'demo')
    const originalStat = fs.stat.bind(fs)
    let replaced = false
    vi.spyOn(fs, 'stat').mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      const stats = await originalStat(...args)
      if (!replaced && args[0] === directory) {
        await rename(directory, `${directory}.resolved`)
        await mkdir(directory)
        replaced = true
      }
      return stats
    })

    await expect(
      resolveGrokPluginDiscoveryDirectory(app, 'user:plugins:demo', osHome)
    ).resolves.toBeNull()
    expect(replaced).toBe(true)
  })
})
