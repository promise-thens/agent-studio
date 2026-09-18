import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HOST_BROWSER_SETTINGS } from '../../shared/host-browser'
import { HostBrowserSettingsStore } from './host-browser-settings'

describe('HostBrowserSettingsStore', () => {
  it('缺省开启；损坏文件回退开启，不把坏配置抛出去', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'as-hb-settings-'))
    const store = new HostBrowserSettingsStore({ userDataPath })
    expect(await store.initialize()).toBe(true)
    expect(store.isEnabled()).toBe(true)
    expect(store.getSettings()).toEqual(DEFAULT_HOST_BROWSER_SETTINGS)

    await store.save(false)
    expect(store.isEnabled()).toBe(false)
    expect(JSON.parse(await readFile(store.filePath, 'utf8'))).toMatchObject({
      schemaVersion: 2,
      enabled: false
    })

    const restarted = new HostBrowserSettingsStore({ userDataPath })
    expect(await restarted.initialize()).toBe(false)

    const brokenDir = await mkdtemp(join(tmpdir(), 'as-hb-bad-'))
    const broken = new HostBrowserSettingsStore({ userDataPath: brokenDir })
    await mkdir(join(brokenDir, 'config'), { recursive: true })
    await writeFile(broken.filePath, '{not-json', 'utf8')
    expect(await broken.initialize()).toBe(true)
    expect(broken.getSettings()).toEqual(DEFAULT_HOST_BROWSER_SETTINGS)
  })

  it('读 v1 只保留 enabled，其余出厂默认', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'as-hb-v1-'))
    const store = new HostBrowserSettingsStore({ userDataPath })
    await mkdir(join(userDataPath, 'config'), { recursive: true })
    await writeFile(
      store.filePath,
      JSON.stringify({
        schemaVersion: 1,
        enabled: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
        cookieSyncEnabled: false
      }),
      'utf8'
    )
    expect(await store.initialize()).toBe(false)
    expect(store.getSettings()).toEqual({
      ...DEFAULT_HOST_BROWSER_SETTINGS,
      enabled: false
    })
  })

  it('saveSettings 写 v2；save(enabled) 不丢掉其它内存字段', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'as-hb-v2-'))
    const store = new HostBrowserSettingsStore({ userDataPath })
    await store.initialize()
    const next = {
      ...DEFAULT_HOST_BROWSER_SETTINGS,
      showFullUrl: true,
      cookieSyncEnabled: false,
      syncBlacklist: ['https://mail.example.com']
    }
    expect(await store.saveSettings(next)).toEqual(next)
    expect(store.getSettings()).toEqual(next)
    expect(JSON.parse(await readFile(store.filePath, 'utf8'))).toMatchObject({
      schemaVersion: 2,
      showFullUrl: true,
      cookieSyncEnabled: false,
      syncBlacklist: ['https://mail.example.com']
    })

    await store.save(false)
    expect(store.getSettings()).toEqual({ ...next, enabled: false })
    expect(JSON.parse(await readFile(store.filePath, 'utf8'))).toMatchObject({
      schemaVersion: 2,
      enabled: false,
      showFullUrl: true,
      cookieSyncEnabled: false,
      syncBlacklist: ['https://mail.example.com']
    })
  })
})
