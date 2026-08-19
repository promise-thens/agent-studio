import type {
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentRuntimeStatus,
  AgentTaskRuntimeState
} from './agent'
import type { PublicAgentEvent } from './agent-event'
import type {
  AgentStartTurnAdmissionResult,
  TaskExecutionCancellationRequest,
  TaskExecutionSnapshot
} from './task-execution'
import type { ConversationEntryState } from './task-history'
import type { DesktopIpcResult } from './ipc-result'

export const AGENT_INVOKE_CHANNELS = {
  getStatus: 'agent:get-status',
  getExecutionSnapshot: 'agent:get-execution-snapshot',
  connect: 'agent:connect',
  disconnect: 'agent:disconnect',
  createTask: 'agent:create-task',
  enterTask: 'agent:enter-task',
  startTurn: 'agent:start-turn',
  cancelTurn: 'agent:cancel-turn',
  getTaskRuntimeState: 'agent:get-task-runtime-state',
  respondPermission: 'agent:respond-permission'
} as const

export const AGENT_PUSH_CHANNELS = {
  status: 'agent:status',
  executionUpdate: 'agent:execution-update',
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

export interface AgentEnterTaskRequest {
  taskId: string
}

export interface AgentStartTurnRequest {
  taskId: string
  prompt: string
}

export type AgentCancelTurnRequest = TaskExecutionCancellationRequest

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
  getExecutionSnapshot: () => Promise<DesktopIpcResult<TaskExecutionSnapshot>>
  connect: (projectId: string) => Promise<DesktopIpcResult<AgentRuntimeStatus>>
  disconnect: () => Promise<DesktopIpcResult<AgentRuntimeStatus>>
  createTask: (projectId: string) => Promise<DesktopIpcResult<AgentTaskRuntimeState>>
  enterTask: (taskId: string) => Promise<DesktopIpcResult<ConversationEntryState>>
  startTurn: (
    taskId: string,
    prompt: string
  ) => Promise<DesktopIpcResult<AgentStartTurnAdmissionResult>>
  cancelTurn: (request: AgentCancelTurnRequest) => Promise<DesktopIpcResult<null>>
  getTaskRuntimeState: (taskId: string) => Promise<DesktopIpcResult<AgentTaskRuntimeState>>
  respondPermission: (request: AgentRespondPermissionRequest) => Promise<DesktopIpcResult<null>>
  onStatus: (listener: (status: AgentRuntimeStatus) => void) => () => void
  onExecutionUpdate: (listener: (snapshot: TaskExecutionSnapshot) => void) => () => void
  onEvent: (listener: (event: PublicAgentEvent) => void) => () => void
  onPermission: (listener: (request: AgentPermissionRequest) => void) => () => void
  onPermissionCancelled: (listener: (request: AgentPermissionCancellation) => void) => () => void
}
