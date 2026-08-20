import type {
  AgentEvent,
  AgentOperationTarget,
  AgentOperationType,
  AgentPermissionRisk,
  AgentRuntimeCapabilitySnapshot,
  AgentRuntimeId,
  AgentRuntimeStatus,
  AgentTurnOutcome
} from '../../shared/agent'
import type { AgentAvailableCommandSnapshot } from '../../shared/agent-available-command'

/** Adapter 只向服务层暴露有限错误码，禁止夹带协议对象、stderr 或原始异常。 */
export type AgentRuntimeAdapterErrorCode =
  | 'invalid-state'
  | 'runtime-unavailable'
  | 'session-restore-unsupported'
  | 'session-not-found'
  | 'operation-failed'

/** Runtime Adapter 的有限错误；message 必须在 Adapter 内完成脱敏。 */
export class AgentRuntimeAdapterError extends Error {
  constructor(
    readonly code: AgentRuntimeAdapterErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AgentRuntimeAdapterError'
  }
}

/** 产品 Task 在 Runtime 内绑定的私有会话引用，只允许留在主进程。 */
export interface AgentRuntimeSessionRef {
  runtimeId: AgentRuntimeId
  runtimeSessionId: string
  workspace: string
}

/** 中性 MCP 描述；Adapter 内再转成 ACP，避免 SDK 类型漏进 Agent 层。 */
export interface AgentRuntimeMcpServer {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: { name: string; value: string }[]
  url?: string
  headers?: { name: string; value: string }[]
}

/**
 * 创建 Runtime session 所需的最小上下文。
 * taskId 是产品身份，必须在 newSession 前交给 Adapter，
 * 因为 available_commands_update 常在 Turn 之前到达。
 */
export interface AgentRuntimeSessionContext {
  workspace: string
  taskId: string
  mcpServers?: AgentRuntimeMcpServer[]
}

/** 活动 Turn 的稳定身份；取消只能作用于当前完全匹配的引用。 */
export interface AgentRuntimeTurnRef {
  taskId: string
  turnId: string
  runtimeSessionId: string
}

/** Adapter 启动 Turn 时只消费服务层已经校验并分配好的产品上下文。 */
export interface AgentRuntimeTurnContext extends AgentRuntimeTurnRef {
  workspace: string
  prompt: string
}

/** Adapter 完成一次 Turn 后返回与唯一终态事件一致的结果。 */
export interface AgentRuntimeTurnResult {
  outcome: AgentTurnOutcome
}

/** Runtime 权限请求只在主进程内部流转，不包含可由 Renderer 选择的协议 optionId。 */
export interface AgentRuntimePermissionRequest {
  requestId: string
  runtimeId: AgentRuntimeId
  taskId: string
  turnId: string
  runtimeSessionId: string
  toolCallId: string
  operationType: AgentOperationType
  targets: AgentOperationTarget[]
  parameterFingerprint: string
  title: string
  impact: string
  minimumRisk?: AgentPermissionRisk
  executionSupported: boolean
}

/** Runtime 终止 ToolCall 后只通知精确的在途权限身份，不携带协议原始对象。 */
export interface AgentRuntimePermissionCancellation {
  requestId: string
  runtimeId: AgentRuntimeId
  taskId: string
  turnId: string
  runtimeSessionId: string
  toolCallId: string
}

export type AgentRuntimePermissionResolution = 'allow-once' | 'deny-once' | 'cancelled'

/**
 * Runtime 的中性事件出口。实现必须先完成协议投影、脱敏与事件归一化，
 * 不得把 ACP 原始 payload 或主进程实现对象交给调用方。
 */
export interface AgentRuntimeAdapterSink {
  onStatus: (status: AgentRuntimeStatus) => void
  onEvent: (event: AgentEvent) => void
  onPermission: (request: AgentRuntimePermissionRequest) => void
  onPermissionCancelled: (request: AgentRuntimePermissionCancellation) => void
  /**
   * Session 级斜杠命令快照。无 activeTurn 也会到达；
   * 切 session / disconnect 时 commands 为空列表。不进 Timeline。
   */
  onAvailableCommands: (snapshot: AgentAvailableCommandSnapshot) => void
}

/**
 * 当前单 Runtime 阶段的最小 Adapter 契约。
 * 接口只覆盖已经进入 P0-05 的连接、会话、Turn、取消和权限闭环。
 */
export interface AgentRuntimeAdapter {
  readonly runtimeId: AgentRuntimeId

  getStatus(): AgentRuntimeStatus
  getCapabilitySnapshot(): AgentRuntimeCapabilitySnapshot
  connect(workspace: string): Promise<AgentRuntimeStatus>
  disconnect(): Promise<AgentRuntimeStatus>
  createSession(context: AgentRuntimeSessionContext): Promise<AgentRuntimeSessionRef>
  loadSession(
    session: AgentRuntimeSessionRef,
    taskId: string,
    mcpServers?: AgentRuntimeMcpServer[]
  ): Promise<void>
  resumeSession(
    session: AgentRuntimeSessionRef,
    taskId: string,
    mcpServers?: AgentRuntimeMcpServer[]
  ): Promise<void>
  closeSession(session: AgentRuntimeSessionRef): Promise<void>
  startTurn(context: AgentRuntimeTurnContext): Promise<AgentRuntimeTurnResult>
  cancelTurn(turn: AgentRuntimeTurnRef): Promise<void>
  respondPermission(requestId: string, resolution: AgentRuntimePermissionResolution): void
}
