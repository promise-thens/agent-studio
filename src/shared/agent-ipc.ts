import type {
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentRuntimeStatus,
  AgentTaskRuntimeState
} from './agent'
import type { TakeoverApplyDecision, TaskPermissionMode } from './task-takeover'
import type { AgentAvailableCommandSnapshot } from './agent-available-command'
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
  respondPermission: 'agent:respond-permission',
  getAvailableCommands: 'agent:get-available-commands',
  setPermissionMode: 'agent:set-permission-mode'
} as const

export const AGENT_PUSH_CHANNELS = {
  status: 'agent:status',
  executionUpdate: 'agent:execution-update',
  event: 'agent:event',
  permission: 'agent:permission',
  permissionCancelled: 'agent:permission-cancelled',
  availableCommands: 'agent:available-commands'
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
  attachmentIds?: string[]
}

export type AgentCancelTurnRequest = TaskExecutionCancellationRequest

export interface AgentGetTaskRuntimeStateRequest {
  taskId: string
}

/** 读取某 Task 当前 session 级斜杠命令快照；未知 taskId 由主进程映射为 invalid-input。 */
export interface AgentGetAvailableCommandsRequest {
  taskId: string
}

export interface AgentRespondPermissionRequest {
  approvalId: string
  taskId: string
  turnId: string
  decision: AgentPermissionDecision
}

/**
 * 切换当前 Task 的批准模式。takeover 必须带 confirmed: true；
 * 这是把审批交给 Grok always-approve，不是 Permission Broker 沙箱。
 */
export interface AgentSetPermissionModeRequest {
  taskId: string
  mode: TaskPermissionMode
  confirmed?: boolean
}

export interface AgentSetPermissionModeResult {
  task: AgentTaskRuntimeState
  decision: TakeoverApplyDecision
  controlPrompt?: '/always-approve'
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
    prompt: string,
    attachmentIds?: string[]
  ) => Promise<DesktopIpcResult<AgentStartTurnAdmissionResult>>
  cancelTurn: (request: AgentCancelTurnRequest) => Promise<DesktopIpcResult<null>>
  getTaskRuntimeState: (taskId: string) => Promise<DesktopIpcResult<AgentTaskRuntimeState>>
  /**
   * 拉取指定 Task 的可用斜杠命令快照。
   * 执行命令仍走 startTurn 文本，不另开 execute-command IPC。
   */
  getAvailableCommands: (taskId: string) => Promise<DesktopIpcResult<AgentAvailableCommandSnapshot>>
  respondPermission: (request: AgentRespondPermissionRequest) => Promise<DesktopIpcResult<null>>
  /**
   * 空闲时切换 ask / assist / takeover。Renderer 不得自己写 _meta；
   * takeover 必须先确认再带 confirmed: true。
   */
  setPermissionMode: (
    request: AgentSetPermissionModeRequest
  ) => Promise<DesktopIpcResult<AgentSetPermissionModeResult>>
  onStatus: (listener: (status: AgentRuntimeStatus) => void) => () => void
  onExecutionUpdate: (listener: (snapshot: TaskExecutionSnapshot) => void) => () => void
  onEvent: (listener: (event: PublicAgentEvent) => void) => () => void
  onPermission: (listener: (request: AgentPermissionRequest) => void) => () => void
  onPermissionCancelled: (listener: (request: AgentPermissionCancellation) => void) => () => void
  /** Session 级命令快照推送；Preload 侧 parse 失败则丢弃，不进 Timeline。 */
  onAvailableCommands: (listener: (snapshot: AgentAvailableCommandSnapshot) => void) => () => void
}
