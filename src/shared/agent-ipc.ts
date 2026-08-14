import type {
  AgentEvent,
  AgentPermissionDecision,
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
  permission: 'agent:permission',
  permissionCancelled: 'agent:permission-cancelled'
} as const

export interface AgentConnectRequest {
  projectId: string
}

export interface AgentCreateTaskRequest {
  projectId: string
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
  approvalId: string
  taskId: string
  turnId: string
  decision: AgentPermissionDecision
}

/** 主进程只用审批身份通知 Renderer 移除已失效项，不暴露 Runtime requestId。 */
export interface AgentPermissionCancellation {
  approvalId: string
  taskId: string
  turnId: string
  reason: 'cancelled'
}

/** Renderer 只能通过固定方法控制当前 Agent Runtime。 */
export interface AgentDesktopApi {
  getStatus: () => Promise<DesktopIpcResult<AgentRuntimeStatus>>
  connect: (projectId: string) => Promise<DesktopIpcResult<AgentRuntimeStatus>>
  disconnect: () => Promise<DesktopIpcResult<AgentRuntimeStatus>>
  createTask: (projectId: string) => Promise<DesktopIpcResult<AgentTaskRuntimeState>>
  startTurn: (taskId: string, prompt: string) => Promise<DesktopIpcResult<AgentTurnExecutionResult>>
  cancelTurn: (taskId: string) => Promise<DesktopIpcResult<null>>
  getTaskRuntimeState: (taskId: string) => Promise<DesktopIpcResult<AgentTaskRuntimeState>>
  respondPermission: (request: AgentRespondPermissionRequest) => Promise<DesktopIpcResult<null>>
  onStatus: (listener: (status: AgentRuntimeStatus) => void) => () => void
  onEvent: (listener: (event: AgentEvent) => void) => () => void
  onPermission: (listener: (request: AgentPermissionRequest) => void) => () => void
  onPermissionCancelled: (listener: (request: AgentPermissionCancellation) => void) => () => void
}
