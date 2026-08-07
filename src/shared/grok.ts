export type GrokConnectionState = 'idle' | 'connecting' | 'ready' | 'busy' | 'error'

export interface GrokStatus {
  state: GrokConnectionState
  message: string
  workspace?: string
  sessionId?: string
}

export interface GrokAgentEvent {
  kind:
    | 'agent-message'
    | 'agent-thought'
    | 'tool-call'
    | 'tool-update'
    | 'plan'
    | 'usage'
    | 'turn-complete'
    | 'stderr'
    | 'raw'
  text?: string
  messageId?: string
  toolCallId?: string
  title?: string
  status?: string
  entries?: Array<{
    content: string
    priority: string
    status: string
  }>
  payload?: unknown
}

export interface GrokPermissionOption {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

export interface GrokPermissionRequest {
  id: string
  title: string
  options: GrokPermissionOption[]
}

export interface GrokDesktopApi {
  getStatus: () => Promise<GrokStatus>
  chooseWorkspace: () => Promise<string | null>
  connect: (workspace: string) => Promise<GrokStatus>
  disconnect: () => Promise<GrokStatus>
  sendPrompt: (prompt: string) => Promise<void>
  cancel: () => Promise<void>
  respondPermission: (requestId: string, optionId?: string) => Promise<void>
  onStatus: (listener: (status: GrokStatus) => void) => () => void
  onEvent: (listener: (event: GrokAgentEvent) => void) => () => void
  onPermission: (listener: (request: GrokPermissionRequest) => void) => () => void
}
