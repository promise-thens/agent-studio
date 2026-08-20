import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppearanceStore } from './appearance-store'

describe('AppearanceStore', () => {
  let userDataPath: string

  beforeEach(async () => {
    userDataPath = await fs.mkdtemp(join(tmpdir(), 'agent-studio-appearance-'))
  })

  afterEach(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true })
  })

  it('缺文件时默认深色，保存后新实例可读回', async () => {
    const store = new AppearanceStore({
      userDataPath,
      now: () => new Date('2026-08-20T08:00:00.000Z')
    })
    expect(await store.initialize()).toBe('dark')
    await store.save('light')
    const raw = await fs.readFile(store.filePath, 'utf8')
    expect(JSON.parse(raw)).toEqual({
      schemaVersion: 1,
      mode: 'light',
      updatedAt: '2026-08-20T08:00:00.000Z'
    })
    expect(raw).not.toMatch(/key|secret|token/i)
    const reloaded = new AppearanceStore({ userDataPath })
    expect(await reloaded.initialize()).toBe('light')
  })

  it('损坏 JSON、未知版本和非法 mode 都回退深色', async () => {
    const store = new AppearanceStore({ userDataPath })
    await store.initialize()
    await fs.mkdir(join(userDataPath, 'config'), { recursive: true })
    await fs.writeFile(store.filePath, '{not-json', 'utf8')
    expect(await new AppearanceStore({ userDataPath }).initialize()).toBe('dark')

    await fs.writeFile(store.filePath, JSON.stringify({ schemaVersion: 9, mode: 'light' }), 'utf8')
    expect(await new AppearanceStore({ userDataPath }).initialize()).toBe('dark')

    await fs.writeFile(
      store.filePath,
      JSON.stringify({ schemaVersion: 1, mode: 'dim', updatedAt: '2026-08-20T00:00:00.000Z' }),
      'utf8'
    )
    expect(await new AppearanceStore({ userDataPath }).initialize()).toBe('dark')
  })
})
