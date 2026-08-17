import {
  AGENT_OPERATION_TYPES,
  type AgentOperationType,
  type AgentEvent,
  type AgentPermissionRequest,
  type AgentRuntimeStatus,
  type AgentTaskRuntimeState
} from '../shared/agent'
import {
  AGENT_INVOKE_CHANNELS,
  AGENT_PUSH_CHANNELS,
  type AgentDesktopApi,
  type AgentPermissionCancellation
} from '../shared/agent-ipc'
import { APP_INVOKE_CHANNELS, type AppDesktopApi } from '../shared/app-ipc'
import type { DesktopIpcResult } from '../shared/ipc-result'
import type { TaskExecutionSnapshot } from '../shared/task-execution'
import type { ProviderDesktopApi } from '../shared/provider'
import { TASK_INVOKE_CHANNELS, type TaskDesktopApi } from '../shared/task-ipc'

export interface NarrowIpcRenderer {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, listener: (event: unknown, payload: unknown) => void) => void
  removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) => void
}

const MAX_PERMISSION_FIELD_BYTES = 4 * 1024
const MAX_PERMISSION_TARGETS = 32
const AGENT_RUNTIME_IDS = ['grok', 'codex'] as const
const AGENT_PERMISSION_RISKS = ['L0', 'L1', 'L2', 'L3'] as const
const AGENT_PERMISSION_SCOPES = ['once', 'task'] as const
const AGENT_APP_SERVICES = ['command-runner', 'git', 'worktree', 'other'] as const

/** 固定订阅单个 channel，只转发 payload，并提供精确且幂等的清理函数。 */
function subscribe<T>(
  ipcRenderer: NarrowIpcRenderer,
  channel: string,
  listener: (payload: T) => void,
  parse?: (payload: unknown) => T | null
): () => void {
  const handler = (_event: unknown, payload: unknown): void => {
    const parsed = parse ? parse(payload) : (payload as T)
    if (parsed !== null) listener(parsed)
  }
  let cleaned = false
  ipcRenderer.on(channel, handler)
  return () => {
    if (cleaned) return
    cleaned = true
    ipcRenderer.removeListener(channel, handler)
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readPermissionText(value: unknown, allowEmpty = false): string | null {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && !value.trim()) ||
    value.includes('\0') ||
    new TextEncoder().encode(value).byteLength > MAX_PERMISSION_FIELD_BYTES
  ) {
    return null
  }
  return value
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

/**
 * 权限 Push 是 Preload 的敏感跨进程边界；这里只重建 Renderer 公开 DTO，
 * 主进程意外附带的 Runtime 身份、指纹、optionId 或原始负载不会被透传。
 */
function parsePermissionRequest(payload: unknown): AgentPermissionRequest | null {
  if (!isPlainRecord(payload)) return null
  const approvalId = readPermissionText(payload.approvalId)
  const taskId = readPermissionText(payload.taskId)
  const turnId = readPermissionText(payload.turnId)
  const projectId = readPermissionText(payload.projectId)
  const environmentId = readPermissionText(payload.environmentId)
  const title = readPermissionText(payload.title, true)
  const impact = readPermissionText(payload.impact, true)
  const expiresAt = readPermissionText(payload.expiresAt)
  if (
    !approvalId ||
    !taskId ||
    !turnId ||
    !projectId ||
    !environmentId ||
    title === null ||
    impact === null ||
    !expiresAt ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    (payload.initiator !== 'runtime' && payload.initiator !== 'app') ||
    !isOneOf(payload.operationType, AGENT_OPERATION_TYPES) ||
    !isOneOf(payload.risk, AGENT_PERMISSION_RISKS) ||
    !Array.isArray(payload.targets) ||
    payload.targets.length > MAX_PERMISSION_TARGETS ||
    !Array.isArray(payload.allowedScopes) ||
    payload.allowedScopes.length === 0 ||
    payload.allowedScopes.length > AGENT_PERMISSION_SCOPES.length ||
    (payload.truncated !== undefined && payload.truncated !== true)
  ) {
    return null
  }

  const targets = payload.targets.map((target) => readPermissionText(target, true))
  if (targets.some((target) => target === null)) return null
  if (
    !payload.allowedScopes.every((scope) => isOneOf(scope, AGENT_PERMISSION_SCOPES)) ||
    new Set(payload.allowedScopes).size !== payload.allowedScopes.length
  ) {
    return null
  }

  const identity =
    payload.initiator === 'runtime'
      ? isOneOf(payload.runtimeId, AGENT_RUNTIME_IDS)
        ? { initiator: 'runtime' as const, runtimeId: payload.runtimeId }
        : null
      : isOneOf(payload.appService, AGENT_APP_SERVICES)
        ? { initiator: 'app' as const, appService: payload.appService }
        : null
  if (!identity) return null

  return {
    approvalId,
    ...identity,
    taskId,
    turnId,
    projectId,
    environmentId,
    operationType: payload.operationType as AgentOperationType,
    risk: payload.risk,
    title,
    impact,
    targets: targets as string[],
    allowedScopes: [...payload.allowedScopes],
    expiresAt,
    ...(payload.truncated === true ? { truncated: true } : {})
  }
}

/** 取消 Push 只允许审批三元组和固定原因，不向 Renderer 暴露 Runtime requestId。 */
function parsePermissionCancellation(payload: unknown): AgentPermissionCancellation | null {
  if (!isPlainRecord(payload) || payload.reason !== 'cancelled') return null
  const approvalId = readPermissionText(payload.approvalId)
  const taskId = readPermissionText(payload.taskId)
  const turnId = readPermissionText(payload.turnId)
  if (!approvalId || !taskId || !turnId) return null
  return { approvalId, taskId, turnId, reason: 'cancelled' }
}

/** 创建不暴露 channel 或 Electron event 的中性 Agent API。 */
export function createAgentDesktopApi(ipcRenderer: NarrowIpcRenderer): AgentDesktopApi {
  return {
    getStatus: () =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.getStatus) as Promise<
        DesktopIpcResult<AgentRuntimeStatus>
      >,
    getExecutionSnapshot: () =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.getExecutionSnapshot) as Promise<
        DesktopIpcResult<TaskExecutionSnapshot>
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
        DesktopIpcResult<TaskExecutionSnapshot>
      >,
    cancelTurn: (request) =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.cancelTurn, {
        executionId: request.executionId,
        taskId: request.taskId,
        turnId: request.turnId
      }) as Promise<DesktopIpcResult<null>>,
    getTaskRuntimeState: (taskId) =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.getTaskRuntimeState, { taskId }) as Promise<
        DesktopIpcResult<AgentTaskRuntimeState>
      >,
    respondPermission: (request) =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.respondPermission, {
        approvalId: request.approvalId,
        taskId: request.taskId,
        turnId: request.turnId,
        decision: request.decision
      }) as Promise<DesktopIpcResult<null>>,
    onStatus: (listener) =>
      subscribe<AgentRuntimeStatus>(ipcRenderer, AGENT_PUSH_CHANNELS.status, listener),
    onExecutionUpdate: (listener) =>
      subscribe<TaskExecutionSnapshot>(ipcRenderer, AGENT_PUSH_CHANNELS.executionUpdate, listener),
    onEvent: (listener) => subscribe<AgentEvent>(ipcRenderer, AGENT_PUSH_CHANNELS.event, listener),
    onPermission: (listener) =>
      subscribe<AgentPermissionRequest>(
        ipcRenderer,
        AGENT_PUSH_CHANNELS.permission,
        listener,
        parsePermissionRequest
      ),
    onPermissionCancelled: (listener) =>
      subscribe<AgentPermissionCancellation>(
        ipcRenderer,
        AGENT_PUSH_CHANNELS.permissionCancelled,
        listener,
        parsePermissionCancellation
      )
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
    listPermissionAudits: (taskId, cursor, limit) =>
      ipcRenderer.invoke(TASK_INVOKE_CHANNELS.listPermissionAudits, {
        taskId,
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit })
      }) as ReturnType<TaskDesktopApi['listPermissionAudits']>,
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
