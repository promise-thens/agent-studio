/** Agent Studio 当前识别的 Runtime 标识；新增 Runtime 时必须先确认领域语义可复用。 */
export type AgentRuntimeId = 'grok' | 'codex'

/** Runtime 连接与执行状态，供主进程和 Renderer 交换可序列化摘要。 */
export type AgentRuntimeState = 'idle' | 'connecting' | 'ready' | 'busy' | 'error'

/** 任务、会话和 Turn 共用的执行状态。 */
export type AgentExecutionState =
  'pending' | 'running' | 'waiting-permission' | 'completed' | 'failed' | 'cancelled'

/** Runtime 能力的真实支持程度；不支持时必须显式使用 unsupported。 */
export type AgentCapabilityState = 'native' | 'simulated' | 'experimental' | 'unsupported'

/** Runtime 对单项能力的事实声明；reason 用于解释降级或不支持原因。 */
export interface AgentCapability {
  capabilityId: string
  state: AgentCapabilityState
  reason?: string
}

/** Renderer 可消费的 Runtime 状态摘要，不包含协议对象或进程实现细节。 */
export interface AgentRuntimeStatus {
  runtimeId: AgentRuntimeId
  state: AgentRuntimeState
  message: string
  workspace?: string
  runtimeSessionId?: string
}

/** 可持久化的任务摘要；时间字段统一使用 ISO 8601 字符串。 */
export interface AgentTaskSummary {
  taskId: string
  runtimeId: AgentRuntimeId
  state: AgentExecutionState
  title?: string
  workspace?: string
  sessionId?: string
  createdAt: string
  updatedAt: string
}

/** 可持久化的会话摘要，区分 Agent Studio 会话 ID 与 Runtime 私有会话 ID。 */
export interface AgentSessionSummary {
  sessionId: string
  runtimeId: AgentRuntimeId
  state: AgentExecutionState
  runtimeSessionId?: string
  workspace?: string
  createdAt: string
  updatedAt: string
}

/** 可持久化的单轮执行摘要；协议专属的 Turn 字段不得进入此类型。 */
export interface AgentTurnSummary {
  turnId: string
  taskId: string
  sessionId: string
  state: AgentExecutionState
  runtimeTurnId?: string
  startedAt: string
  completedAt?: string
}

/** Usage 中可展示的费用信息，不携带 Provider 请求或账单原文。 */
export interface AgentCost {
  amount: number
  currency: string
}

/** 当前上下文窗口使用量。 */
export interface AgentContextUsage {
  scope: 'context'
  usedTokens: number
  limitTokens: number
  cost?: AgentCost
}

/** 单轮或会话累计的 Token 使用量。 */
export interface AgentTurnUsage {
  scope: 'turn'
  inputTokens: number
  outputTokens: number
  totalTokens: number
  thoughtTokens?: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
  cost?: AgentCost
}

/** Usage 使用判别联合，避免用空对象伪装已支持的统计能力。 */
export type AgentUsage = AgentContextUsage | AgentTurnUsage

/**
 * 可展示的文件变更。Diff 进入 Renderer 或历史前仍必须在主进程完成脱敏与限长，
 * 不得夹带完整请求、环境变量、凭据或协议扩展字段。
 */
export type AgentDiff =
  | {
      format: 'snapshot'
      path: string
      before: string | null
      after: string
    }
  | {
      format: 'unified'
      paths: string[]
      patch: string
    }

export type AgentPermissionOptionKind =
  'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'

export interface AgentPermissionOption {
  optionId: string
  name: string
  kind: AgentPermissionOptionKind
}

/**
 * Renderer 可展示的权限请求。allow_always 仅表示 Runtime 提供的选项，
 * 不代表 Agent Studio 已授予跨任务的永久权限。
 */
export interface AgentPermissionRequest {
  id: string
  runtimeId: AgentRuntimeId
  title: string
  options: AgentPermissionOption[]
  taskId: string
  turnId: string
  runtimeSessionId?: string
  toolCallId?: string
  truncated?: true
}

export type AgentToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

export interface AgentPlanEntry {
  content: string
  priority: 'high' | 'medium' | 'low'
  status: 'pending' | 'in_progress' | 'completed'
}

export type AgentTurnOutcome = 'completed' | 'cancelled' | 'refused' | 'limit-reached' | 'failed'

/**
 * 跨进程事件的统一封套。sequence 只表示主进程接受顺序，observedAt 表示本地观察时间，
 * 不得把两者伪装成 Runtime 原生顺序或生成时间。
 */
export interface AgentEventBase {
  runtimeId: AgentRuntimeId
  capabilityState: AgentCapabilityState
  taskId: string
  turnId: string
  sequence: number
  observedAt: string
  runtimeSessionId?: string
  truncated?: true
}

export type AgentMessageEvent = AgentEventBase & {
  kind: 'agent-message'
  text: string
  messageId?: string
}

export type AgentThoughtEvent = AgentEventBase & {
  kind: 'agent-thought'
  text: string
  messageId?: string
}

export type AgentToolCallEvent = AgentEventBase & {
  kind: 'tool-call'
  toolCallId: string
  title: string
  status?: AgentToolStatus
}

export type AgentToolUpdateEvent = AgentEventBase & {
  kind: 'tool-update'
  toolCallId: string
  title?: string
  status?: AgentToolStatus
}

export type AgentToolEvent = AgentToolCallEvent | AgentToolUpdateEvent

export type AgentPlanEvent = AgentEventBase & {
  kind: 'plan'
  entries: AgentPlanEntry[]
}

export type AgentDiffEvent = AgentEventBase & {
  kind: 'diff'
  diffs: AgentDiff[]
  toolCallId?: string
}

export type AgentUsageEvent = AgentEventBase & {
  kind: 'usage'
  usage: AgentUsage
}

export type AgentTurnCompleteEvent = AgentEventBase & {
  kind: 'turn-complete'
  outcome: AgentTurnOutcome
  usage?: AgentTurnUsage
}

export type AgentErrorEvent = AgentEventBase & {
  kind: 'error'
  message: string
  recoverable: boolean
  code?: string
}

/**
 * 跨进程传递的中性事件判别联合。禁止增加 payload、raw、Header、环境变量或原始堆栈兜底字段。
 */
export type AgentEvent =
  | AgentMessageEvent
  | AgentThoughtEvent
  | AgentToolEvent
  | AgentPlanEvent
  | AgentDiffEvent
  | AgentUsageEvent
  | AgentTurnCompleteEvent
  | AgentErrorEvent
