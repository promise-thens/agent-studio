import type {
  AgentEvent,
  AgentPermissionOption,
  AgentPermissionRequest,
  AgentRuntimeState,
  AgentRuntimeStatus
} from './agent'

/** @deprecated 领域状态已迁移到 AgentRuntimeState；P0-04 前保留旧名称兼容现有 API。 */
export type GrokConnectionState = AgentRuntimeState

/** @deprecated 请使用 AgentRuntimeStatus。 */
export type GrokStatus = AgentRuntimeStatus

/** @deprecated 请使用 AgentEvent。 */
export type GrokAgentEvent = AgentEvent

/** @deprecated 请使用 AgentPermissionOption。 */
export type GrokPermissionOption = AgentPermissionOption

/** @deprecated 请使用 AgentPermissionRequest。 */
export type GrokPermissionRequest = AgentPermissionRequest

export interface GrokDesktopApi {
  getStatus: () => Promise<AgentRuntimeStatus>
  chooseWorkspace: () => Promise<string | null>
  connect: (workspace: string) => Promise<AgentRuntimeStatus>
  disconnect: () => Promise<AgentRuntimeStatus>
  sendPrompt: (prompt: string) => Promise<void>
  cancel: () => Promise<void>
  respondPermission: (requestId: string, optionId?: string) => Promise<void>
  onStatus: (listener: (status: AgentRuntimeStatus) => void) => () => void
  onEvent: (listener: (event: AgentEvent) => void) => () => void
  onPermission: (listener: (request: AgentPermissionRequest) => void) => () => void
}
