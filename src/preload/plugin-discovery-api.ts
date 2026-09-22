import type { DesktopIpcResult } from '../shared/ipc-result'
import {
  PLUGIN_DISCOVERY_CHANNELS,
  parseRuntimePluginDiscoverySnapshot,
  type PluginDiscoveryDesktopApi
} from '../shared/runtime-plugin-discovery'

/** 仅暴露发现与定位两个固定通道，通用 invoke 永远留在 Preload 闭包内。 */
export function createPluginDiscoveryApi(ipc: {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
}): PluginDiscoveryDesktopApi {
  return {
    listPluginDiscoveries: async () => {
      const result = (await ipc.invoke(PLUGIN_DISCOVERY_CHANNELS.list)) as DesktopIpcResult<unknown>
      if (!result.ok) return result
      const snapshot = parseRuntimePluginDiscoverySnapshot(result.value)
      return snapshot
        ? { ok: true, value: snapshot }
        : { ok: false, error: { code: 'operation-failed', message: '插件来源摘要无效。' } }
    },
    revealPluginDiscovery: async (discoveryId) => {
      const result = (await ipc.invoke(PLUGIN_DISCOVERY_CHANNELS.reveal, {
        discoveryId
      })) as DesktopIpcResult<unknown>
      return result.ok ? { ok: true, value: null } : result
    }
  }
}
