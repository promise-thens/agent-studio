import type {
  AgentCapabilityState,
  AgentDiff,
  AgentExecutionState,
  AgentPlanEntry,
  AgentRuntimeId,
  AgentOperationType,
  AgentOperationInitiator,
  AgentPermissionResolutionReason,
  AgentPermissionRisk,
  AgentPermissionScope,
  AgentTaskRuntimeState,
  AgentToolStatus,
  AgentTurnOutcome,
  AgentTurnUsage,
  AgentUsage
} from './agent'
import type { TaskExecutionState } from './task-execution'

/** Project 当前目录可用性；历史查看不依赖目录仍然存在。 */
export type ProjectAvailability =
  | { state: 'available' }
  | { state: 'unavailable'; message: string }
  | { state: 'version-unsupported'; message: string }
  | { state: 'corrupt'; message: string }

/** Renderer 可见的 Project 摘要，不授予任意路径读取能力。 */
export interface ProjectSummary {
  projectId: string
  canonicalRoot: string
  displayName: string
  status: 'active' | 'removed'
  availability: ProjectAvailability
  registeredAt: string
  lastOpenedAt: string
  removedAt?: string
  revision: number
}

/** 历史状态兼容旧 pending，并接受 P0-08 的完整执行状态。 */
export type HistoryExecutionState = AgentExecutionState | TaskExecutionState

/** 单轮实际使用的模型事实，不随之后的 Provider 设置变化。 */
export interface TurnModelSnapshot {
  modelId: string
  displayName?: string
}

/** P0-06 只正式支持用户当前 Project 根目录。 */
export interface LocalExecutionEnvironmentSummary {
  kind: 'local'
  projectId: string
}

/** 点进历史后的弱状态；只描述能不能接着聊，不携带 Runtime 私有 session。 */
export type ConversationRestoreState = 'idle' | 'connecting' | 'ready' | 'degraded' | 'unavailable'

/** 点进对话后的恢复结论；Renderer 只读这些字段，禁止夹带 runtimeSessionId。 */
export interface ConversationEntryState {
  taskId: string
  historyReady: boolean
  restore: ConversationRestoreState
  method?: 'resume' | 'load' | 'new-session'
  verification: 'unverified' | 'declared' | 'verified'
  reason?: string
}

/** Runtime 原生恢复能力的有限摘要，不包含私有 session identifier。 */
export interface RuntimeResumeSummary {
  resumed: boolean
  method?: 'resume' | 'load' | 'new-session'
  message: string
  task?: AgentTaskRuntimeState
}

/** 最近 Task 列表使用的有限字段。 */
export interface TaskHistorySummary {
  taskId: string
  projectId: string
  runtimeId: AgentRuntimeId
  title: string
  state: HistoryExecutionState
  turnCount: number
  resumable: boolean
  resumeMessage?: string
  createdAt: string
  updatedAt: string
  revision: number
  /** 归档后默认列表隐藏；get 仍会带上该标记。 */
  archived?: true
}

/** Task 详情保持环境与权限策略中性，不暴露 Runtime 私有引用。 */
export interface TaskHistoryDetail extends TaskHistorySummary {
  environment: LocalExecutionEnvironmentSummary
  permissionPolicy: { kind: 'legacy-runtime' }
}

/** 已持久化 Turn 的审阅记录。 */
export interface TurnHistoryRecord {
  turnId: string
  taskId: string
  promptDisplayText: string
  model: TurnModelSnapshot
  state: HistoryExecutionState
  createdAt: string
  dispatchedAt?: string
  endedAt?: string
  usage?: AgentTurnUsage
  historyTruncated?: true
  truncationReason?: 'event-count' | 'event-bytes' | 'turn-bytes'
  eventCount: number
  eventBytes: number
  artifactIds?: string[]
  validationIds?: string[]
  revision: number
}

/** 历史事件基座明确排除 runtimeSessionId。 */
export interface PersistedAgentEventBase {
  runtimeId: AgentRuntimeId
  capabilityState: AgentCapabilityState
  taskId: string
  turnId: string
  sequence: number
  observedAt: string
  truncated?: true
}

export type PersistedAgentEvent =
  | (PersistedAgentEventBase & { kind: 'agent-message'; text: string; messageId?: string })
  | (PersistedAgentEventBase & { kind: 'agent-thought'; text: string; messageId?: string })
  | (PersistedAgentEventBase & {
      kind: 'tool-call'
      toolCallId: string
      title: string
      status?: AgentToolStatus
    })
  | (PersistedAgentEventBase & {
      kind: 'tool-update'
      toolCallId: string
      title?: string
      status?: AgentToolStatus
    })
  | (PersistedAgentEventBase & { kind: 'plan'; entries: AgentPlanEntry[] })
  | (PersistedAgentEventBase & { kind: 'diff'; diffs: AgentDiff[]; toolCallId?: string })
  | (PersistedAgentEventBase & { kind: 'usage'; usage: AgentUsage })
  | (PersistedAgentEventBase & {
      kind: 'turn-complete'
      outcome: AgentTurnOutcome
      usage?: AgentTurnUsage
    })
  | (PersistedAgentEventBase & {
      kind: 'error'
      message: string
      recoverable: boolean
      code?: string
    })

export interface CursorPage<T> {
  items: T[]
  nextCursor?: string
}

export type TaskHistoryPage = CursorPage<TaskHistorySummary>
export type TurnHistoryPage = CursorPage<TurnHistoryRecord>

/** Event 分页使用 Turn 内数值 sequence，不与实体身份 cursor 混用。 */
export interface PersistedAgentEventPage {
  items: PersistedAgentEvent[]
  /** 当前快照仍有下一页时，下一次查询使用的 exclusive afterSequence。 */
  nextAfterSequence?: number
  /** 本次查询观察到的最高持久化 sequence；没有事件时保持请求基线。 */
  watermark: number
}

/** 权限审计独立于对话事件，P0-09 再决定如何投影到统一 Timeline。 */
export interface PermissionAuditRecord {
  auditId: string
  taskId: string
  turnId: string
  projectId: string
  environmentId: string
  initiator: 'runtime' | 'app'
  runtimeId?: AgentRuntimeId
  appService?: Extract<AgentOperationInitiator, { kind: 'app' }>['service']
  operationType: AgentOperationType
  risk: AgentPermissionRisk
  targetSummaries: string[]
  title: string
  impact: string
  reason: AgentPermissionResolutionReason
  scope?: AgentPermissionScope
  detail?: string
  createdAt: string
  truncated?: true
}

export type PermissionAuditPage = CursorPage<PermissionAuditRecord>

/** 删除预览绑定 revision 与短期 token，确认时必须重新校验。 */
export interface DeletionPreview {
  targetType: 'task' | 'project-history'
  targetId: string
  revision: number
  fileCount: number
  turnCount: number
  bytes: number
  exclusions: string[]
  token: string
  expiresAt: string
}
