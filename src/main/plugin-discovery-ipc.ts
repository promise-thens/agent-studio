import {
  PLUGIN_DISCOVERY_CHANNELS,
  parseRuntimePluginDiscoverySnapshot,
  type RuntimePluginDiscoverySnapshot
} from '../shared/runtime-plugin-discovery'
import type { DesktopIpcMain } from './ipc-types'
import {
  DesktopIpcFailure,
  runDesktopIpcOperation,
  type TrustedIpcInvokeEvent
} from './security/ipc-sender-validation'

/** 独立只读插件桥接，不依赖 Runtime，不接受 Renderer 提供的磁盘路径。 */
export function registerPluginDiscoveryIpc(dependencies: {
  ipcMain: DesktopIpcMain
  assertTrustedSender: (event: TrustedIpcInvokeEvent) => void
  listDiscoveries: () => Promise<RuntimePluginDiscoverySnapshot>
  resolveDiscoveryDirectory: (discoveryId: string) => Promise<string | null>
  openDirectory: (path: string) => Promise<string>
  sanitizeError: (error: unknown) => string
}): void {
  dependencies.ipcMain.handle(PLUGIN_DISCOVERY_CHANNELS.list, (event, ...args) =>
    runDesktopIpcOperation(async () => {
      dependencies.assertTrustedSender(event)
      if (args.length !== 0) throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
      const snapshot = parseRuntimePluginDiscoverySnapshot(await dependencies.listDiscoveries())
      if (!snapshot) throw new DesktopIpcFailure('operation-failed', '插件来源摘要无效。')
      return snapshot
    }, dependencies.sanitizeError)
  )
  dependencies.ipcMain.handle(PLUGIN_DISCOVERY_CHANNELS.reveal, (event, ...args) =>
    runDesktopIpcOperation(async () => {
      dependencies.assertTrustedSender(event)
      const request = args[0]
      if (
        args.length !== 1 ||
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        Object.keys(request).length !== 1 ||
        !('discoveryId' in request) ||
        typeof request.discoveryId !== 'string' ||
        request.discoveryId.length === 0 ||
        request.discoveryId.length > 320 ||
        /[\p{Cc}/\\]/u.test(request.discoveryId)
      )
        throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
      const path = await dependencies.resolveDiscoveryDirectory(request.discoveryId)
      if (!path) throw new DesktopIpcFailure('not-found', '来源目录不存在或不可安全访问。')
      const failure = await dependencies.openDirectory(path)
      if (failure) throw new DesktopIpcFailure('operation-failed', '无法打开插件来源目录。')
      return null
    }, dependencies.sanitizeError)
  )
}
