import type {
  AgentEvent,
  AgentPermissionRequest,
  AgentRuntimeStatus,
  AgentTaskRuntimeState,
  AgentTurnExecutionResult
} from '../shared/agent'
import {
  AGENT_INVOKE_CHANNELS,
  AGENT_PUSH_CHANNELS,
  type AgentDesktopApi
} from '../shared/agent-ipc'
import { APP_INVOKE_CHANNELS, type AppDesktopApi } from '../shared/app-ipc'
import type { DesktopIpcResult } from '../shared/ipc-result'
import type { ProviderDesktopApi } from '../shared/provider'
import { TASK_INVOKE_CHANNELS, type TaskDesktopApi } from '../shared/task-ipc'

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
    connect: (projectId) =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.connect, { projectId }) as Promise<
        DesktopIpcResult<AgentRuntimeStatus>
      >,
    disconnect: () =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.disconnect) as Promise<
        DesktopIpcResult<AgentRuntimeStatus>
      >,
    createTask: (projectId) =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.createTask, { projectId }) as Promise<
        DesktopIpcResult<AgentTaskRuntimeState>
      >,
    startTurn: (taskId, prompt) =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.startTurn, { taskId, prompt }) as Promise<
        DesktopIpcResult<AgentTurnExecutionResult>
      >,
    cancelTurn: (taskId) =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.cancelTurn, { taskId }) as Promise<
        DesktopIpcResult<null>
      >,
    getTaskRuntimeState: (taskId) =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.getTaskRuntimeState, { taskId }) as Promise<
        DesktopIpcResult<AgentTaskRuntimeState>
      >,
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

/** 创建只包含 Project 注册与历史清理能力的 App API。 */
export function createAppDesktopApi(ipcRenderer: NarrowIpcRenderer): AppDesktopApi {
  return {
    chooseProject: () =>
      ipcRenderer.invoke(APP_INVOKE_CHANNELS.chooseProject) as ReturnType<
        AppDesktopApi['chooseProject']
      >,
    listProjects: () =>
      ipcRenderer.invoke(APP_INVOKE_CHANNELS.listProjects) as ReturnType<
        AppDesktopApi['listProjects']
      >,
    removeProject: (projectId) =>
      ipcRenderer.invoke(APP_INVOKE_CHANNELS.removeProject, { projectId }) as ReturnType<
        AppDesktopApi['removeProject']
      >,
    previewProjectHistoryDeletion: (projectId) =>
      ipcRenderer.invoke(APP_INVOKE_CHANNELS.previewProjectHistoryDeletion, {
        projectId
      }) as ReturnType<AppDesktopApi['previewProjectHistoryDeletion']>,
    deleteProjectHistory: (projectId, token) =>
      ipcRenderer.invoke(APP_INVOKE_CHANNELS.deleteProjectHistory, {
        projectId,
        token
      }) as ReturnType<AppDesktopApi['deleteProjectHistory']>
  }
}

/** 创建不暴露存储路径的 Task 历史 API。 */
export function createTaskDesktopApi(ipcRenderer: NarrowIpcRenderer): TaskDesktopApi {
  return {
    list: (projectId, cursor, limit) =>
      ipcRenderer.invoke(TASK_INVOKE_CHANNELS.list, {
        projectId,
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit })
      }) as ReturnType<TaskDesktopApi['list']>,
    get: (taskId) =>
      ipcRenderer.invoke(TASK_INVOKE_CHANNELS.get, { taskId }) as ReturnType<TaskDesktopApi['get']>,
    listTurns: (taskId, cursor, limit) =>
      ipcRenderer.invoke(TASK_INVOKE_CHANNELS.listTurns, {
        taskId,
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit })
      }) as ReturnType<TaskDesktopApi['listTurns']>,
    listEvents: (taskId, turnId, afterSequence, limit) =>
      ipcRenderer.invoke(TASK_INVOKE_CHANNELS.listEvents, {
        taskId,
        turnId,
        ...(afterSequence === undefined ? {} : { afterSequence }),
        ...(limit === undefined ? {} : { limit })
      }) as ReturnType<TaskDesktopApi['listEvents']>,
    resume: (taskId) =>
      ipcRenderer.invoke(TASK_INVOKE_CHANNELS.resume, { taskId }) as ReturnType<
        TaskDesktopApi['resume']
      >,
    previewDelete: (taskId) =>
      ipcRenderer.invoke(TASK_INVOKE_CHANNELS.previewDelete, { taskId }) as ReturnType<
        TaskDesktopApi['previewDelete']
      >,
    delete: (taskId, token) =>
      ipcRenderer.invoke(TASK_INVOKE_CHANNELS.delete, { taskId, token }) as ReturnType<
        TaskDesktopApi['delete']
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
