/** Agent Studio 当前识别的 Runtime 标识；新增 Runtime 时必须先确认领域语义可复用。 */
export type AgentRuntimeId = 'grok' | 'codex'

/** Runtime 连接与执行状态，供主进程和 Renderer 交换可序列化摘要。 */
export type AgentRuntimeState = 'idle' | 'connecting' | 'ready' | 'busy' | 'error'

/** 任务、会话和 Turn 共用的执行状态。 */
export type AgentExecutionState =
  'pending' | 'running' | 'waiting-permission' | 'completed' | 'failed' | 'cancelled'

/** Runtime 事件映射的实现成熟度；能力矩阵使用下方独立的正交三轴。 */
export type AgentCapabilityState = 'native' | 'simulated' | 'experimental' | 'unsupported'

/** P0-03 固定能力集合；新增能力时必须同时更新完整矩阵构造与验收测试。 */
export const AGENT_CAPABILITY_IDS = [
  'runtime.connect',
  'session.create',
  'session.prompt.text',
  'session.cancel',
  'session.load',
  'session.resume',
  'event.agent-message',
  'event.agent-thought',
  'event.plan',
  'event.tool',
  'event.diff',
  'permission.request',
  'usage.context',
  'usage.turn'
] as const

export type AgentCapabilityId = (typeof AGENT_CAPABILITY_IDS)[number]

/** 能力由 Runtime 原生提供、Agent Studio 模拟、明确不支持或尚未确认。 */
export type AgentCapabilitySupport = 'native' | 'simulated' | 'unsupported' | 'unknown'

/** 已支持能力的实现成熟度；未知或不支持能力不得携带该字段。 */
export type AgentCapabilityMaturity = 'stable' | 'experimental'

/** 能力结论处于未验证、静态/协议声明或真实运行验证阶段。 */
export type AgentCapabilityVerification = 'unverified' | 'declared' | 'verified'

/** 能力结论的最强证据来源，不透传 Runtime 协议原始对象。 */
export type AgentCapabilityEvidenceSource = 'static' | 'protocol' | 'runtime' | 'fallback'

/** Runtime 对单项能力的规范化事实声明；reason 用于解释降级、实验性或模拟行为。 */
export interface AgentCapability {
  capabilityId: AgentCapabilityId
  support: AgentCapabilitySupport
  maturity?: AgentCapabilityMaturity
  verification: AgentCapabilityVerification
  source: AgentCapabilityEvidenceSource
  reason?: string
}

/** 单次 Runtime 观察得到的完整能力快照；能力项必须覆盖全部固定 ID。 */
export interface AgentRuntimeCapabilitySnapshot {
  runtimeId: AgentRuntimeId
  runtimeVersion?: string
  protocolVersion?: string
  observedAt: string
  capabilities: Record<AgentCapabilityId, AgentCapability>
}

/** Renderer 可消费的 Runtime 状态摘要，不包含协议对象或进程实现细节。 */
export interface AgentRuntimeStatus {
  runtimeId: AgentRuntimeId
  state: AgentRuntimeState
  message: string
  workspace?: string
  runtimeSessionId?: string
  capabilitySnapshot?: AgentRuntimeCapabilitySnapshot
}

/** Renderer 可查询的内存 Task 状态；Runtime 私有 session 引用不得进入此 DTO。 */
export interface AgentTaskRuntimeState {
  taskId: string
  runtimeId: AgentRuntimeId
  workspace: string
  state: AgentExecutionState
  activeTurnId?: string
  lastTurnId?: string
  createdAt: string
  updatedAt: string
}

/** 一次 Turn 完成后的有限结果；身份由 AgentService 分配，协议对象不得进入共享层。 */
export interface AgentTurnExecutionResult {
  taskId: string
  turnId: string
  outcome: AgentTurnOutcome
  task: AgentTaskRuntimeState
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

/** P0-07 首期统一识别的副作用类别；未接入能力仍显式保留并默认拒绝。 */
export const AGENT_OPERATION_TYPES = [
  'read-project',
  'write-file',
  'execute-command',
  'delete-path',
  'git-read',
  'git-mutate',
  'worktree-create',
  'worktree-remove',
  'network-egress',
  'browser',
  'screen',
  'clipboard',
  'unknown'
] as const

export type AgentOperationType = (typeof AGENT_OPERATION_TYPES)[number]
export type AgentPermissionRisk = 'L0' | 'L1' | 'L2' | 'L3'
export type AgentPermissionScope = 'once' | 'task'
export type AgentPermissionDecision = 'allow-once' | 'allow-task' | 'deny'
export type AgentPermissionResolutionReason =
  | 'auto-allowed'
  | 'grant-reused'
  | 'user-allowed'
  | 'user-denied'
  | 'cancelled'
  | 'expired'
  | 'invalid-target'
  | 'unsupported'
  | 'internal-error'

/** 发起者只描述受信任主进程边界，不使用 Runtime 文案或 Renderer 输入作为身份。 */
export type AgentOperationInitiator =
  | { kind: 'runtime'; runtimeId: AgentRuntimeId }
  | { kind: 'app'; service: 'command-runner' | 'git' | 'worktree' | 'other' }

/** 目标使用判别联合，避免用含义模糊的字符串数组承载路径、网络和命令。 */
export type AgentOperationTarget =
  | { kind: 'path'; value: string }
  | { kind: 'project'; value: string }
  | { kind: 'origin'; value: string }
  | { kind: 'command'; value: string }
  | { kind: 'git'; value: string }
  | { kind: 'worktree'; value: string }
  | { kind: 'unknown'; value: string }

/**
 * 主进程内部统一授权语言。executionRoot 和参数指纹不会直接发送 Renderer；
 * 参数指纹只用于精确匹配，展示文案必须由受信任调用方单独提供且完成脱敏。
 */
export interface OperationIntent {
  initiator: AgentOperationInitiator
  taskId: string
  turnId: string
  projectId: string
  environmentId: string
  executionRoot: string
  operationType: AgentOperationType
  targets: AgentOperationTarget[]
  parameterFingerprint: string
  title: string
  impact: string
  minimumRisk?: AgentPermissionRisk
}

/** Renderer 只能查看 Broker 已创建的有限审批，不接触 Runtime optionId。 */
export interface AgentPermissionRequest {
  approvalId: string
  initiator: 'runtime' | 'app'
  runtimeId?: AgentRuntimeId
  appService?: Extract<AgentOperationInitiator, { kind: 'app' }>['service']
  taskId: string
  turnId: string
  projectId: string
  environmentId: string
  operationType: AgentOperationType
  risk: AgentPermissionRisk
  title: string
  impact: string
  targets: string[]
  allowedScopes: AgentPermissionScope[]
  expiresAt: string
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
