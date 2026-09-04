import type {
  AgentCapabilityState,
  AgentContextUsage,
  AgentOperationType,
  AgentPermissionResolutionReason,
  AgentPlanEntry,
  AgentToolStatus,
  AgentTurnUsage
} from '../../shared/agent'
import type { PublicAgentEvent } from '../../shared/agent-event'
import type { CommandExecutionEvidence, ValidationOutcome } from '../../shared/command'
import { deriveValidationResult } from '../../shared/command'
import type { TaskExecutionSnapshot, TaskExecutionState } from '../../shared/task-execution'
import {
  describeHistoryTruncation,
  type PermissionAuditRecord,
  type TaskHistoryDetail,
  type TurnHistoryRecord,
  type TurnModelSnapshot
} from '../../shared/task-history'
import { isTakeoverControlTurn, type InternalTurnKind } from '../../shared/task-takeover'
import {
  toCommandEvidenceView,
  type TimelineCommandEvidenceView
} from './command-evidence-presentation'
import { isSubagentSpawnTitle } from './subagent-spawn-title'

export type { TimelineCommandEvidenceView }

export interface AdmittedTurnFact {
  taskId: string
  turnId: string
  executionId: string
  promptDisplayText: string
  /** 内部控制 admission 只用于状态关联，不生成用户节点。 */
  turnKind?: InternalTurnKind
  model: TurnModelSnapshot
  acceptedAt: string
  attachmentIds?: string[]
}

export type VersionedFactSlot<T> =
  | { kind: 'empty' }
  | { kind: 'accepted'; revision: number; value: T }
  | { kind: 'conflict'; revision: number }

export type TimelineEventSlot =
  | { kind: 'accepted'; event: PublicAgentEvent }
  | { kind: 'conflict'; sequence: number; observedKinds: PublicAgentEvent['kind'][] }

export type TimelineAuditSlot =
  { kind: 'accepted'; audit: PermissionAuditRecord } | { kind: 'conflict'; auditId: string }

export type TimelineIntegrityIssueCode =
  | 'task-revision-conflict'
  | 'turn-revision-conflict'
  | 'event-sequence-conflict'
  | 'audit-id-conflict'
  | 'identity-mismatch'
  | 'multiple-terminal-events'
  | 'post-terminal-event'
  | 'status-conflict'

export interface TimelineIntegrityIssue {
  code: TimelineIntegrityIssueCode
  taskId: string
  turnId?: string
  sequence?: number
  revision?: number
  auditId?: string
}

export interface TimelineTurnFacts {
  taskId: string
  turnId: string
  admission?: AdmittedTurnFact
  record: VersionedFactSlot<TurnHistoryRecord>
  eventsBySequence: Record<number, TimelineEventSlot>
  auditsById: Record<string, TimelineAuditSlot>
}

export interface TaskTimelineFacts {
  taskId: string
  task: VersionedFactSlot<TaskHistoryDetail>
  turnsById: Record<string, TimelineTurnFacts>
  commandEvidenceById: Record<string, CommandExecutionEvidence>
  commandEvidenceListTruncated?: true
  commandEvidencePersistIncomplete?: true
  integrityIssuesByKey: Record<string, TimelineIntegrityIssue>
}

export type TaskTimelineFactAction =
  | { type: 'task/upsert'; task: TaskHistoryDetail }
  | { type: 'turn/admitted'; admission: AdmittedTurnFact }
  | { type: 'turns/upsert'; turns: readonly TurnHistoryRecord[] }
  | { type: 'events/ingest-public'; events: readonly PublicAgentEvent[] }
  | { type: 'permission-audits/merge'; audits: readonly PermissionAuditRecord[] }
  | {
      type: 'command-evidence/replace'
      evidences: readonly CommandExecutionEvidence[]
      truncated?: true
      persistIncomplete?: true
    }

export type TaskTimelineNode =
  | TimelineTextNode
  | TimelineAttachmentNode
  | TimelinePlanNode
  | TimelineToolNode
  | TimelineAgentGroupNode
  | TimelineCommandNode
  | TimelinePermissionNode
  | TimelineDiffNode
  | TimelineUsageNode
  | TimelineErrorNode
  | TimelineCompletionNode
  | TimelineAvailabilityNode

interface TimelineNodeBase {
  nodeId: string
  taskId: string
  turnId: string
  firstSequence?: number
  source: 'turn-record' | 'agent-event' | 'permission-audit' | 'admission' | 'command-evidence'
  capabilityState?: AgentCapabilityState
  truncated?: true
  /** 公开事件在主进程被观察到的时间，用于主对话显示最近活动。 */
  firstObservedAt?: string
  lastObservedAt?: string
}

export interface TimelineTextNode extends TimelineNodeBase {
  kind: 'user-prompt' | 'message' | 'thought'
  text: string
  attachmentIds?: string[]
}

/** Runtime 图片在时间线中只保留 inbox 引用，实际预览继续走受限 Task IPC。 */
export interface TimelineAttachmentNode extends TimelineNodeBase {
  kind: 'attachment'
  attachmentId: string
  attachmentKind: 'image'
  originalName: string
}

export interface TimelinePlanNode extends TimelineNodeBase {
  kind: 'plan'
  entries: AgentPlanEntry[]
}

export interface TimelineToolNode extends TimelineNodeBase {
  kind: 'tool'
  toolCallId: string
  title: string
  status: AgentToolStatus | 'unknown'
  /** 父 tool 的 toolCallId；缺省或悬空时保持扁平，不得按标题猜树。 */
  parentId?: string
  /** 该 tool 最后一次被接受的 sequence，用来判断 spawn 窗口是否已关闭。 */
  lastSequence?: number
  firstObservedAt?: string
  lastObservedAt?: string
  command?: TimelineCommandEvidenceView
}

/** 子 Agent 根：parentId 孩子，或结构化 `[subagent:` spawn 行。 */
export interface TimelineAgentGroupNode extends TimelineNodeBase {
  kind: 'agent-group'
  toolCallId: string
  title: string
  status: AgentToolStatus | 'unknown'
  parentId?: string
  command?: TimelineCommandEvidenceView
  children: TimelineToolNode[]
  firstObservedAt?: string
  lastObservedAt?: string
  /** 多个 spawn 同时打开，窗口工具无法唯一归属。 */
  groupingHint?: 'ambiguous-parallel'
}

export interface TimelineCommandNode extends TimelineNodeBase {
  kind: 'command-evidence'
  command: TimelineCommandEvidenceView
}

export interface TimelinePermissionNode extends TimelineNodeBase {
  kind: 'permission-audit'
  audit: PermissionAuditRecord
  /** 连续同类静默允许折叠后的条数；人工审批保持 1。 */
  foldedCount: number
  /** 静默允许才有摘要；人工审批卡不走这条，避免 12 张大红牌。 */
  summary?: string
}

export interface TimelineDiffNode extends TimelineNodeBase {
  kind: 'diff-reference'
  changedPathCount: number
  pathSummaries: string[]
  availability: 'unavailable'
  reason: string
}

export interface TimelineUsageNode extends TimelineNodeBase {
  kind: 'usage'
  usage: AgentContextUsage | AgentTurnUsage
}

export interface TimelineErrorNode extends TimelineNodeBase {
  kind: 'error'
  message: string
  recoverable: boolean
  code?: string
}

export interface TimelineCompletionNode extends TimelineNodeBase {
  kind: 'turn-complete'
  outcome: string
}

export interface TimelineAvailabilityNode extends TimelineNodeBase {
  kind: 'availability'
  reason: 'history-truncated' | 'event-truncated' | 'integrity-conflict'
  message: string
}

export interface TurnUsageViewModel {
  turnUsage?: {
    value: AgentTurnUsage
    source: 'turn-record' | 'turn-complete' | 'usage-event'
  }
  contextSamples: AgentContextUsage[]
}

export interface TurnTimelineViewModel {
  taskId: string
  turnId: string
  prompt: string
  model: TurnModelSnapshot
  status: TaskExecutionState | 'pending'
  statusProvisional: boolean
  statusConflict: boolean
  createdAt: string
  dispatchedAt?: string
  endedAt?: string
  /** 当前 Turn 最近一条公开事件的本地观察时间。 */
  lastEventAt?: string
  nodes: TaskTimelineNode[]
  usage: TurnUsageViewModel
  historyTruncated: boolean
  truncationReason?: TurnHistoryRecord['truncationReason']
}

export interface TaskResultReviewModel {
  status: { value: TaskExecutionState | 'pending'; source: 'turn-record' | 'execution' }
  usage: TurnUsageViewModel['turnUsage'] | { availability: 'not-observed' }
  changedPaths: { count: number; availability: 'observed' | 'not-observed' }
  validations: {
    count: number
    availability: 'observed' | 'unavailable' | 'not-observed'
    outcome?: ValidationOutcome
    reason?: string
  }
  artifacts: {
    count: number
    availability: 'observed' | 'unavailable' | 'not-observed'
    reason?: string
  }
  commands: TimelineCommandEvidenceView[]
  warnings: string[]
}

export interface TaskTimelineViewModel {
  taskId: string
  title: string
  turns: TurnTimelineViewModel[]
  resultReview: TaskResultReviewModel
  integrityIssues: TimelineIntegrityIssue[]
}

export interface TimelineSelectorContext {
  executionSnapshot: TaskExecutionSnapshot
}

const TERMINAL_TOOL_STATES = new Set<AgentToolStatus>(['completed', 'failed', 'cancelled'])

const SILENT_PERMISSION_OPERATION_NOUN: Record<AgentOperationType, string> = {
  'read-project': '读取',
  'write-file': '写入',
  'delete-path': '删除',
  'execute-command': '命令',
  'git-read': 'Git 读取',
  'git-mutate': 'Git 变更',
  'worktree-create': 'Worktree 创建',
  'worktree-remove': 'Worktree 移除',
  'network-egress': '出网',
  browser: '浏览器',
  screen: '屏幕',
  clipboard: '剪贴板',
  unknown: '未知操作'
}

/** auto-allowed / grant-reused 才能折叠；user-allowed 等人工结论必须单独可回看。 */
export function isSilentPermissionAuditReason(reason: AgentPermissionResolutionReason): boolean {
  return reason === 'auto-allowed' || reason === 'grant-reused'
}

/** Timeline 折叠摘要，例如「已自动允许 12 次读取」。 */
export function formatSilentPermissionSummary(
  operationType: AgentOperationType,
  count: number
): string {
  return `已自动允许 ${count} 次${SILENT_PERMISSION_OPERATION_NOUN[operationType]}`
}

export function createTaskTimelineFacts(taskId: string): TaskTimelineFacts {
  return {
    taskId,
    task: { kind: 'empty' },
    turnsById: {},
    commandEvidenceById: {},
    integrityIssuesByKey: {}
  }
}

export function reduceTaskTimelineFacts(
  state: TaskTimelineFacts,
  action: TaskTimelineFactAction
): TaskTimelineFacts {
  const next = structuredClone(state)
  if (action.type === 'task/upsert') {
    if (action.task.taskId !== state.taskId)
      return addIssue(next, { code: 'identity-mismatch', taskId: state.taskId })
    next.task = mergeVersioned(
      next.task,
      action.task.revision,
      action.task,
      next,
      'task-revision-conflict'
    )
    return next
  }
  if (action.type === 'turn/admitted') {
    if (action.admission.taskId !== state.taskId)
      return addIssue(next, {
        code: 'identity-mismatch',
        taskId: state.taskId,
        turnId: action.admission.turnId
      })
    const turn = ensureTurn(next, action.admission.turnId)
    turn.admission ??= structuredClone(action.admission)
    return next
  }
  if (action.type === 'turns/upsert') {
    for (const record of action.turns) {
      if (record.taskId !== state.taskId) {
        addIssue(next, { code: 'identity-mismatch', taskId: state.taskId, turnId: record.turnId })
        continue
      }
      const turn = ensureTurn(next, record.turnId)
      turn.record = mergeVersioned(
        turn.record,
        record.revision,
        record,
        next,
        'turn-revision-conflict',
        record.turnId
      )
    }
    return next
  }
  if (action.type === 'events/ingest-public') {
    for (const event of action.events) ingestEvent(next, event)
    return next
  }
  if (action.type === 'command-evidence/replace') {
    next.commandEvidenceById = {}
    if (action.truncated) next.commandEvidenceListTruncated = true
    else delete next.commandEvidenceListTruncated
    if (action.persistIncomplete) next.commandEvidencePersistIncomplete = true
    else delete next.commandEvidencePersistIncomplete
    for (const evidence of action.evidences) {
      if (evidence.taskId !== state.taskId) {
        addIssue(next, {
          code: 'identity-mismatch',
          taskId: state.taskId,
          turnId: evidence.turnId
        })
        continue
      }
      next.commandEvidenceById[evidence.commandId] = structuredClone(evidence)
    }
    return next
  }
  for (const audit of action.audits) ingestAudit(next, audit)
  return next
}

export function selectTaskTimeline(
  facts: TaskTimelineFacts,
  context: TimelineSelectorContext
): TaskTimelineViewModel {
  const turns = Object.values(facts.turnsById)
    .filter((turn) => !isHiddenControlTurn(turn, context.executionSnapshot))
    .map((turn) => selectTurnTimeline(turn, context, facts))
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.turnId.localeCompare(right.turnId)
    )
  const latest = turns.at(-1)
  return {
    taskId: facts.taskId,
    title: facts.task.kind === 'accepted' ? facts.task.value.title : 'Task',
    turns,
    resultReview: selectTaskResultReview(facts, context, latest),
    integrityIssues: Object.values(facts.integrityIssuesByKey)
  }
}

/** 过滤历史标记和实时执行快照中的内部控制 Turn，避免它们生成普通 Timeline 卡片。 */
function isHiddenControlTurn(
  turn: TimelineTurnFacts,
  executionSnapshot: TimelineSelectorContext['executionSnapshot']
): boolean {
  const record = turn.record.kind === 'accepted' ? turn.record.value : undefined
  if (
    isTakeoverControlTurn({
      turnKind: record?.turnKind,
      promptDisplayText: record?.promptDisplayText ?? turn.admission?.promptDisplayText
    })
  ) {
    return true
  }
  const execution = executionSnapshot.execution
  return Boolean(
    execution &&
    execution.taskId === turn.taskId &&
    execution.turnId === turn.turnId &&
    execution.turnKind === 'takeover-control'
  )
}

function selectTurnTimeline(
  turn: TimelineTurnFacts,
  context: TimelineSelectorContext,
  facts: TaskTimelineFacts
): TurnTimelineViewModel {
  const record = turn.record.kind === 'accepted' ? turn.record.value : undefined
  const prompt = record?.promptDisplayText ?? turn.admission?.promptDisplayText ?? '用户指令不可用'
  const model = record?.model ?? turn.admission?.model ?? { modelId: 'unknown' }
  const createdAt = record?.createdAt ?? turn.admission?.acceptedAt ?? ''
  const acceptedEvents = Object.values(turn.eventsBySequence)
    .filter(
      (slot): slot is Extract<TimelineEventSlot, { kind: 'accepted' }> => slot.kind === 'accepted'
    )
    .map((slot) => slot.event)
    .sort((left, right) => left.sequence - right.sequence)
  const terminalEvents = acceptedEvents.filter((event) => event.kind === 'turn-complete')
  const terminalSequence = terminalEvents.at(0)?.sequence
  if (terminalEvents.length > 1)
    addDerivedIssue(facts, {
      code: 'multiple-terminal-events',
      taskId: turn.taskId,
      turnId: turn.turnId
    })
  const trustedEvents = acceptedEvents.filter(
    (event) => terminalSequence == null || event.sequence <= terminalSequence
  )
  if (
    acceptedEvents.some((event) => terminalSequence != null && event.sequence > terminalSequence)
  ) {
    addDerivedIssue(facts, {
      code: 'post-terminal-event',
      taskId: turn.taskId,
      turnId: turn.turnId
    })
  }
  const commands = Object.values(facts.commandEvidenceById).filter(
    (evidence) => evidence.turnId === turn.turnId
  )
  const nodes = projectNodes(turn, trustedEvents, record, commands)
  const status = selectTurnStatus(turn, context.executionSnapshot)
  const execution =
    context.executionSnapshot.execution?.taskId === turn.taskId &&
    context.executionSnapshot.execution.turnId === turn.turnId
      ? context.executionSnapshot.execution
      : undefined
  const dispatchedAt =
    (execution && 'dispatchedAt' in execution ? execution.dispatchedAt : undefined) ??
    record?.dispatchedAt
  const endedAt =
    (execution && 'endedAt' in execution ? execution.endedAt : undefined) ?? record?.endedAt
  const lastEventAt = acceptedEvents.at(-1)?.observedAt
  return {
    taskId: turn.taskId,
    turnId: turn.turnId,
    prompt,
    model,
    status: status.value,
    statusProvisional: status.provisional,
    statusConflict: status.conflict,
    createdAt,
    ...(dispatchedAt ? { dispatchedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(lastEventAt ? { lastEventAt } : {}),
    nodes,
    usage: selectTurnUsage(record, trustedEvents),
    historyTruncated: record?.historyTruncated === true,
    ...(record?.truncationReason ? { truncationReason: record.truncationReason } : {})
  }
}

function projectNodes(
  turn: TimelineTurnFacts,
  events: PublicAgentEvent[],
  record: TurnHistoryRecord | undefined,
  commands: CommandExecutionEvidence[]
): TaskTimelineNode[] {
  const nodes: TaskTimelineNode[] = []
  // 调用方通常已在 selector 层过滤；这里再守一层，防止未来复用时泄露内部 Turn。
  if (
    isTakeoverControlTurn({
      turnKind: record?.turnKind,
      promptDisplayText: record?.promptDisplayText ?? turn.admission?.promptDisplayText
    })
  ) {
    return nodes
  }
  const prompt = record?.promptDisplayText ?? turn.admission?.promptDisplayText
  const promptAttachmentIds = record?.attachmentIds ?? turn.admission?.attachmentIds
  if (prompt || promptAttachmentIds?.length)
    nodes.push({
      nodeId: `${turn.taskId}:${turn.turnId}:user`,
      taskId: turn.taskId,
      turnId: turn.turnId,
      source: record ? 'turn-record' : 'admission',
      kind: 'user-prompt',
      text: prompt ?? '',
      ...(promptAttachmentIds?.length ? { attachmentIds: promptAttachmentIds } : {})
    })
  const messageNodes = new Map<string, TimelineTextNode>()
  let previousAnonymousText:
    | {
        kind: 'agent-message' | 'agent-thought'
        sequence: number
        node: TimelineTextNode
      }
    | undefined
  const tools = new Map<string, TimelineToolNode>()
  for (const event of events) {
    const base = {
      taskId: event.taskId,
      turnId: event.turnId,
      firstSequence: event.sequence,
      source: 'agent-event' as const,
      capabilityState: event.capabilityState,
      firstObservedAt: event.observedAt,
      lastObservedAt: event.observedAt,
      ...(event.truncated ? { truncated: true as const } : {})
    }
    if (event.kind === 'agent-message' || event.kind === 'agent-thought') {
      const key = `${event.taskId}:${event.turnId}:${event.kind}:id:${event.messageId ?? ''}`
      const existing = event.messageId
        ? messageNodes.get(key)
        : previousAnonymousText?.kind === event.kind &&
            previousAnonymousText.sequence + 1 === event.sequence
          ? previousAnonymousText.node
          : undefined
      const node: TimelineTextNode = existing ?? {
        ...base,
        nodeId: key,
        kind: event.kind === 'agent-message' ? 'message' : 'thought',
        text: event.text
      }
      if (existing) node.text += event.text
      else {
        nodes.push(node)
      }
      if (existing) node.lastObservedAt = event.observedAt
      if (event.messageId) {
        messageNodes.set(key, node)
        previousAnonymousText = undefined
      } else {
        // 流式 Runtime 未提供 messageId 时，只合并相邻同类片段，保留工具与消息边界。
        previousAnonymousText = { kind: event.kind, sequence: event.sequence, node }
      }
      continue
    }
    previousAnonymousText = undefined
    if (event.kind === 'agent-attachment') {
      // 同一 messageId 的文本不得跨图片继续拼接，否则图片会被错误挪到整段回复末尾。
      messageNodes.clear()
      nodes.push({
        ...base,
        nodeId: `${event.taskId}:${event.turnId}:attachment:${event.sequence}`,
        kind: 'attachment',
        attachmentId: event.attachmentId,
        attachmentKind: event.attachmentKind,
        originalName: event.originalName
      })
    } else if (event.kind === 'plan') {
      // ACP plan 是整表快照：同一 Turn 只保留一张卡，后到事件原地覆盖 entries。
      const existing = nodes.find(
        (node): node is TimelinePlanNode =>
          node.kind === 'plan' && node.taskId === event.taskId && node.turnId === event.turnId
      )
      if (existing) {
        existing.entries = event.entries.map((entry) => ({ ...entry }))
        existing.capabilityState = event.capabilityState
        if (event.truncated) existing.truncated = true
      } else {
        nodes.push({
          ...base,
          nodeId: `${event.taskId}:${event.turnId}:plan`,
          kind: 'plan',
          entries: event.entries.map((entry) => ({ ...entry }))
        })
      }
    } else if (event.kind === 'tool-call' || event.kind === 'tool-update') {
      const key = `${event.taskId}:${event.turnId}:tool:${event.toolCallId}`
      const existing = tools.get(key)
      if (existing) {
        if (event.title) existing.title = event.title
        const retained = nextRetainedToolStatus(existing.status, event.status)
        if (retained) existing.status = retained
        if (event.parentId) existing.parentId = event.parentId
        existing.lastSequence = event.sequence
        existing.lastObservedAt = event.observedAt
        const matched = matchCommandEvidence(commands, event.toolCallId)
        if (matched) existing.command = toCommandEvidenceView(matched)
      } else {
        const node: TimelineToolNode = {
          ...base,
          nodeId: key,
          kind: 'tool',
          toolCallId: event.toolCallId,
          title: event.title ?? event.toolCallId,
          status: event.status ?? 'unknown',
          lastSequence: event.sequence,
          firstObservedAt: event.observedAt,
          lastObservedAt: event.observedAt,
          ...(event.parentId ? { parentId: event.parentId } : {})
        }
        const matched = matchCommandEvidence(commands, event.toolCallId)
        if (matched) node.command = toCommandEvidenceView(matched)
        tools.set(key, node)
        nodes.push(node)
      }
    } else if (event.kind === 'diff') {
      for (const [index, reference] of event.references.entries())
        nodes.push({
          ...base,
          nodeId: `${event.taskId}:${event.turnId}:diff:${event.sequence}:${index}`,
          kind: 'diff-reference',
          changedPathCount: reference.changedPathCount,
          pathSummaries: [...reference.pathSummaries],
          availability: reference.availability,
          reason: reference.reason
        })
    } else if (event.kind === 'usage') {
      nodes.push({
        ...base,
        nodeId: `${event.taskId}:${event.turnId}:usage:${event.sequence}`,
        kind: 'usage',
        usage: structuredClone(event.usage)
      })
    } else if (event.kind === 'error') {
      nodes.push({
        ...base,
        nodeId: `${event.taskId}:${event.turnId}:error:${event.sequence}`,
        kind: 'error',
        message: event.message,
        recoverable: event.recoverable,
        ...(event.code ? { code: event.code } : {})
      })
    } else if (event.kind === 'turn-complete') {
      nodes.push({
        ...base,
        nodeId: `${event.taskId}:${event.turnId}:complete:${event.sequence}`,
        kind: 'turn-complete',
        outcome: event.outcome
      })
    }
  }
  const lastEventSequence = events.reduce((max, event) => Math.max(max, event.sequence), 0)
  nodes.push(...foldPermissionAuditNodes(turn, lastEventSequence))
  const attachedToolCallIds = new Set(
    [...tools.values()].map((node) => node.command?.commandId).filter(Boolean)
  )
  for (const evidence of commands) {
    if (attachedToolCallIds.has(evidence.commandId)) continue
    if (
      evidence.toolCallId &&
      tools.has(`${turn.taskId}:${turn.turnId}:tool:${evidence.toolCallId}`)
    ) {
      continue
    }
    nodes.push({
      nodeId: `${turn.taskId}:${turn.turnId}:command:${evidence.commandId}`,
      taskId: turn.taskId,
      turnId: turn.turnId,
      source: 'command-evidence',
      kind: 'command-evidence',
      // 无 ACP sequence 的 App 命令放在工具事件之后，避免插到用户指令前面。
      firstSequence: Number.MAX_SAFE_INTEGER,
      command: toCommandEvidenceView(evidence)
    })
  }
  if (record?.historyTruncated)
    nodes.push({
      nodeId: `${turn.taskId}:${turn.turnId}:history-truncated`,
      taskId: turn.taskId,
      turnId: turn.turnId,
      source: 'turn-record',
      kind: 'availability',
      reason: 'history-truncated',
      message: describeHistoryTruncation(record.truncationReason).detail
    })
  return groupAgentToolNodes(nodes.sort(compareTimelineNodes))
}

/**
 * parentId 优先。结构化 `[subagent:` spawn 行即使没有孩子也提升为卡。
 * 标题里随便出现 subagent / 子 Agent 不得聚类。
 * 时间窗口：仅当恰好一个 spawn 在该 sequence 仍打开时才收孩子；并行打开则不抢。
 */
function groupAgentToolNodes(nodes: TaskTimelineNode[]): TaskTimelineNode[] {
  const tools = nodes.filter((node): node is TimelineToolNode => node.kind === 'tool')
  const toolsByCallId = new Map(tools.map((tool) => [tool.toolCallId, tool]))
  const parentRootIds = new Set<string>()
  for (const tool of tools) {
    if (tool.parentId && tool.parentId !== tool.toolCallId && toolsByCallId.has(tool.parentId)) {
      parentRootIds.add(tool.parentId)
    }
  }
  const spawnRoots = tools.filter((tool) => isSubagentSpawnTitle(tool.title))
  const spawnRootIds = new Set(spawnRoots.map((tool) => tool.toolCallId))
  const validRootIds = new Set([...parentRootIds, ...spawnRootIds])
  if (validRootIds.size === 0) return nodes

  const childrenByRoot = new Map<string, TimelineToolNode[]>()
  const absorbedIds = new Set<string>()
  const ambiguousSpawnIds = new Set<string>()

  for (const tool of tools) {
    const parentRoot = resolveAgentGroupRoot(tool, toolsByCallId, parentRootIds)
    if (parentRoot && tool.toolCallId !== parentRoot) {
      absorbedIds.add(tool.toolCallId)
      appendChild(childrenByRoot, parentRoot, tool)
    }
  }

  for (const tool of tools) {
    if (absorbedIds.has(tool.toolCallId) || spawnRootIds.has(tool.toolCallId)) continue
    const sequence = tool.firstSequence ?? 0
    const openSpawns = spawnRoots.filter((spawn) => isSpawnOpenAt(spawn, sequence))
    if (openSpawns.length === 1) {
      const rootId = openSpawns[0]?.toolCallId
      if (!rootId) continue
      absorbedIds.add(tool.toolCallId)
      appendChild(childrenByRoot, rootId, tool)
      continue
    }
    if (openSpawns.length > 1) {
      for (const spawn of openSpawns) ambiguousSpawnIds.add(spawn.toolCallId)
    }
  }

  const grouped: TaskTimelineNode[] = []
  for (const node of nodes) {
    if (node.kind !== 'tool') {
      grouped.push(node)
      continue
    }
    if (absorbedIds.has(node.toolCallId)) continue
    if (!validRootIds.has(node.toolCallId)) {
      grouped.push(node)
      continue
    }
    const children = (childrenByRoot.get(node.toolCallId) ?? []).slice().sort(compareTimelineNodes)
    grouped.push(
      toAgentGroupNode(node, children, {
        groupingHint: ambiguousSpawnIds.has(node.toolCallId) ? 'ambiguous-parallel' : undefined
      })
    )
  }
  return grouped
}

function appendChild(
  childrenByRoot: Map<string, TimelineToolNode[]>,
  rootId: string,
  tool: TimelineToolNode
): void {
  const children = childrenByRoot.get(rootId) ?? []
  children.push(tool)
  childrenByRoot.set(rootId, children)
}

/** spawn 未终态则一直打开；终态后只覆盖 lastSequence 之前的孩子。 */
function isSpawnOpenAt(spawn: TimelineToolNode, sequence: number): boolean {
  const first = spawn.firstSequence ?? 0
  if (sequence < first) return false
  if (spawn.status === 'unknown' || !TERMINAL_TOOL_STATES.has(spawn.status)) return true
  return sequence <= (spawn.lastSequence ?? first)
}

/** 沿 parentId 链走到本 Turn 最外层有效根；中途悬空则停止，避免造空壳。 */
function resolveAgentGroupRoot(
  tool: TimelineToolNode,
  toolsByCallId: Map<string, TimelineToolNode>,
  validRootIds: Set<string>
): string | undefined {
  let current = tool.parentId
  let found: string | undefined
  const seen = new Set<string>()
  while (current && !seen.has(current)) {
    seen.add(current)
    if (!toolsByCallId.has(current)) break
    if (validRootIds.has(current)) found = current
    current = toolsByCallId.get(current)?.parentId
  }
  return found
}

function toAgentGroupNode(
  root: TimelineToolNode,
  children: TimelineToolNode[],
  options?: { groupingHint?: 'ambiguous-parallel' }
): TimelineAgentGroupNode {
  const observed = collectGroupObservedAt(root, children)
  return {
    nodeId: root.nodeId,
    taskId: root.taskId,
    turnId: root.turnId,
    source: root.source,
    ...(root.firstSequence != null ? { firstSequence: root.firstSequence } : {}),
    ...(root.capabilityState ? { capabilityState: root.capabilityState } : {}),
    ...(root.truncated ? { truncated: true as const } : {}),
    kind: 'agent-group',
    toolCallId: root.toolCallId,
    title: root.title,
    status: root.status,
    ...(root.parentId ? { parentId: root.parentId } : {}),
    ...(root.command ? { command: root.command } : {}),
    children,
    ...(observed.firstObservedAt ? { firstObservedAt: observed.firstObservedAt } : {}),
    ...(observed.lastObservedAt ? { lastObservedAt: observed.lastObservedAt } : {}),
    ...(options?.groupingHint ? { groupingHint: options.groupingHint } : {})
  }
}

function collectGroupObservedAt(
  root: TimelineToolNode,
  children: TimelineToolNode[]
): { firstObservedAt?: string; lastObservedAt?: string } {
  const stamps = [root, ...children].flatMap((node) => [node.firstObservedAt, node.lastObservedAt])
  const known = stamps.filter((value): value is string => Boolean(value)).sort()
  return {
    ...(known[0] ? { firstObservedAt: known[0] } : {}),
    ...(known.at(-1) ? { lastObservedAt: known.at(-1) } : {})
  }
}

function compareTimelineNodes(left: TaskTimelineNode, right: TaskTimelineNode): number {
  return (
    (left.firstSequence ?? 0) - (right.firstSequence ?? 0) ||
    left.nodeId.localeCompare(right.nodeId)
  )
}

/**
 * 终态拒绝回退，与 EventNormalizer 一致：历史乱序不得把已完成卡打回 running。
 * in_progress → pending 同样拒绝，避免进度条倒退。
 */
function nextRetainedToolStatus(
  current: AgentToolStatus | 'unknown' | undefined,
  incoming: AgentToolStatus | undefined
): AgentToolStatus | 'unknown' | undefined {
  if (!incoming) return current
  if (current === 'in_progress' && incoming === 'pending') return current
  if (
    current &&
    current !== 'unknown' &&
    TERMINAL_TOOL_STATES.has(current) &&
    incoming !== current
  ) {
    return current
  }
  return incoming
}

function collectNodeCommandViews(node: TaskTimelineNode): TimelineCommandEvidenceView[] {
  if (node.kind === 'command-evidence') return [node.command]
  if (node.kind === 'tool' && node.command) return [node.command]
  if (node.kind === 'agent-group') {
    return [
      ...(node.command ? [node.command] : []),
      ...node.children.flatMap((child) => (child.command ? [child.command] : []))
    ]
  }
  return []
}

function selectTurnUsage(
  record: TurnHistoryRecord | undefined,
  events: PublicAgentEvent[]
): TurnUsageViewModel {
  const contextSamples = events
    .filter(
      (event): event is Extract<PublicAgentEvent, { kind: 'usage' }> =>
        event.kind === 'usage' && event.usage.scope === 'context'
    )
    .map((event) => structuredClone(event.usage) as AgentContextUsage)
  if (record?.usage)
    return {
      turnUsage: { value: structuredClone(record.usage), source: 'turn-record' },
      contextSamples
    }
  const terminal = [...events]
    .reverse()
    .find(
      (event): event is Extract<PublicAgentEvent, { kind: 'turn-complete' }> =>
        event.kind === 'turn-complete' && event.usage?.scope === 'turn'
    )
  if (terminal?.usage)
    return {
      turnUsage: { value: structuredClone(terminal.usage), source: 'turn-complete' },
      contextSamples
    }
  const usage = [...events]
    .reverse()
    .find(
      (event): event is Extract<PublicAgentEvent, { kind: 'usage' }> =>
        event.kind === 'usage' && event.usage.scope === 'turn'
    )
  return {
    ...(usage
      ? {
          turnUsage: {
            value: structuredClone(usage.usage) as AgentTurnUsage,
            source: 'usage-event' as const
          }
        }
      : {}),
    contextSamples
  }
}

function selectTurnStatus(
  turn: TimelineTurnFacts,
  snapshot: TaskExecutionSnapshot
): { value: TaskExecutionState | 'pending'; provisional: boolean; conflict: boolean } {
  const record = turn.record.kind === 'accepted' ? turn.record.value : undefined
  const execution =
    snapshot.execution?.taskId === turn.taskId && snapshot.execution.turnId === turn.turnId
      ? snapshot.execution
      : undefined
  const persisted = record?.state
  const persistedTerminal =
    persisted != null && ['completed', 'failed', 'cancelled', 'interrupted'].includes(persisted)
  const executionTerminal =
    execution != null &&
    ['completed', 'failed', 'cancelled', 'interrupted'].includes(execution.state)
  if (persistedTerminal)
    return {
      value: persisted as TaskExecutionState,
      provisional: false,
      conflict: Boolean(execution && execution.state !== persisted)
    }
  if (execution) return { value: execution.state, provisional: executionTerminal, conflict: false }
  return {
    value: (persisted as TaskExecutionState | 'pending' | undefined) ?? 'pending',
    provisional: false,
    conflict: false
  }
}

function selectTaskResultReview(
  facts: TaskTimelineFacts,
  _context: TimelineSelectorContext,
  latest?: TurnTimelineViewModel
): TaskResultReviewModel {
  const status = latest?.status ?? 'pending'
  const diffNodes =
    latest?.nodes.filter((node): node is TimelineDiffNode => node.kind === 'diff-reference') ?? []
  const record = latest ? facts.turnsById[latest.turnId]?.record : undefined
  const turnRecord = record?.kind === 'accepted' ? record.value : undefined
  const warnings: string[] = []
  if (latest?.historyTruncated)
    warnings.push(describeHistoryTruncation(latest.truncationReason).detail)
  if (latest?.statusConflict) warnings.push('实时执行状态与持久化状态不一致。')
  const commandViews = (latest?.nodes ?? []).flatMap(collectNodeCommandViews)
  const uniqueCommands = dedupeCommandViews(commandViews)
  const latestEvidences = uniqueCommands
    .map((view) => facts.commandEvidenceById[view.commandId])
    .filter((item): item is CommandExecutionEvidence => Boolean(item))
  if (uniqueCommands.some((view) => view.logIncomplete)) {
    warnings.push('部分命令日志不完整。')
  }
  if (facts.commandEvidenceListTruncated) {
    warnings.push('命令证据列表不完整，仅保留最新条目。')
  }
  if (facts.commandEvidencePersistIncomplete) {
    warnings.push('部分命令证据写入失败，审阅不完整。')
  }
  if (uniqueCommands.some((view) => view.inconsistency)) {
    warnings.push('部分命令的标题与退出事实不一致。')
  }
  return {
    status: { value: status, source: latest?.statusProvisional ? 'execution' : 'turn-record' },
    usage: latest?.usage.turnUsage ?? { availability: 'not-observed' },
    changedPaths: diffNodes.length
      ? {
          count: diffNodes.reduce((total, node) => total + node.changedPathCount, 0),
          availability: 'observed'
        }
      : { count: 0, availability: 'not-observed' },
    validations: selectValidationReview(latest, latestEvidences, {
      listIncomplete: Boolean(
        facts.commandEvidenceListTruncated || facts.commandEvidencePersistIncomplete
      )
    }),
    artifacts: turnRecord?.artifactIds?.length
      ? {
          count: turnRecord.artifactIds.length,
          availability: 'observed'
        }
      : { count: 0, availability: 'not-observed' },
    commands: uniqueCommands,
    warnings
  }
}

/**
 * 验证只能来自真实命令证据。没有命令时保持 not-observed，聊天/标题不能产生 pass。
 * 列表截断或落盘缺口时只能 unknown，避免旧成功项假通过。
 */
function selectValidationReview(
  latest: TurnTimelineViewModel | undefined,
  evidences: CommandExecutionEvidence[],
  options: { listIncomplete?: boolean } = {}
): TaskResultReviewModel['validations'] {
  if (evidences.length === 0) {
    if (options.listIncomplete) {
      return {
        count: 0,
        availability: 'observed',
        outcome: 'unknown',
        reason: 'incomplete-list'
      }
    }
    return { count: 0, availability: 'not-observed' }
  }
  const derived = latest
    ? deriveValidationResult(evidences, `val_${latest.taskId}_${latest.turnId}`, options)
    : null
  if (!derived) {
    if (options.listIncomplete) {
      return {
        count: evidences.length,
        availability: 'observed',
        outcome: 'unknown',
        reason: 'incomplete-list'
      }
    }
    return { count: evidences.length, availability: 'not-observed' }
  }
  return {
    count: derived.commandIds.length,
    availability: 'observed',
    outcome: derived.outcome,
    ...(derived.reason ? { reason: derived.reason } : {})
  }
}

function matchCommandEvidence(
  commands: CommandExecutionEvidence[],
  toolCallId: string
): CommandExecutionEvidence | undefined {
  return commands.find((evidence) => evidence.toolCallId === toolCallId)
}

function dedupeCommandViews(views: TimelineCommandEvidenceView[]): TimelineCommandEvidenceView[] {
  const seen = new Set<string>()
  const unique: TimelineCommandEvidenceView[] = []
  for (const view of views) {
    if (seen.has(view.commandId)) continue
    seen.add(view.commandId)
    unique.push(view)
  }
  return unique
}

function ensureTurn(state: TaskTimelineFacts, turnId: string): TimelineTurnFacts {
  return (state.turnsById[turnId] ??= {
    taskId: state.taskId,
    turnId,
    record: { kind: 'empty' },
    eventsBySequence: {},
    auditsById: {}
  })
}

function ingestEvent(state: TaskTimelineFacts, event: PublicAgentEvent): void {
  if (
    event.taskId !== state.taskId ||
    !event.turnId ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1
  ) {
    addIssue(state, { code: 'identity-mismatch', taskId: state.taskId, turnId: event.turnId })
    return
  }
  const turn = ensureTurn(state, event.turnId)
  const existing = turn.eventsBySequence[event.sequence]
  if (!existing) {
    turn.eventsBySequence[event.sequence] = { kind: 'accepted', event: structuredClone(event) }
    return
  }
  if (existing.kind === 'accepted' && canonicalEqual(existing.event, event)) return
  const kinds =
    existing.kind === 'accepted'
      ? [existing.event.kind, event.kind]
      : [...existing.observedKinds, event.kind]
  turn.eventsBySequence[event.sequence] = {
    kind: 'conflict',
    sequence: event.sequence,
    observedKinds: [...new Set(kinds)].sort() as PublicAgentEvent['kind'][]
  }
  addIssue(state, {
    code: 'event-sequence-conflict',
    taskId: state.taskId,
    turnId: event.turnId,
    sequence: event.sequence
  })
}

/**
 * 连续同类静默允许收成一条摘要，并排到事件之后，避免 12 张审计节点顶到用户句前面。
 * 人工审批、拒绝、取消仍各自独立；facts 层 auditsById 保持逐条，不在这里丢审计。
 */
function foldPermissionAuditNodes(
  turn: TimelineTurnFacts,
  lastEventSequence: number
): TimelinePermissionNode[] {
  const accepted = Object.values(turn.auditsById)
    .flatMap((slot) => (slot.kind === 'accepted' ? [slot.audit] : []))
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.auditId.localeCompare(right.auditId)
    )
  const folded: TimelinePermissionNode[] = []
  for (const audit of accepted) {
    const previous = folded.at(-1)
    if (
      previous?.summary &&
      isSilentPermissionAuditReason(audit.reason) &&
      previous.audit.operationType === audit.operationType
    ) {
      previous.foldedCount += 1
      previous.summary = formatSilentPermissionSummary(audit.operationType, previous.foldedCount)
      continue
    }
    const silent = isSilentPermissionAuditReason(audit.reason)
    folded.push({
      nodeId: `${turn.taskId}:${turn.turnId}:audit:${audit.auditId}`,
      taskId: turn.taskId,
      turnId: turn.turnId,
      firstSequence: lastEventSequence + folded.length + 1,
      source: 'permission-audit',
      kind: 'permission-audit',
      audit: structuredClone(audit),
      foldedCount: 1,
      ...(silent ? { summary: formatSilentPermissionSummary(audit.operationType, 1) } : {})
    })
  }
  return folded
}

function ingestAudit(state: TaskTimelineFacts, audit: PermissionAuditRecord): void {
  if (audit.taskId !== state.taskId || !audit.turnId) {
    addIssue(state, { code: 'identity-mismatch', taskId: state.taskId, turnId: audit.turnId })
    return
  }
  const turn = ensureTurn(state, audit.turnId)
  const existing = turn.auditsById[audit.auditId]
  if (!existing)
    turn.auditsById[audit.auditId] = { kind: 'accepted', audit: structuredClone(audit) }
  else if (existing.kind !== 'accepted' || !canonicalEqual(existing.audit, audit)) {
    turn.auditsById[audit.auditId] = { kind: 'conflict', auditId: audit.auditId }
    addIssue(state, {
      code: 'audit-id-conflict',
      taskId: state.taskId,
      turnId: audit.turnId,
      auditId: audit.auditId
    })
  }
}

function mergeVersioned<T extends object>(
  slot: VersionedFactSlot<T>,
  revision: number,
  value: T,
  state: TaskTimelineFacts,
  issueCode: 'task-revision-conflict' | 'turn-revision-conflict',
  turnId?: string
): VersionedFactSlot<T> {
  if (slot.kind === 'empty' || revision > slot.revision)
    return { kind: 'accepted', revision, value: structuredClone(value) }
  if (revision < slot.revision) return slot
  if (slot.kind === 'accepted' && canonicalEqual(slot.value, value)) return slot
  addIssue(state, {
    code: issueCode,
    taskId: state.taskId,
    ...(turnId ? { turnId } : {}),
    revision
  })
  return { kind: 'conflict', revision }
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalStringify(left) === canonicalStringify(right)
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalStringify(nested)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

function addIssue(state: TaskTimelineFacts, issue: TimelineIntegrityIssue): TaskTimelineFacts {
  state.integrityIssuesByKey[issueKey(issue)] = issue
  return state
}

function addDerivedIssue(state: TaskTimelineFacts, issue: TimelineIntegrityIssue): void {
  if (!state.integrityIssuesByKey[issueKey(issue)])
    state.integrityIssuesByKey[issueKey(issue)] = issue
}

function issueKey(issue: TimelineIntegrityIssue): string {
  return [
    issue.code,
    issue.taskId,
    issue.turnId ?? '',
    issue.sequence ?? '',
    issue.revision ?? '',
    issue.auditId ?? ''
  ].join('/')
}
