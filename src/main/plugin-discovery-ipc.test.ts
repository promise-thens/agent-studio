import { describe, expect, it, vi } from 'vitest'
import type { DesktopIpcHandler } from './ipc-types'
import { registerPluginDiscoveryIpc } from './plugin-discovery-ipc'
import { DesktopIpcFailure, type TrustedIpcInvokeEvent } from './security/ipc-sender-validation'
import { PLUGIN_DISCOVERY_CHANNELS as channels } from '../shared/runtime-plugin-discovery'

/** 注入窄依赖验证边界，不启动 Electron、不读取用户插件。 */
function fixture(): {
  assertTrustedSender: ReturnType<typeof vi.fn>
  listDiscoveries: ReturnType<typeof vi.fn>
  resolveDiscoveryDirectory: ReturnType<typeof vi.fn>
  openDirectory: ReturnType<typeof vi.fn>
  invoke: (channel: string, ...args: unknown[]) => unknown
} {
  const handlers = new Map<string, DesktopIpcHandler>()
  const dependencies = {
    ipcMain: {
      handle: (channel: string, handler: DesktopIpcHandler) => {
        handlers.set(channel, handler)
      }
    },
    assertTrustedSender: vi.fn(),
    listDiscoveries: vi.fn(async () => ({ items: [], sources: [] })),
    resolveDiscoveryDirectory: vi.fn(async () => '/fake/plugins/demo' as string | null),
    openDirectory: vi.fn(async () => ''),
    sanitizeError: () => '读取失败'
  }
  registerPluginDiscoveryIpc(dependencies)
  return {
    ...dependencies,
    invoke: (channel: string, ...args: unknown[]) =>
      handlers.get(channel)!({} as TrustedIpcInvokeEvent, ...args)
  }
}

describe('插件发现窄 IPC', () => {
  it('先校验 sender，拒绝未授权请求且不访问磁盘', async () => {
    const f = fixture()
    f.assertTrustedSender.mockImplementation(() => {
      throw new DesktopIpcFailure('forbidden', '拒绝调用')
    })
    expect(await f.invoke(channels.list)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(await f.invoke(channels.reveal, { discoveryId: 'user:plugins:demo' })).toMatchObject({
      ok: false
    })
    expect(f.listDiscoveries).not.toHaveBeenCalled()
    expect(f.resolveDiscoveryDirectory).not.toHaveBeenCalled()
  })

  it.each(['', '../escape', 'user:plugins:a\u007f', 'x'.repeat(321)])(
    '拒绝非法身份 %j',
    async (discoveryId) => {
      const f = fixture()
      expect(await f.invoke(channels.reveal, { discoveryId })).toMatchObject({
        ok: false,
        error: { code: 'invalid-input' }
      })
      expect(f.resolveDiscoveryDirectory).not.toHaveBeenCalled()
    }
  )

  it('拒绝额外路径参数，定位只使用主进程重新解析路径且不回传路径', async () => {
    const f = fixture()
    expect(await f.invoke(channels.list, {})).toMatchObject({ ok: false })
    expect(
      await f.invoke(channels.reveal, { discoveryId: 'user:plugins:demo', path: '/fake' })
    ).toMatchObject({ ok: false })
    expect(await f.invoke(channels.reveal, { discoveryId: 'user:plugins:demo' })).toEqual({
      ok: true,
      value: null
    })
    expect(f.openDirectory).toHaveBeenCalledWith('/fake/plugins/demo')
    f.resolveDiscoveryDirectory.mockResolvedValue(null)
    expect(await f.invoke(channels.reveal, { discoveryId: 'user:plugins:demo' })).toMatchObject({
      ok: false,
      error: { code: 'not-found' }
    })
  })

  it('打开失败只返回固定文案，不泄漏 shell 错误或路径', async () => {
    const f = fixture()
    f.openDirectory.mockResolvedValue('cannot open /fake/private')
    const result = await f.invoke(channels.reveal, { discoveryId: 'user:plugins:demo' })
    expect(result).toMatchObject({ ok: false, error: { code: 'operation-failed' } })
    expect(JSON.stringify(result)).not.toContain('/fake')
  })
})
