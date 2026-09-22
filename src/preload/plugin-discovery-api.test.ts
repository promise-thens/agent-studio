import { describe, expect, it, vi } from 'vitest'
import { createPluginDiscoveryApi } from './plugin-discovery-api'
import { PLUGIN_DISCOVERY_CHANNELS as channels } from '../shared/runtime-plugin-discovery'

describe('插件发现 Preload 白名单', () => {
  it('仅暴露固定操作且丢弃主进程多余字段', async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      value: {
        items: [
          {
            discoveryId: 'user:plugins:demo',
            source: 'user',
            root: 'plugins',
            directoryName: 'demo',
            state: 'unidentified',
            path: '/private',
            enabled: true,
            trust: true
          }
        ],
        sources: [],
        secret: 'fake-secret'
      }
    }))
    const api = createPluginDiscoveryApi({ invoke })
    const result = await api.listPluginDiscoveries()
    expect(Object.keys(api)).toEqual(['listPluginDiscoveries', 'revealPluginDiscovery'])
    expect(invoke).toHaveBeenCalledWith(channels.list)
    expect(result).toEqual({
      ok: true,
      value: {
        items: [
          {
            discoveryId: 'user:plugins:demo',
            source: 'user',
            root: 'plugins',
            directoryName: 'demo',
            state: 'unidentified'
          }
        ],
        sources: []
      }
    })
  })

  it('无效摘要失败关闭；定位结果不能携带绝对路径', async () => {
    const invoke = vi.fn(async () => ({ ok: true, value: '/private/path' }))
    const api = createPluginDiscoveryApi({ invoke })
    expect(await api.listPluginDiscoveries()).toMatchObject({ ok: false })
    expect(await api.revealPluginDiscovery('user:plugins:demo')).toEqual({ ok: true, value: null })
    expect(invoke).toHaveBeenLastCalledWith(channels.reveal, { discoveryId: 'user:plugins:demo' })
  })

  it('主进程失败不伪装为空列表', async () => {
    const failure = { ok: false, error: { code: 'operation-failed', message: '读取失败' } }
    const api = createPluginDiscoveryApi({ invoke: vi.fn(async () => failure) })
    expect(await api.listPluginDiscoveries()).toEqual(failure)
    expect(await api.revealPluginDiscovery('user:plugins:demo')).toEqual(failure)
  })
})
