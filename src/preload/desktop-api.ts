import type { AgentEvent, AgentPermissionRequest, AgentRuntimeStatus } from '../shared/agent'
import {
  AGENT_INVOKE_CHANNELS,
  AGENT_PUSH_CHANNELS,
  type AgentDesktopApi
} from '../shared/agent-ipc'
import { APP_INVOKE_CHANNELS, type AppDesktopApi } from '../shared/app-ipc'
import type { DesktopIpcResult } from '../shared/ipc-result'
import type { ProviderDesktopApi } from '../shared/provider'

export interface NarrowIpcRenderer {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, listener: (event: unknown, payload: unknown) => void) => void
  removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) => void
}

/** 固定订阅单个 channel，只转发 payload，并提供精确且幂等的清理函数。 */
function subscribe<T>(
  ipcRenderer: NarrowIpcRenderer,
  channel: string,
  listener: (payload: T) => void
): () => void {
  const handler = (_event: unknown, payload: unknown): void => listener(payload as T)
  let cleaned = false
  ipcRenderer.on(channel, handler)
  return () => {
    if (cleaned) return
    cleaned = true
    ipcRenderer.removeListener(channel, handler)
  }
}

/** 创建不暴露 channel 或 Electron event 的中性 Agent API。 */
export function createAgentDesktopApi(ipcRenderer: NarrowIpcRenderer): AgentDesktopApi {
  return {
    getStatus: () =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.getStatus) as Promise<
        DesktopIpcResult<AgentRuntimeStatus>
      >,
    connect: (workspace) =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.connect, { workspace }) as Promise<
        DesktopIpcResult<AgentRuntimeStatus>
      >,
    disconnect: () =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.disconnect) as Promise<
        DesktopIpcResult<AgentRuntimeStatus>
      >,
    sendPrompt: (prompt) =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.sendPrompt, { prompt }) as Promise<
        DesktopIpcResult<null>
      >,
    cancel: () =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.cancel) as Promise<DesktopIpcResult<null>>,
    respondPermission: (requestId, optionId) =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.respondPermission, {
        requestId,
        ...(optionId === undefined ? {} : { optionId })
      }) as Promise<DesktopIpcResult<null>>,
    onStatus: (listener) =>
      subscribe<AgentRuntimeStatus>(ipcRenderer, AGENT_PUSH_CHANNELS.status, listener),
    onEvent: (listener) => subscribe<AgentEvent>(ipcRenderer, AGENT_PUSH_CHANNELS.event, listener),
    onPermission: (listener) =>
      subscribe<AgentPermissionRequest>(ipcRenderer, AGENT_PUSH_CHANNELS.permission, listener)
  }
}

/** 创建只包含目录选择能力的 App API。 */
export function createAppDesktopApi(ipcRenderer: NarrowIpcRenderer): AppDesktopApi {
  return {
    chooseWorkspace: () =>
      ipcRenderer.invoke(APP_INVOKE_CHANNELS.chooseWorkspace) as Promise<
        DesktopIpcResult<string | null>
      >
  }
}

/** Provider 保持既有请求和响应契约，只收窄底层 ipcRenderer 依赖。 */
export function createProviderDesktopApi(ipcRenderer: NarrowIpcRenderer): ProviderDesktopApi {
  return {
    getSummary: () =>
      ipcRenderer.invoke('provider:get-summary') as ReturnType<ProviderDesktopApi['getSummary']>,
    listModels: (input) =>
      ipcRenderer.invoke('provider:list-models', input) as ReturnType<
        ProviderDesktopApi['listModels']
      >,
    save: (input) =>
      ipcRenderer.invoke('provider:save', input) as ReturnType<ProviderDesktopApi['save']>,
    selectModel: (model) =>
      ipcRenderer.invoke('provider:select-model', model) as ReturnType<
        ProviderDesktopApi['selectModel']
      >,
    clear: () => ipcRenderer.invoke('provider:clear') as ReturnType<ProviderDesktopApi['clear']>
  }
}
