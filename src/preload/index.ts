import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  GrokAgentEvent,
  GrokDesktopApi,
  GrokPermissionRequest,
  GrokStatus
} from '../shared/grok'
import type { ProviderDesktopApi } from '../shared/provider'

/** 统一包装事件订阅，组件卸载时可主动清理监听器。 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const grokApi: GrokDesktopApi = {
  getStatus: () => ipcRenderer.invoke('grok:get-status'),
  chooseWorkspace: () => ipcRenderer.invoke('grok:choose-workspace'),
  connect: (workspace) => ipcRenderer.invoke('grok:connect', workspace),
  disconnect: () => ipcRenderer.invoke('grok:disconnect'),
  sendPrompt: (prompt) => ipcRenderer.invoke('grok:send-prompt', prompt),
  cancel: () => ipcRenderer.invoke('grok:cancel'),
  respondPermission: (requestId, optionId) =>
    ipcRenderer.invoke('grok:respond-permission', requestId, optionId),
  onStatus: (listener) => subscribe<GrokStatus>('grok:status', listener),
  onEvent: (listener) => subscribe<GrokAgentEvent>('grok:event', listener),
  onPermission: (listener) => subscribe<GrokPermissionRequest>('grok:permission', listener)
}

const providerApi: ProviderDesktopApi = {
  getSummary: () => ipcRenderer.invoke('provider:get-summary'),
  listModels: (input) => ipcRenderer.invoke('provider:list-models', input),
  save: (input) => ipcRenderer.invoke('provider:save', input),
  selectModel: (model) => ipcRenderer.invoke('provider:select-model', model),
  clear: () => ipcRenderer.invoke('provider:clear')
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('grok', grokApi)
  contextBridge.exposeInMainWorld('provider', providerApi)
} else {
  // 非隔离模式仅用于兼容旧环境，正式窗口默认启用上下文隔离。
  const unsafeGlobal = globalThis as unknown as {
    electron: typeof electronAPI
    grok: GrokDesktopApi
    provider: ProviderDesktopApi
  }
  unsafeGlobal.electron = electronAPI
  unsafeGlobal.grok = grokApi
  unsafeGlobal.provider = providerApi
}
