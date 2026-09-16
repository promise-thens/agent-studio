import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostBrowserSettingsStore } from './host-browser-settings'

describe('HostBrowserSettingsStore', () => {
  it('缺省开启；损坏文件回退开启，不把坏配置抛出去', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'as-hb-settings-'))
    const store = new HostBrowserSettingsStore({ userDataPath })
    expect(await store.initialize()).toBe(true)
    expect(store.isEnabled()).toBe(true)

    await store.save(false)
    expect(store.isEnabled()).toBe(false)
    expect(JSON.parse(await readFile(store.filePath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      enabled: false
    })

    const restarted = new HostBrowserSettingsStore({ userDataPath })
    expect(await restarted.initialize()).toBe(false)

    const brokenDir = await mkdtemp(join(tmpdir(), 'as-hb-bad-'))
    const broken = new HostBrowserSettingsStore({ userDataPath: brokenDir })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(brokenDir, 'config'), { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(broken.filePath, '{not-json', 'utf8')
    expect(await broken.initialize()).toBe(true)
  })
})
