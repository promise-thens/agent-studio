import type {
  AgentCapabilityState,
  AgentPlanEntry,
  AgentRuntimeId,
  AgentToolStatus,
  AgentTurnOutcome,
  AgentTurnUsage,
  AgentUsage
} from './agent'

/** Renderer 可见事件的公共封套，明确排除 Runtime 私有 session identity。 */
export interface PublicAgentEventBase {
  runtimeId: AgentRuntimeId
  capabilityState: AgentCapabilityState
  taskId: string
  turnId: string
  sequence: number
  observedAt: string
  truncated?: true
}

export type PublicAgentMessageEvent = PublicAgentEventBase & {
  kind: 'agent-message'
  text: string
  messageId?: string
}

export type PublicAgentThoughtEvent = PublicAgentEventBase & {
  kind: 'agent-thought'
  text: string
  messageId?: string
}

/** Renderer 只能拿到附件引用和有限展示名称，原始媒体仍留在主进程 inbox。 */
export type PublicAgentAttachmentEvent = PublicAgentEventBase & {
  kind: 'agent-attachment'
  attachmentId: string
  attachmentKind: 'image'
  originalName: string
}

export type PublicAgentToolCallEvent = PublicAgentEventBase & {
  kind: 'tool-call'
  toolCallId: string
  title: string
  status?: AgentToolStatus
  /**
   * 父 tool 的稳定 toolCallId。无白名单来源时缺省，Renderer 不得据此猜树。
   */
  parentId?: string
  /**
   * 工具执行位置。缺省视为前台，不得写入 'foreground'。
   * 只有观察冻结的 rawInput 布尔才能写成 'background'。
   */
  execution?: 'background'
}

export type PublicAgentToolUpdateEvent = PublicAgentEventBase & {
  kind: 'tool-update'
  toolCallId: string
  title?: string
  status?: AgentToolStatus
  /**
   * 父 tool 的稳定 toolCallId。无白名单来源时缺省，Renderer 不得据此猜树。
   */
  parentId?: string
  /**
   * 工具执行位置。缺省视为前台，不得写入 'foreground'。
   * 只有观察冻结的 rawInput 布尔才能写成 'background'。
   */
  execution?: 'background'
}

export type PublicAgentToolEvent = PublicAgentToolCallEvent | PublicAgentToolUpdateEvent

export type PublicAgentPlanEvent = PublicAgentEventBase & {
  kind: 'plan'
  entries: AgentPlanEntry[]
}

/** 结果审阅仍用路径摘要计数；对话红绿行走 edits，不再把正文藏成 unavailable。 */
export interface PublicAgentDiffReviewReference {
  kind: 'diff-review'
  availability: 'unavailable'
  changedPathCount: number
  pathSummaries: string[]
  reason: 'git-review-not-implemented' | 'source-unavailable' | 'history-truncated'
}

export type PublicAgentEditHunkLineKind = 'ctx' | 'add' | 'del'

/** 对话内一次编辑的一行。正文已限长，不含完整文件快照。 */
export interface PublicAgentEditHunkLine {
  kind: PublicAgentEditHunkLineKind
  text: string
  oldLine?: number
  newLine?: number
}

export interface PublicAgentEditDiff {
  path: string
  added: number
  deleted: number
  truncated?: true
  unavailable?: 'binary' | 'empty'
  hunks: PublicAgentEditHunkLine[][]
}

export type PublicAgentDiffEvent = PublicAgentEventBase & {
  kind: 'diff'
  references: PublicAgentDiffReviewReference[]
  /** 有可展示 hunk 才带上；缺省表示这次没有对话内预览。 */
  edits?: PublicAgentEditDiff[]
  toolCallId?: string
}

export type PublicAgentUsageEvent = PublicAgentEventBase & {
  kind: 'usage'
  usage: AgentUsage
}

export type PublicAgentTurnCompleteEvent = PublicAgentEventBase & {
  kind: 'turn-complete'
  outcome: AgentTurnOutcome
  usage?: AgentTurnUsage
}

export type PublicAgentErrorEvent = PublicAgentEventBase & {
  kind: 'error'
  message: string
  recoverable: boolean
  code?: string
}

/** Main 逐字段投影、Preload 再次重建的 Renderer 公开事件联合。 */
export type PublicAgentEvent =
  | PublicAgentMessageEvent
  | PublicAgentThoughtEvent
  | PublicAgentAttachmentEvent
  | PublicAgentToolEvent
  | PublicAgentPlanEvent
  | PublicAgentDiffEvent
  | PublicAgentUsageEvent
  | PublicAgentTurnCompleteEvent
  | PublicAgentErrorEvent
