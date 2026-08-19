import {
  AGENT_OPERATION_TYPES,
  type AgentOperationType,
  type AgentPermissionRequest,
  type AgentRuntimeStatus,
  type AgentTaskRuntimeState
} from '../shared/agent'
import type {
  PublicAgentDiffReviewReference,
  PublicAgentEvent,
  PublicAgentEventBase
} from '../shared/agent-event'
import {
  AGENT_INVOKE_CHANNELS,
  AGENT_PUSH_CHANNELS,
  type AgentDesktopApi,
  type AgentPermissionCancellation
} from '../shared/agent-ipc'
import { APP_INVOKE_CHANNELS, type AppDesktopApi } from '../shared/app-ipc'
import type { DesktopIpcResult } from '../shared/ipc-result'
import type { TaskExecutionSnapshot } from '../shared/task-execution'
import type { ProviderDesktopApi } from '../shared/provider'
import type { ConversationEntryState } from '../shared/task-history'
import { TASK_INVOKE_CHANNELS, type TaskDesktopApi } from '../shared/task-ipc'

export interface NarrowIpcRenderer {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, listener: (event: unknown, payload: unknown) => void) => void
  removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) => void
}

const MAX_PERMISSION_FIELD_BYTES = 4 * 1024
const MAX_PERMISSION_TARGETS = 32
const MAX_EVENT_STREAM_BYTES = 64 * 1024
const MAX_EVENT_FIELD_BYTES = 4 * 1024
const MAX_EVENT_PLAN_ENTRIES = 100
const MAX_EVENT_REVIEW_REFERENCES = 20
const MAX_EVENT_REVIEW_PATHS = 20
const AGENT_RUNTIME_IDS = ['grok', 'codex'] as const
const AGENT_CAPABILITY_STATES = ['native', 'simulated', 'experimental', 'unsupported'] as const
const AGENT_TOOL_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'cancelled'] as const
const AGENT_PLAN_PRIORITIES = ['high', 'medium', 'low'] as const
const AGENT_PLAN_STATUSES = ['pending', 'in_progress', 'completed'] as const
const AGENT_TURN_OUTCOMES = [
  'completed',
  'cancelled',
  'refused',
  'limit-reached',
  'failed'
] as const
const AGENT_PERMISSION_RISKS = ['L0', 'L1', 'L2', 'L3'] as const
const AGENT_PERMISSION_SCOPES = ['once', 'task'] as const
const AGENT_APP_SERVICES = ['command-runner', 'git', 'worktree', 'other'] as const

/** 固定订阅单个 channel，只转发 payload，并提供精确且幂等的清理函数。 */
function subscribe<T>(
  ipcRenderer: NarrowIpcRenderer,
  channel: string,
  listener: (payload: T) => void,
  parse?: (payload: unknown) => T | null
): () => void {
  const handler = (_event: unknown, payload: unknown): void => {
    const parsed = parse ? parse(payload) : (payload as T)
    if (parsed !== null) listener(parsed)
  }
  let cleaned = false
  ipcRenderer.on(channel, handler)
  return () => {
    if (cleaned) return
    cleaned = true
    ipcRenderer.removeListener(channel, handler)
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readBoundedText(value: unknown, maxBytes: number, allowEmpty = false): string | null {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && !value.trim()) ||
    value.includes('\0') ||
    new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    return null
  }
  return value
}

function readPermissionText(value: unknown, allowEmpty = false): string | null {
  return readBoundedText(value, MAX_PERMISSION_FIELD_BYTES, allowEmpty)
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

/**
 * 权限 Push 是 Preload 的敏感跨进程边界；这里只重建 Renderer 公开 DTO，
 * 主进程意外附带的 Runtime 身份、指纹、optionId 或原始负载不会被透传。
 */
function parsePermissionRequest(payload: unknown): AgentPermissionRequest | null {
  if (!isPlainRecord(payload)) return null
  const approvalId = readPermissionText(payload.approvalId)
  const taskId = readPermissionText(payload.taskId)
  const turnId = readPermissionText(payload.turnId)
  const projectId = readPermissionText(payload.projectId)
  const environmentId = readPermissionText(payload.environmentId)
  const title = readPermissionText(payload.title, true)
  const impact = readPermissionText(payload.impact, true)
  const expiresAt = readPermissionText(payload.expiresAt)
  if (
    !approvalId ||
    !taskId ||
    !turnId ||
    !projectId ||
    !environmentId ||
    title === null ||
    impact === null ||
    !expiresAt ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    (payload.initiator !== 'runtime' && payload.initiator !== 'app') ||
    !isOneOf(payload.operationType, AGENT_OPERATION_TYPES) ||
    !isOneOf(payload.risk, AGENT_PERMISSION_RISKS) ||
    !Array.isArray(payload.targets) ||
    payload.targets.length > MAX_PERMISSION_TARGETS ||
    !Array.isArray(payload.allowedScopes) ||
    payload.allowedScopes.length === 0 ||
    payload.allowedScopes.length > AGENT_PERMISSION_SCOPES.length ||
    (payload.truncated !== undefined && payload.truncated !== true)
  ) {
    return null
  }

  const targets = payload.targets.map((target) => readPermissionText(target, true))
  if (targets.some((target) => target === null)) return null
  if (
    !payload.allowedScopes.every((scope) => isOneOf(scope, AGENT_PERMISSION_SCOPES)) ||
    new Set(payload.allowedScopes).size !== payload.allowedScopes.length
  ) {
    return null
  }

  const identity =
    payload.initiator === 'runtime'
      ? isOneOf(payload.runtimeId, AGENT_RUNTIME_IDS)
        ? { initiator: 'runtime' as const, runtimeId: payload.runtimeId }
        : null
      : isOneOf(payload.appService, AGENT_APP_SERVICES)
        ? { initiator: 'app' as const, appService: payload.appService }
        : null
  if (!identity) return null

  return {
    approvalId,
    ...identity,
    taskId,
    turnId,
    projectId,
    environmentId,
    operationType: payload.operationType as AgentOperationType,
    risk: payload.risk,
    title,
    impact,
    targets: targets as string[],
    allowedScopes: [...payload.allowedScopes],
    expiresAt,
    ...(payload.truncated === true ? { truncated: true } : {})
  }
}

/** 取消 Push 只允许审批三元组和固定原因，不向 Renderer 暴露 Runtime requestId。 */
function parsePermissionCancellation(payload: unknown): AgentPermissionCancellation | null {
  if (!isPlainRecord(payload) || payload.reason !== 'cancelled') return null
  const approvalId = readPermissionText(payload.approvalId)
  const taskId = readPermissionText(payload.taskId)
  const turnId = readPermissionText(payload.turnId)
  if (!approvalId || !taskId || !turnId) return null
  return { approvalId, taskId, turnId, reason: 'cancelled' }
}

/** Agent 事件 Push 逐字段重建，防止 Main 私有身份、Diff 正文或未知字段进入 Renderer。 */
function parsePublicAgentEvent(payload: unknown): PublicAgentEvent | null {
  if (!isPlainRecord(payload)) return null
  const base = parsePublicAgentEventBase(payload)
  if (!base || typeof payload.kind !== 'string') return null

  switch (payload.kind) {
    case 'agent-message':
    case 'agent-thought': {
      const text = readBoundedText(payload.text, MAX_EVENT_STREAM_BYTES, true)
      const messageId = readOptionalEventText(payload.messageId)
      if (text === null || messageId === null) return null
      return {
        ...base,
        kind: payload.kind,
        text,
        ...(messageId === undefined ? {} : { messageId })
      }
    }
    case 'tool-call': {
      const toolCallId = readBoundedText(payload.toolCallId, MAX_EVENT_FIELD_BYTES)
      const title = readBoundedText(payload.title, MAX_EVENT_FIELD_BYTES, true)
      if (
        !toolCallId ||
        title === null ||
        (payload.status !== undefined && !isOneOf(payload.status, AGENT_TOOL_STATUSES))
      ) {
        return null
      }
      return {
        ...base,
        kind: 'tool-call',
        toolCallId,
        title,
        ...(payload.status === undefined ? {} : { status: payload.status })
      }
    }
    case 'tool-update': {
      const toolCallId = readBoundedText(payload.toolCallId, MAX_EVENT_FIELD_BYTES)
      const title = readOptionalEventText(payload.title)
      if (
        !toolCallId ||
        title === null ||
        (payload.status !== undefined && !isOneOf(payload.status, AGENT_TOOL_STATUSES))
      ) {
        return null
      }
      return {
        ...base,
        kind: 'tool-update',
        toolCallId,
        ...(title === undefined ? {} : { title }),
        ...(payload.status === undefined ? {} : { status: payload.status })
      }
    }
    case 'plan': {
      if (!Array.isArray(payload.entries) || payload.entries.length > MAX_EVENT_PLAN_ENTRIES) {
        return null
      }
      const entries = payload.entries.map(parsePlanEntry)
      if (entries.some((entry) => entry === null)) return null
      return { ...base, kind: 'plan', entries: entries as NonNullable<(typeof entries)[number]>[] }
    }
    case 'diff': {
      if (
        !Array.isArray(payload.references) ||
        payload.references.length > MAX_EVENT_REVIEW_REFERENCES
      ) {
        return null
      }
      const references = payload.references.map(parseDiffReviewReference)
      const toolCallId = readOptionalEventText(payload.toolCallId)
      if (references.some((reference) => reference === null) || toolCallId === null) return null
      return {
        ...base,
        kind: 'diff',
        references: references as PublicAgentDiffReviewReference[],
        ...(toolCallId === undefined ? {} : { toolCallId })
      }
    }
    case 'usage': {
      const usage = parseAgentUsage(payload.usage)
      return usage ? { ...base, kind: 'usage', usage } : null
    }
    case 'turn-complete': {
      const usage = payload.usage === undefined ? undefined : parseTurnUsage(payload.usage)
      if (
        !isOneOf(payload.outcome, AGENT_TURN_OUTCOMES) ||
        (payload.usage !== undefined && !usage)
      ) {
        return null
      }
      return {
        ...base,
        kind: 'turn-complete',
        outcome: payload.outcome,
        ...(usage ? { usage } : {})
      }
    }
    case 'error': {
      const message = readBoundedText(payload.message, MAX_EVENT_FIELD_BYTES, true)
      const code = readOptionalEventText(payload.code)
      if (message === null || typeof payload.recoverable !== 'boolean' || code === null) return null
      return {
        ...base,
        kind: 'error',
        message,
        recoverable: payload.recoverable,
        ...(code === undefined ? {} : { code })
      }
    }
    default:
      return null
  }
}

function parsePublicAgentEventBase(payload: Record<string, unknown>): PublicAgentEventBase | null {
  const taskId = readBoundedText(payload.taskId, MAX_EVENT_FIELD_BYTES)
  const turnId = readBoundedText(payload.turnId, MAX_EVENT_FIELD_BYTES)
  const observedAt = readBoundedText(payload.observedAt, MAX_EVENT_FIELD_BYTES)
  if (
    !isOneOf(payload.runtimeId, AGENT_RUNTIME_IDS) ||
    !isOneOf(payload.capabilityState, AGENT_CAPABILITY_STATES) ||
    !taskId ||
    !turnId ||
    !Number.isSafeInteger(payload.sequence) ||
    (payload.sequence as number) < 1 ||
    !observedAt ||
    !Number.isFinite(Date.parse(observedAt)) ||
    (payload.truncated !== undefined && payload.truncated !== true)
  ) {
    return null
  }
  return {
    runtimeId: payload.runtimeId,
    capabilityState: payload.capabilityState,
    taskId,
    turnId,
    sequence: payload.sequence as number,
    observedAt,
    ...(payload.truncated === true ? { truncated: true } : {})
  }
}

function readOptionalEventText(value: unknown): string | undefined | null {
  return value === undefined ? undefined : readBoundedText(value, MAX_EVENT_FIELD_BYTES, true)
}

function parsePlanEntry(value: unknown): {
  content: string
  priority: 'high' | 'medium' | 'low'
  status: 'pending' | 'in_progress' | 'completed'
} | null {
  if (!isPlainRecord(value)) return null
  const content = readBoundedText(value.content, MAX_EVENT_FIELD_BYTES, true)
  if (
    content === null ||
    !isOneOf(value.priority, AGENT_PLAN_PRIORITIES) ||
    !isOneOf(value.status, AGENT_PLAN_STATUSES)
  ) {
    return null
  }
  return { content, priority: value.priority, status: value.status }
}

function parseDiffReviewReference(value: unknown): PublicAgentDiffReviewReference | null {
  if (
    !isPlainRecord(value) ||
    value.kind !== 'diff-review' ||
    value.availability !== 'unavailable' ||
    !Number.isSafeInteger(value.changedPathCount) ||
    (value.changedPathCount as number) < 0 ||
    !Array.isArray(value.pathSummaries) ||
    value.pathSummaries.length > MAX_EVENT_REVIEW_PATHS ||
    !['git-review-not-implemented', 'source-unavailable', 'history-truncated'].includes(
      String(value.reason)
    )
  ) {
    return null
  }
  const pathSummaries = value.pathSummaries.map((path) =>
    readBoundedText(path, MAX_EVENT_FIELD_BYTES, true)
  )
  if (pathSummaries.some((path) => path === null)) return null
  return {
    kind: 'diff-review',
    availability: 'unavailable',
    changedPathCount: value.changedPathCount as number,
    pathSummaries: pathSummaries as string[],
    reason: value.reason as PublicAgentDiffReviewReference['reason']
  }
}

function parseAgentUsage(
  value: unknown
): Extract<PublicAgentEvent, { kind: 'usage' }>['usage'] | null {
  if (!isPlainRecord(value)) return null
  if (value.scope === 'context') return parseContextUsage(value)
  return parseTurnUsage(value) ?? null
}

function parseContextUsage(
  value: Record<string, unknown>
): Extract<PublicAgentEvent, { kind: 'usage' }>['usage'] | null {
  if (
    value.scope !== 'context' ||
    !isNonNegativeFiniteNumber(value.usedTokens) ||
    !isNonNegativeFiniteNumber(value.limitTokens)
  ) {
    return null
  }
  const cost = parseCost(value.cost)
  if (value.cost !== undefined && !cost) return null
  return {
    scope: 'context',
    usedTokens: value.usedTokens,
    limitTokens: value.limitTokens,
    ...(cost ? { cost } : {})
  }
}

function parseTurnUsage(
  value: unknown
): Extract<PublicAgentEvent, { kind: 'turn-complete' }>['usage'] | null {
  if (
    !isPlainRecord(value) ||
    value.scope !== 'turn' ||
    !isNonNegativeFiniteNumber(value.inputTokens) ||
    !isNonNegativeFiniteNumber(value.outputTokens) ||
    !isNonNegativeFiniteNumber(value.totalTokens) ||
    !isOptionalNonNegativeFiniteNumber(value.thoughtTokens) ||
    !isOptionalNonNegativeFiniteNumber(value.cachedReadTokens) ||
    !isOptionalNonNegativeFiniteNumber(value.cachedWriteTokens)
  ) {
    return null
  }
  const cost = parseCost(value.cost)
  if (value.cost !== undefined && !cost) return null
  return {
    scope: 'turn',
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
    ...(value.thoughtTokens === undefined ? {} : { thoughtTokens: value.thoughtTokens }),
    ...(value.cachedReadTokens === undefined ? {} : { cachedReadTokens: value.cachedReadTokens }),
    ...(value.cachedWriteTokens === undefined
      ? {}
      : { cachedWriteTokens: value.cachedWriteTokens }),
    ...(cost ? { cost } : {})
  }
}

function parseCost(value: unknown): { amount: number; currency: string } | null | undefined {
  if (value === undefined) return undefined
  if (!isPlainRecord(value) || !Number.isFinite(value.amount)) return null
  const currency = readBoundedText(value.currency, MAX_EVENT_FIELD_BYTES)
  return currency ? { amount: value.amount as number, currency } : null
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isOptionalNonNegativeFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isNonNegativeFiniteNumber(value)
}

const CONVERSATION_RESTORE_STATES = [
  'idle',
  'connecting',
  'ready',
  'degraded',
  'unavailable'
] as const
const CONVERSATION_RESTORE_METHODS = ['resume', 'load', 'new-session'] as const
const CONVERSATION_VERIFICATIONS = ['unverified', 'declared', 'verified'] as const

/**
 * 点进对话的恢复状态只重建公开字段；主进程多塞的 runtimeSessionId 等私有键在这里剥掉。
 */
function parseConversationEntryState(value: unknown): ConversationEntryState | null {
  if (!isPlainRecord(value)) return null
  const taskId = readBoundedText(value.taskId, MAX_EVENT_FIELD_BYTES)
  if (!taskId || typeof value.historyReady !== 'boolean') return null
  if (!isOneOf(value.restore, CONVERSATION_RESTORE_STATES)) return null
  if (!isOneOf(value.verification, CONVERSATION_VERIFICATIONS)) return null
  const method =
    value.method === undefined
      ? undefined
      : isOneOf(value.method, CONVERSATION_RESTORE_METHODS)
        ? value.method
        : null
  if (method === null) return null
  const reason =
    value.reason === undefined
      ? undefined
      : readBoundedText(value.reason, MAX_EVENT_FIELD_BYTES, true)
  if (reason === null) return null
  return {
    taskId,
    historyReady: value.historyReady,
    restore: value.restore,
    verification: value.verification,
    ...(method ? { method } : {}),
    ...(reason ? { reason } : {})
  }
}

/** 创建不暴露 channel 或 Electron event 的中性 Agent API。 */
export function createAgentDesktopApi(ipcRenderer: NarrowIpcRenderer): AgentDesktopApi {
  return {
    getStatus: () =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.getStatus) as Promise<
        DesktopIpcResult<AgentRuntimeStatus>
      >,
    getExecutionSnapshot: () =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.getExecutionSnapshot) as Promise<
        DesktopIpcResult<TaskExecutionSnapshot>
      >,
    connect: (projectId) =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.connect, { projectId }) as Promise<
        DesktopIpcResult<AgentRuntimeStatus>
      >,
    disconnect: () =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.disconnect) as Promise<
        DesktopIpcResult<AgentRuntimeStatus>
      >,
    createTask: (projectId) =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.createTask, { projectId }) as Promise<
        DesktopIpcResult<AgentTaskRuntimeState>
      >,
    enterTask: async (taskId) => {
      const result = (await ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.enterTask, {
        taskId
      })) as DesktopIpcResult<unknown>
      if (!result.ok) return result
      const entry = parseConversationEntryState(result.value)
      if (!entry) {
        return {
          ok: false,
          error: { code: 'operation-failed', message: '进入对话的恢复状态无效。' }
        }
      }
      return { ok: true, value: entry }
    },
    startTurn: (taskId, prompt) =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.startTurn, { taskId, prompt }) as Promise<
        DesktopIpcResult<TaskExecutionSnapshot>
      >,
    cancelTurn: (request) =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.cancelTurn, {
        executionId: request.executionId,
        taskId: request.taskId,
        turnId: request.turnId
      }) as Promise<DesktopIpcResult<null>>,
    getTaskRuntimeState: (taskId) =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.getTaskRuntimeState, { taskId }) as Promise<
        DesktopIpcResult<AgentTaskRuntimeState>
      >,
    respondPermission: (request) =>
      ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.respondPermission, {
        approvalId: request.approvalId,
        taskId: request.taskId,
        turnId: request.turnId,
        decision: request.decision
      }) as Promise<DesktopIpcResult<null>>,
    onStatus: (listener) =>
      subscribe<AgentRuntimeStatus>(ipcRenderer, AGENT_PUSH_CHANNELS.status, listener),
    onExecutionUpdate: (listener) =>
      subscribe<TaskExecutionSnapshot>(ipcRenderer, AGENT_PUSH_CHANNELS.executionUpdate, listener),
    onEvent: (listener) =>
      subscribe<PublicAgentEvent>(
        ipcRenderer,
        AGENT_PUSH_CHANNELS.event,
        listener,
        parsePublicAgentEvent
      ),
    onPermission: (listener) =>
      subscribe<AgentPermissionRequest>(
        ipcRenderer,
        AGENT_PUSH_CHANNELS.permission,
        listener,
        parsePermissionRequest
      ),
    onPermissionCancelled: (listener) =>
      subscribe<AgentPermissionCancellation>(
        ipcRenderer,
        AGENT_PUSH_CHANNELS.permissionCancelled,
        listener,
        parsePermissionCancellation
      )
  }
}

/** 创建只包含 Project 注册与历史清理能力的 App API。 */
export function createAppDesktopApi(ipcRenderer: NarrowIpcRenderer): AppDesktopApi {
  return {
    chooseProject: () =>
      ipcRenderer.invoke(APP_INVOKE_CHANNELS.chooseProject) as ReturnType<
        AppDesktopApi['chooseProject']
      >,
    listProjects: () =>
      ipcRenderer.invoke(APP_INVOKE_CHANNELS.listProjects) as ReturnType<
        AppDesktopApi['listProjects']
      >,
    removeProject: (projectId) =>
      ipcRenderer.invoke(APP_INVOKE_CHANNELS.removeProject, { projectId }) as ReturnType<
        AppDesktopApi['removeProject']
      >,
    previewProjectHistoryDeletion: (projectId) =>
      ipcRenderer.invoke(APP_INVOKE_CHANNELS.previewProjectHistoryDeletion, {
        projectId
      }) as ReturnType<AppDesktopApi['previewProjectHistoryDeletion']>,
    deleteProjectHistory: (projectId, token) =>
      ipcRenderer.invoke(APP_INVOKE_CHANNELS.deleteProjectHistory, {
        projectId,
        token
      }) as ReturnType<AppDesktopApi['deleteProjectHistory']>
  }
}

/** 创建不暴露存储路径的 Task 历史 API。 */
export function createTaskDesktopApi(ipcRenderer: NarrowIpcRenderer): TaskDesktopApi {
  return {
    list: (projectId, cursor, limit) =>
      ipcRenderer.invoke(TASK_INVOKE_CHANNELS.list, {
        projectId,
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit })
      }) as ReturnType<TaskDesktopApi['list']>,
    get: (taskId) =>
      ipcRenderer.invoke(TASK_INVOKE_CHANNELS.get, { taskId }) as ReturnType<TaskDesktopApi['get']>,
    listTurns: (taskId, cursor, limit) =>
      ipcRenderer.invoke(TASK_INVOKE_CHANNELS.listTurns, {
        taskId,
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit })
      }) as ReturnType<TaskDesktopApi['listTurns']>,
    listEvents: (taskId, turnId, afterSequence, limit) =>
      ipcRenderer.invoke(TASK_INVOKE_CHANNELS.listEvents, {
        taskId,
        turnId,
        ...(afterSequence === undefined ? {} : { afterSequence }),
        ...(limit === undefined ? {} : { limit })
      }) as ReturnType<TaskDesktopApi['listEvents']>,
    listPermissionAudits: (taskId, cursor, limit) =>
      ipcRenderer.invoke(TASK_INVOKE_CHANNELS.listPermissionAudits, {
        taskId,
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit })
      }) as ReturnType<TaskDesktopApi['listPermissionAudits']>,
    resume: (taskId) =>
      ipcRenderer.invoke(TASK_INVOKE_CHANNELS.resume, { taskId }) as ReturnType<
        TaskDesktopApi['resume']
      >,
    previewDelete: (taskId) =>
      ipcRenderer.invoke(TASK_INVOKE_CHANNELS.previewDelete, { taskId }) as ReturnType<
        TaskDesktopApi['previewDelete']
      >,
    delete: (taskId, token) =>
      ipcRenderer.invoke(TASK_INVOKE_CHANNELS.delete, { taskId, token }) as ReturnType<
        TaskDesktopApi['delete']
      >
  }
}

/** Provider 保持既有请求和响应契约，只收窄底层 ipcRenderer 依赖。 */
export function createProviderDesktopApi(ipcRenderer: NarrowIpcRenderer): ProviderDesktopApi {
  return {
    getSummary: () =>
      ipcRenderer.invoke('provider:get-summary') as ReturnType<ProviderDesktopApi['getSummary']>,
    listModels: (input) =>
      ipcRenderer.invoke('provider:list-models', input) as ReturnType<
        ProviderDesktopApi['listModels']
      >,
    save: (input) =>
      ipcRenderer.invoke('provider:save', input) as ReturnType<ProviderDesktopApi['save']>,
    selectModel: (model) =>
      ipcRenderer.invoke('provider:select-model', model) as ReturnType<
        ProviderDesktopApi['selectModel']
      >,
    clear: () => ipcRenderer.invoke('provider:clear') as ReturnType<ProviderDesktopApi['clear']>
  }
}
