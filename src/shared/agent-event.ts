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

export type PublicAgentToolCallEvent = PublicAgentEventBase & {
  kind: 'tool-call'
  toolCallId: string
  title: string
  status?: AgentToolStatus
}

export type PublicAgentToolUpdateEvent = PublicAgentEventBase & {
  kind: 'tool-update'
  toolCallId: string
  title?: string
  status?: AgentToolStatus
}

export type PublicAgentToolEvent = PublicAgentToolCallEvent | PublicAgentToolUpdateEvent

export type PublicAgentPlanEvent = PublicAgentEventBase & {
  kind: 'plan'
  entries: AgentPlanEntry[]
}

/** P0-12 尚未提供 Diff 审阅服务时，Timeline 只展示有限摘要和不可用原因。 */
export interface PublicAgentDiffReviewReference {
  kind: 'diff-review'
  availability: 'unavailable'
  changedPathCount: number
  pathSummaries: string[]
  reason: 'git-review-not-implemented' | 'source-unavailable' | 'history-truncated'
}

export type PublicAgentDiffEvent = PublicAgentEventBase & {
  kind: 'diff'
  references: PublicAgentDiffReviewReference[]
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
  | PublicAgentToolEvent
  | PublicAgentPlanEvent
  | PublicAgentDiffEvent
  | PublicAgentUsageEvent
  | PublicAgentTurnCompleteEvent
  | PublicAgentErrorEvent
