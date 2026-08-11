import { contextBridge, ipcRenderer } from 'electron'
import {
  createAgentDesktopApi,
  createAppDesktopApi,
  createProviderDesktopApi,
  type NarrowIpcRenderer
} from './desktop-api'

/**
 * 只在上下文隔离开启时暴露三组窄 API。
 * 安全基线不满足时显式失败，禁止降级注入任意 Electron 能力。
 */
export function exposeDesktopApis(
  contextIsolated: boolean,
  exposeInMainWorld: (apiKey: string, api: unknown) => void,
  renderer: NarrowIpcRenderer
): void {
  if (!contextIsolated) {
    throw new Error('Agent Studio 需要启用 contextIsolation。')
  }

  exposeInMainWorld('agent', createAgentDesktopApi(renderer))
  exposeInMainWorld('app', createAppDesktopApi(renderer))
  exposeInMainWorld('provider', createProviderDesktopApi(renderer))
}

exposeDesktopApis(
  process.contextIsolated,
  (apiKey, api) => contextBridge.exposeInMainWorld(apiKey, api),
  ipcRenderer
)
