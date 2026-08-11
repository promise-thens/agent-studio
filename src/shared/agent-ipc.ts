import type { AgentEvent, AgentPermissionRequest, AgentRuntimeStatus } from './agent'
import type { DesktopIpcResult } from './ipc-result'

export const AGENT_INVOKE_CHANNELS = {
  getStatus: 'agent:get-status',
  connect: 'agent:connect',
  disconnect: 'agent:disconnect',
  sendPrompt: 'agent:send-prompt',
  cancel: 'agent:cancel',
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

export interface AgentSendPromptRequest {
  prompt: string
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
  sendPrompt: (prompt: string) => Promise<DesktopIpcResult<null>>
  cancel: () => Promise<DesktopIpcResult<null>>
  respondPermission: (requestId: string, optionId?: string) => Promise<DesktopIpcResult<null>>
  onStatus: (listener: (status: AgentRuntimeStatus) => void) => () => void
  onEvent: (listener: (event: AgentEvent) => void) => () => void
  onPermission: (listener: (request: AgentPermissionRequest) => void) => () => void
}
