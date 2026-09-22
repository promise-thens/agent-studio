import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PermissionPreferences } from './permission-preferences'
import { AtomicJsonWriter } from '../storage/atomic-json-file'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** 只使用临时配置树，验证真实原子持久化与保守降级。 */
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'permission-preferences-'))
  roots.push(root)
  return root
}

describe('应用级权限偏好', () => {
  it('缺失默认询问；首次接管需确认，跨重启和重复选择保持授权', async () => {
    const root = await fixture()
    const preferences = new PermissionPreferences(root)
    expect(await preferences.read()).toMatchObject({ mode: 'ask', takeoverConfirmed: false })
    await expect(preferences.set('takeover')).rejects.toThrow('确认')
    await preferences.set('takeover', true)
    const restarted = new PermissionPreferences(root)
    expect(await restarted.read()).toMatchObject({ mode: 'takeover', takeoverConfirmed: true })
    await restarted.set('ask')
    await expect(restarted.set('takeover')).resolves.toMatchObject({ mode: 'takeover' })
  })

  it.each(['{broken', '{"schemaVersion":1,"mode":"takeover","takeoverConfirmed":false}'])('损坏或未经确认的偏好默认询问：%s', async (text) => {
    const root = await fixture()
    await writeFile(join(root, 'permission-preferences.json'), text)
    expect(await new PermissionPreferences(root).read()).toMatchObject({ mode: 'ask', takeoverConfirmed: false })
  })

  it('写失败不发布新值，后续串行写仍可恢复', async () => {
    const root = await fixture()
    const writer = new AtomicJsonWriter()
    const write = vi.spyOn(writer, 'write').mockRejectedValueOnce(new Error('disk secret'))
    const preferences = new PermissionPreferences(root, writer)
    await expect(preferences.set('takeover', true)).rejects.toThrow('保存失败')
    expect(await preferences.read()).toMatchObject({ mode: 'ask', takeoverConfirmed: false })
    write.mockRestore()
    await Promise.all([preferences.set('assist'), preferences.set('ask')])
    expect(await new PermissionPreferences(root).read()).toMatchObject({ mode: 'ask' })
  })
})
