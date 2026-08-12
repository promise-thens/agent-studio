import type {
  AgentEvent,
  AgentPermissionRequest,
  AgentRuntimeStatus,
  AgentTaskRuntimeState,
  AgentTurnExecutionResult
} from './agent'
import type { DesktopIpcResult } from './ipc-result'

export const AGENT_INVOKE_CHANNELS = {
  getStatus: 'agent:get-status',
  connect: 'agent:connect',
  disconnect: 'agent:disconnect',
  createTask: 'agent:create-task',
  startTurn: 'agent:start-turn',
  cancelTurn: 'agent:cancel-turn',
  getTaskRuntimeState: 'agent:get-task-runtime-state',
  respondPermission: 'agent:respond-permission'
} as const

export const AGENT_PUSH_CHANNELS = {
  status: 'agent:status',
  event: 'agent:event',
  permission: 'agent:permission'
} as const

export interface AgentConnectRequest {
  workspace: string
}

export interface AgentCreateTaskRequest {
  workspace: string
}

export interface AgentStartTurnRequest {
  taskId: string
  prompt: string
}

export interface AgentCancelTurnRequest {
  taskId: string
}

export interface AgentGetTaskRuntimeStateRequest {
  taskId: string
}

export interface AgentRespondPermissionRequest {
  requestId: string
  optionId?: string
}

/** Renderer 只能通过固定方法控制当前 Agent Runtime。 */
export interface AgentDesktopApi {
  getStatus: () => Promise<DesktopIpcResult<AgentRuntimeStatus>>
  connect: (workspace: string) => Promise<DesktopIpcResult<AgentRuntimeStatus>>
  disconnect: () => Promise<DesktopIpcResult<AgentRuntimeStatus>>
  createTask: (workspace: string) => Promise<DesktopIpcResult<AgentTaskRuntimeState>>
  startTurn: (taskId: string, prompt: string) => Promise<DesktopIpcResult<AgentTurnExecutionResult>>
  cancelTurn: (taskId: string) => Promise<DesktopIpcResult<null>>
  getTaskRuntimeState: (taskId: string) => Promise<DesktopIpcResult<AgentTaskRuntimeState>>
  respondPermission: (requestId: string, optionId?: string) => Promise<DesktopIpcResult<null>>
  onStatus: (listener: (status: AgentRuntimeStatus) => void) => () => void
  onEvent: (listener: (event: AgentEvent) => void) => () => void
  onPermission: (listener: (request: AgentPermissionRequest) => void) => () => void
}
