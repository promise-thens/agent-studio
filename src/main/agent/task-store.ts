import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentEvent,
  AgentRuntimeCapabilitySnapshot,
  AgentRuntimeId,
  AgentTurnOutcome,
  AgentTurnUsage
} from '../../shared/agent'
import type {
  DeletionPreview,
  HistoryExecutionState,
  PersistedAgentEvent,
  PersistedAgentEventPage,
  TaskHistoryDetail,
  TaskHistoryPage,
  TaskHistorySummary,
  TurnHistoryPage,
  TurnHistoryRecord,
  TurnModelSnapshot
} from '../../shared/task-history'
import type {
  TaskExecutionCancellationReason,
  TaskExecutionFailureReason,
  TaskExecutionInterruptionReason,
  TaskExecutionState
} from '../../shared/task-execution'
import type { AgentRuntimeSessionRef } from './agent-runtime-adapter'
import {
  isTakeoverControlTurn,
  readPermissionPromptStyle,
  readTakeoverSnapshot,
  type PermissionPromptStyle,
  type InternalTurnKind
} from '../../shared/task-takeover'
import { ProjectRegistry } from '../project/project-registry'
import { createLocalEnvironmentId } from '../security/permission-policy'
import { AtomicJsonWriter } from '../storage/atomic-json-file'

const TASK_SCHEMA_VERSION = 2
const TURN_SCHEMA_VERSION = 2
const LEGACY_TASK_SCHEMA_VERSION = 1
const LEGACY_TURN_SCHEMA_VERSION = 1
const EVENT_SCHEMA_VERSION = 1
const MAX_TASKS = 500
const MAX_TURNS_PER_TASK = 100
const MAX_EVENTS_PER_TURN = 2_000
const MAX_HISTORY_BYTES = 256 * 1024 * 1024
const MAX_TURN_EVENT_BYTES = 8 * 1024 * 1024
const MAX_EVENT_BYTES = 256 * 1024
const MAX_EVENT_CHUNK_BYTES = 512 * 1024
const MAX_EVENTS_PER_CHUNK = 50
const MAX_RECORD_BYTES = 1024 * 1024
const DELETE_TOKEN_TTL_MS = 5 * 60 * 1000
/** 单个 Turn 最多绑定的 validationId 数；只约束写入路径，避免历史膨胀。 */
const MAX_TURN_VALIDATION_IDS = 32
/** 单个 Turn 最多绑定的 artifactId 数；只约束写入路径。 */
const MAX_TURN_ARTIFACT_IDS = 64

export interface RuntimeCapabilityEvidenceV1 {
  resume: 'unsupported' | 'declared' | 'verified'
  load: 'unsupported' | 'declared' | 'verified'
  observedAt: string
}

interface PersistedRuntimeSessionRefV1 extends AgentRuntimeSessionRef {
  capabilityEvidence: RuntimeCapabilityEvidenceV1
  lastConfirmedAt: string
}

export interface TaskRecordV1 {
  schemaVersion: typeof TASK_SCHEMA_VERSION
  taskId: string
  projectId: string
  runtimeId: AgentRuntimeId
  environment: {
    kind: 'local'
    version: 1
    environmentId: string
    projectId: string
    rootSnapshot: string
  }
  runtimeSession: PersistedRuntimeSessionRefV1
  permissionPolicy: { kind: 'legacy-runtime' }
  title: string
  state: HistoryExecutionState
  activeTurnId?: string
  activeExecutionId?: string
  lastTurnId?: string
  turnCount: number
  createdAt: string
  updatedAt: string
  revision: number
  /** 归档时间；存在即视为已归档，默认 list 省略但 get 仍可读。 */
  archivedAt?: string
  /** 当前 Task 是否完全接管；缺字段读成 false。不是 Broker 沙箱。 */
  takeoverEnabled: boolean
  takeoverUpdatedAt?: string
  /** 非接管时的询问风格；旧 JSON 缺字段读成 assist。 */
  permissionPromptStyle: PermissionPromptStyle
  /** 绑定 session 是否已 applied；缺字段 fail-closed 为 false。 */
  takeoverApplied?: boolean
}

type PersistedExecutionReason =
  TaskExecutionFailureReason | TaskExecutionCancellationReason | TaskExecutionInterruptionReason

interface TurnRecordV1 extends TurnHistoryRecord {
  schemaVersion: typeof TURN_SCHEMA_VERSION
  executionId?: string
  environmentId?: string
  stateChangedAt?: string
  reason?: PersistedExecutionReason
}

interface EventChunkV1 {
  schemaVersion: typeof EVENT_SCHEMA_VERSION
  taskId: string
  turnId: string
  chunkIndex: number
  events: PersistedAgentEvent[]
}

export type AppendEventResult =
  | { kind: 'committed' }
  | { kind: 'duplicate' }
  | { kind: 'repaired' }
  | {
      kind: 'history-truncated'
      reason: NonNullable<TurnHistoryRecord['truncationReason']>
    }

interface NormalizedEventHistory {
  events: PersistedAgentEvent[]
  eventCount: number
  eventBytes: number
}

interface DeleteTokenRecord {
  targetType: DeletionPreview['targetType']
  targetId: string
  revision: number
  expiresAtMs: number
}

type DeletionReservationId = symbol

type TaskMutationOptions = {
  deletionReservationId?: DeletionReservationId
}

type ProjectMutationOptions = {
  deletionReservationId?: DeletionReservationId
}

export interface TaskHistoryDeletionPreparation {
  commit(): Promise<void>
  /** 返回 true 表示物理提交点尚未越过，外层可以同步回滚 Broker 冻结。 */
  rollback(): boolean
}

class TaskDeletionCommitError extends Error {
  constructor(readonly rollbackSafe: boolean) {
    super(rollbackSafe ? '删除提交失败，可安全重试。' : '删除结果无法确认，已保持失败关闭。')
    this.name = 'TaskDeletionCommitError'
  }
}

export type TaskStoreErrorCode =
  | 'history-not-found'
  | 'history-corrupt'
  | 'history-version-unsupported'
  | 'history-capacity-exceeded'
  | 'task-turn-limit-reached'
  | 'deletion-token-invalid'
  | 'invalid-state'

export class TaskStoreError extends Error {
  constructor(
    readonly code: TaskStoreErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'TaskStoreError'
  }
}

export interface TaskStoreOptions {
  projectRegistry: ProjectRegistry
  writer?: AtomicJsonWriter
  now?: () => string
  createId?: () => string
}

export type ExecutionTerminalCommitResult =
  | { kind: 'committed'; taskRevision: number; turnRevision: number }
  | { kind: 'repaired'; taskRevision: number; turnRevision: number }
  | { kind: 'duplicate'; taskRevision: number; turnRevision: number }
  | { kind: 'conflict' | 'stale' }

export interface ExecutionIdentity {
  taskId: string
  turnId: string
  executionId: string
}

export interface TaskHistoryMutationLease {
  release(): void
}

/**
 * 持久化 Project 下的 Task、Turn 与事件块。
 * 每个 Store mutation 串行化，只有磁盘写入成功后才更新内存索引。
 */
export class TaskStore {
  private readonly registry: ProjectRegistry
  private readonly writer: AtomicJsonWriter
  private readonly now: () => string
  private readonly createId: () => string
  private readonly tasks = new Map<string, TaskRecordV1>()
  private readonly unsupportedTasks = new Map<
    string,
    { projectId: string; schemaVersion: number }
  >()
  private readonly taskQueues = new Map<string, Promise<void>>()
  private readonly projectQueues = new Map<string, Promise<void>>()
  private readonly deleteTokens = new Map<string, DeleteTokenRecord>()
  private readonly taskDeletionReservations = new Map<string, DeletionReservationId>()
  private readonly projectDeletionReservations = new Map<string, DeletionReservationId>()
  private readonly taskHistoryMutationReservations = new Map<
    DeletionReservationId,
    { taskId: string; projectId: string }
  >()

  constructor(options: TaskStoreOptions) {
    this.registry = options.projectRegistry
    this.writer = options.writer ?? new AtomicJsonWriter()
    this.now = options.now ?? (() => new Date().toISOString())
    this.createId = options.createId ?? randomUUID
  }

  async initialize(): Promise<void> {
    await this.cleanupDeleting()
    const projects = await this.registry.list()
    for (const project of projects) {
      if (project.availability.state !== 'version-unsupported') {
        await this.scanProject(project.projectId)
      }
    }
    await this.interruptUnfinishedRecords()
  }

  /**
   * 同一 Task 降级开新 Runtime session 时改写绑定，不新建 taskId、不碰历史 Turn。
   */
  async rebindRuntimeSession(
    taskId: string,
    session: AgentRuntimeSessionRef,
    capabilitySnapshot: AgentRuntimeCapabilitySnapshot
  ): Promise<TaskRecordV1> {
    return this.enqueueTask(taskId, async () => {
      const task = this.requireTask(taskId)
      if (task.activeTurnId || task.activeExecutionId) {
        throw new TaskStoreError('invalid-state', '活动 Turn 期间不能重绑 Runtime session。')
      }
      if (
        session.runtimeId !== task.runtimeId ||
        session.workspace !== task.environment.rootSnapshot
      ) {
        throw new TaskStoreError(
          'invalid-state',
          '新 session 必须属于同一 Runtime 与 Project 根目录。'
        )
      }
      const observedAt = this.now()
      const nextTask: TaskRecordV1 = {
        ...task,
        runtimeSession: {
          ...session,
          capabilityEvidence: toCapabilityEvidence(capabilitySnapshot),
          lastConfirmedAt: observedAt
        },
        updatedAt: observedAt,
        revision: task.revision + 1
      }
      await this.writer.write(this.taskPath(nextTask), nextTask)
      this.tasks.set(taskId, nextTask)
      return structuredClone(nextTask)
    })
  }

  getTaskRecord(taskId: string): TaskRecordV1 {
    const record = this.tasks.get(taskId)
    if (!record) throw new TaskStoreError('history-not-found', '未找到指定 Task 历史。')
    return structuredClone(record)
  }

  listTaskRecords(): TaskRecordV1[] {
    return [...this.tasks.values()].map((task) => structuredClone(task))
  }

  async createTask(input: {
    taskId: string
    projectId: string
    root: string
    runtimeId: AgentRuntimeId
    session: AgentRuntimeSessionRef
    capabilitySnapshot: AgentRuntimeCapabilitySnapshot
  }): Promise<TaskRecordV1> {
    return this.enqueueProject(input.projectId, async () => {
      this.assertProjectMutationAllowed(input.projectId)
      await this.ensureTaskCapacity()
      this.assertProjectMutationAllowed(input.projectId)
      const observedAt = this.now()
      const task: TaskRecordV1 = {
        schemaVersion: TASK_SCHEMA_VERSION,
        taskId: input.taskId,
        projectId: input.projectId,
        runtimeId: input.runtimeId,
        environment: {
          kind: 'local',
          version: 1,
          environmentId: createLocalEnvironmentId(input.projectId, input.root),
          projectId: input.projectId,
          rootSnapshot: input.root
        },
        runtimeSession: {
          ...input.session,
          capabilityEvidence: toCapabilityEvidence(input.capabilitySnapshot),
          lastConfirmedAt: observedAt
        },
        permissionPolicy: { kind: 'legacy-runtime' },
        title: '新任务',
        state: 'pending',
        turnCount: 0,
        createdAt: observedAt,
        updatedAt: observedAt,
        revision: 1,
        takeoverEnabled: false,
        permissionPromptStyle: 'assist'
      }
      await this.writer.write(this.taskPath(task), task)
      this.tasks.set(task.taskId, task)
      return structuredClone(task)
    })
  }

  async admitExecutionTurn(input: {
    taskId: string
    turnId: string
    executionId: string
    environmentId: string
    promptDisplayText: string
    model: TurnModelSnapshot
    attachmentIds?: string[]
    turnKind?: InternalTurnKind
  }): Promise<TurnRecordV1> {
    return this.createTurnRecord({
      ...input,
      initialState: 'queued',
      activeExecutionId: input.executionId,
      ...(input.turnKind ? { turnKind: input.turnKind } : {}),
      ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {})
    })
  }

  async createTurn(input: {
    taskId: string
    turnId: string
    promptDisplayText: string
    model: TurnModelSnapshot
    attachmentIds?: string[]
  }): Promise<TurnRecordV1> {
    return this.createTurnRecord({ ...input, initialState: 'pending' })
  }

  /** 附件柜落在 Task 历史目录下，不进用户仓库。 */
  getTaskFilesystemRoot(taskId: string): string {
    return this.taskDirectory(this.requireTask(taskId))
  }

  private async createTurnRecord(input: {
    taskId: string
    turnId: string
    promptDisplayText: string
    model: TurnModelSnapshot
    initialState: Extract<HistoryExecutionState, 'pending' | 'queued'>
    executionId?: string
    environmentId?: string
    activeExecutionId?: string
    attachmentIds?: string[]
    turnKind?: InternalTurnKind
  }): Promise<TurnRecordV1> {
    return this.enqueueTask(input.taskId, async () => {
      const task = this.requireTask(input.taskId)
      if (task.turnCount >= MAX_TURNS_PER_TASK) {
        throw new TaskStoreError('task-turn-limit-reached', '当前 Task 已达到 100 个 Turn 上限。')
      }
      await this.ensureHistoryCapacity(
        Buffer.byteLength(input.promptDisplayText, 'utf8'),
        input.taskId
      )
      const observedAt = this.now()
      if (
        input.executionId &&
        (input.environmentId !== task.environment.environmentId ||
          task.activeTurnId ||
          task.activeExecutionId ||
          task.state === 'running' ||
          task.state === 'waiting-permission' ||
          task.state === 'queued' ||
          task.state === 'cancelling')
      ) {
        throw new TaskStoreError('invalid-state', 'Task 当前状态不允许受理新的执行。')
      }
      const turn: TurnRecordV1 = {
        schemaVersion: TURN_SCHEMA_VERSION,
        turnId: input.turnId,
        taskId: input.taskId,
        promptDisplayText: input.promptDisplayText,
        ...(input.turnKind ? { turnKind: input.turnKind } : {}),
        model: input.model,
        state: input.initialState,
        createdAt: observedAt,
        stateChangedAt: observedAt,
        ...(input.executionId ? { executionId: input.executionId } : {}),
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
        eventCount: 0,
        eventBytes: 0,
        revision: 1,
        ...(input.attachmentIds && input.attachmentIds.length > 0
          ? { attachmentIds: input.attachmentIds }
          : {})
      }
      const nextTask: TaskRecordV1 = {
        ...task,
        title: task.turnCount === 0 ? deriveTaskTitle(input.promptDisplayText) : task.title,
        state: input.initialState,
        activeTurnId: input.turnId,
        ...(input.activeExecutionId ? { activeExecutionId: input.activeExecutionId } : {}),
        lastTurnId: input.turnId,
        turnCount: task.turnCount + 1,
        updatedAt: observedAt,
        revision: task.revision + 1
      }
      await this.writer.write(this.turnPath(nextTask, input.turnId), turn)
      try {
        await this.writer.write(this.taskPath(nextTask), nextTask)
      } catch (error) {
        try {
          await this.writer.removeDurably(this.turnDirectory(nextTask, input.turnId))
        } catch {
          throw new TaskStoreError('history-corrupt', 'Turn admission 提交失败且回滚结果无法确认。')
        }
        throw error
      }
      this.tasks.set(nextTask.taskId, nextTask)
      return turn
    })
  }

  async transitionExecution(
    identity: ExecutionIdentity,
    state: Extract<TaskExecutionState, 'running' | 'waiting-permission' | 'cancelling'>,
    observedAt: string
  ): Promise<void> {
    await this.updateTurn(identity.taskId, identity.turnId, (task, turn) => {
      this.assertExecutionIdentity(task, turn, identity)
      return {
        task: { ...task, state },
        turn: {
          ...turn,
          state,
          stateChangedAt: observedAt,
          ...(state === 'running' && !turn.dispatchedAt ? { dispatchedAt: observedAt } : {})
        }
      }
    })
  }

  async commitExecutionTerminal(
    identity: ExecutionIdentity,
    terminal: {
      state: Extract<TaskExecutionState, 'completed' | 'failed' | 'cancelled' | 'interrupted'>
      endedAt: string
      reason?: PersistedExecutionReason
      usage?: AgentTurnUsage
    }
  ): Promise<ExecutionTerminalCommitResult> {
    return this.enqueueTask(identity.taskId, async () => {
      const task = this.requireTask(identity.taskId)
      const turn = await this.readTurn(task, identity.turnId)
      if (turn.executionId !== identity.executionId) return { kind: 'stale' }

      if (isTerminalHistoryState(turn.state)) {
        if (turn.state !== terminal.state || turn.reason !== terminal.reason) {
          return { kind: 'conflict' }
        }
        if (task.state === terminal.state && !task.activeTurnId && !task.activeExecutionId) {
          return {
            kind: 'duplicate',
            taskRevision: task.revision,
            turnRevision: turn.revision
          }
        }
        const repairedTask = this.toTerminalTask(task, terminal.state, terminal.endedAt)
        await this.writer.write(this.taskPath(repairedTask), repairedTask)
        this.tasks.set(repairedTask.taskId, repairedTask)
        return {
          kind: 'repaired',
          taskRevision: repairedTask.revision,
          turnRevision: turn.revision
        }
      }

      if (!this.matchesExecutionIdentity(task, turn, identity)) return { kind: 'stale' }
      const nextTurn: TurnRecordV1 = {
        ...turn,
        state: terminal.state,
        stateChangedAt: terminal.endedAt,
        endedAt: terminal.endedAt,
        ...(terminal.reason ? { reason: terminal.reason } : {}),
        ...(terminal.usage ? { usage: terminal.usage } : {}),
        revision: turn.revision + 1
      }
      const nextTask = this.toTerminalTask(task, terminal.state, terminal.endedAt)
      await this.writer.write(this.turnPath(task, identity.turnId), nextTurn)
      await this.writer.write(this.taskPath(nextTask), nextTask)
      this.tasks.set(nextTask.taskId, nextTask)
      return {
        kind: 'committed',
        taskRevision: nextTask.revision,
        turnRevision: nextTurn.revision
      }
    })
  }

  private assertExecutionIdentity(
    task: TaskRecordV1,
    turn: TurnRecordV1,
    identity: ExecutionIdentity
  ): void {
    if (!this.matchesExecutionIdentity(task, turn, identity)) {
      throw new TaskStoreError('invalid-state', '执行身份已失效。')
    }
  }

  private matchesExecutionIdentity(
    task: TaskRecordV1,
    turn: TurnRecordV1,
    identity: ExecutionIdentity
  ): boolean {
    return (
      task.taskId === identity.taskId &&
      task.activeTurnId === identity.turnId &&
      task.activeExecutionId === identity.executionId &&
      turn.turnId === identity.turnId &&
      turn.executionId === identity.executionId
    )
  }

  private toTerminalTask(
    task: TaskRecordV1,
    state: Extract<TaskExecutionState, 'completed' | 'failed' | 'cancelled' | 'interrupted'>,
    endedAt: string
  ): TaskRecordV1 {
    const nextTask = {
      ...task,
      state,
      activeTurnId: undefined,
      activeExecutionId: undefined,
      updatedAt: endedAt,
      revision: task.revision + 1
    }
    delete nextTask.activeTurnId
    delete nextTask.activeExecutionId
    return nextTask
  }

  async markTurnDispatched(taskId: string, turnId: string): Promise<void> {
    await this.updateTurn(taskId, turnId, (task, turn) => ({
      task: { ...task, state: 'running' },
      turn: { ...turn, state: 'running', dispatchedAt: this.now() }
    }))
  }

  async setPermissionState(taskId: string, turnId: string, waiting: boolean): Promise<void> {
    await this.updateTurn(taskId, turnId, (task, turn) => ({
      task: { ...task, state: waiting ? 'waiting-permission' : 'running' },
      turn: { ...turn, state: waiting ? 'waiting-permission' : 'running' }
    }))
  }

  async appendEvent(event: PersistedAgentEvent): Promise<AppendEventResult> {
    return this.enqueueTask(event.taskId, async () => {
      if (!isValidPersistedEventIdentity(event, event.taskId, event.turnId)) {
        throw new TaskStoreError('history-corrupt', '事件历史身份或 sequence 无效。')
      }
      const task = this.requireTask(event.taskId)
      const turn = await this.readTurn(task, event.turnId)
      const history = await this.readNormalizedEventHistory(task, turn)
      const existing = history.events.find((candidate) => candidate.sequence === event.sequence)
      if (existing) {
        if (!arePersistedEventsEqual(existing, event)) {
          throw new TaskStoreError('history-corrupt', '同一 Turn 的事件 sequence 对应了不同内容。')
        }
        if (turn.eventCount !== history.eventCount || turn.eventBytes !== history.eventBytes) {
          await this.saveTurn(task, {
            ...turn,
            eventCount: history.eventCount,
            eventBytes: history.eventBytes,
            revision: turn.revision + 1
          })
          return { kind: 'repaired' }
        }
        return { kind: 'duplicate' }
      }

      const serializedBytes = serializedEventBytes(event)
      if (serializedBytes > MAX_EVENT_BYTES) {
        if (!turn.historyTruncated) {
          await this.saveTurn(task, {
            ...turn,
            historyTruncated: true,
            truncationReason: 'event-bytes',
            revision: turn.revision + 1
          })
        }
        return { kind: 'history-truncated', reason: 'event-bytes' }
      }
      if (
        history.eventCount >= MAX_EVENTS_PER_TURN ||
        history.eventBytes + serializedBytes > MAX_TURN_EVENT_BYTES
      ) {
        const reason =
          history.eventCount >= MAX_EVENTS_PER_TURN
            ? ('event-count' as const)
            : ('turn-bytes' as const)
        if (!turn.historyTruncated) {
          await this.saveTurn(task, {
            ...turn,
            eventCount: history.eventCount,
            eventBytes: history.eventBytes,
            historyTruncated: true,
            truncationReason: reason,
            revision: turn.revision + 1
          })
        }
        return { kind: 'history-truncated', reason }
      }

      const chunkIndex = await this.getLastChunkIndex(task, turn.turnId)
      let chunk = await this.readEventChunk(task, turn, chunkIndex)
      if (
        chunk.events.length >= MAX_EVENTS_PER_CHUNK ||
        Buffer.byteLength(JSON.stringify([...chunk.events, event]), 'utf8') > MAX_EVENT_CHUNK_BYTES
      ) {
        chunk = {
          schemaVersion: EVENT_SCHEMA_VERSION,
          taskId: task.taskId,
          turnId: turn.turnId,
          chunkIndex: chunkIndex + 1,
          events: []
        }
      }
      const nextChunk = { ...chunk, events: [...chunk.events, event] }
      await this.writer.write(
        this.eventChunkPath(task, turn.turnId, nextChunk.chunkIndex),
        nextChunk
      )
      await this.saveTurn(task, {
        ...turn,
        eventCount: history.eventCount + 1,
        eventBytes: history.eventBytes + serializedBytes,
        revision: turn.revision + 1
      })
      return { kind: 'committed' }
    })
  }

  async finishTurn(
    taskId: string,
    turnId: string,
    outcome: AgentTurnOutcome,
    usage?: AgentTurnUsage
  ): Promise<void> {
    const state =
      outcome === 'completed' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'failed'
    await this.updateTurn(taskId, turnId, (task, turn) => ({
      task: { ...task, state, activeTurnId: undefined },
      turn: { ...turn, state, endedAt: this.now(), ...(usage ? { usage } : {}) }
    }))
  }

  /**
   * 写入当前 Task 的批准模式快照。这是把审批交给 Grok always-approve，不是 Broker 沙箱。
   * 不 bump schema；旧记录缺 style 已在 parse 时读成 assist。
   */
  async updateTaskPermissionMode(
    taskId: string,
    patch: {
      takeoverEnabled: boolean
      permissionPromptStyle: PermissionPromptStyle
      takeoverApplied: boolean
    }
  ): Promise<TaskRecordV1> {
    return this.enqueueTask(taskId, async () => {
      const task = this.requireTask(taskId)
      const observedAt = this.now()
      const nextTask: TaskRecordV1 = {
        ...task,
        takeoverEnabled: patch.takeoverEnabled === true,
        permissionPromptStyle: patch.permissionPromptStyle === 'ask' ? 'ask' : 'assist',
        takeoverApplied: patch.takeoverApplied === true,
        takeoverUpdatedAt: observedAt,
        updatedAt: observedAt,
        revision: task.revision + 1
      }
      if (!nextTask.takeoverApplied) delete nextTask.takeoverApplied
      await this.writer.write(this.taskPath(nextTask), nextTask)
      this.tasks.set(taskId, nextTask)
      return structuredClone(nextTask)
    })
  }

  /**
   * 只改展示标题。不碰项目文件、Runtime session，也不改变执行状态。
   */
  async renameTask(taskId: string, title: string): Promise<TaskRecordV1> {
    const nextTitle = normalizeTaskTitle(title)
    return this.enqueueTask(taskId, async () => {
      const task = this.requireTask(taskId)
      const observedAt = this.now()
      const nextTask: TaskRecordV1 = {
        ...task,
        title: nextTitle,
        updatedAt: observedAt,
        revision: task.revision + 1
      }
      await this.writer.write(this.taskPath(nextTask), nextTask)
      this.tasks.set(taskId, nextTask)
      return structuredClone(nextTask)
    })
  }

  /**
   * 归档只写 archivedAt，不删历史文件。运行中或等待审批时必须拒绝。
   */
  async archiveTask(taskId: string): Promise<TaskRecordV1> {
    return this.enqueueTask(taskId, async () => {
      const task = this.requireTask(taskId)
      this.assertTaskNotActive(task, '活动 Task 不能归档。')
      if (task.archivedAt) return structuredClone(task)
      const observedAt = this.now()
      const nextTask: TaskRecordV1 = {
        ...task,
        archivedAt: observedAt,
        updatedAt: observedAt,
        revision: task.revision + 1
      }
      await this.writer.write(this.taskPath(nextTask), nextTask)
      this.tasks.set(taskId, nextTask)
      return structuredClone(nextTask)
    })
  }

  async listTasks(projectId: string, cursor?: string, limit = 50): Promise<TaskHistoryPage> {
    const acceptedLimit = clampLimit(limit, 50, 100)
    const all = [...this.tasks.values()]
      .filter((task) => task.projectId === projectId && !task.archivedAt)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    const start = cursor ? Math.max(0, all.findIndex((task) => task.taskId === cursor) + 1) : 0
    const page = all.slice(start, start + acceptedLimit)
    return {
      items: page.map(toTaskSummary),
      ...(start + page.length < all.length ? { nextCursor: page.at(-1)?.taskId } : {})
    }
  }

  getTaskDetail(taskId: string): TaskHistoryDetail {
    const task = this.requireTask(taskId)
    return {
      ...toTaskSummary(task),
      environment: { kind: 'local', projectId: task.projectId },
      permissionPolicy: task.permissionPolicy
    }
  }

  /**
   * 给已有 Turn 覆盖绑定 validationIds。
   * 身份校验只发生在写入路径：读盘仍接受历史里未校验的可选字符串数组，
   * 避免把旧 Turn 标成 corrupt 或上调 TURN_SCHEMA_VERSION。
   */
  async attachTurnValidationIds(
    taskId: string,
    turnId: string,
    validationIds: string[]
  ): Promise<TurnHistoryRecord> {
    if (!isValidIdentifier(taskId) || !isValidIdentifier(turnId)) {
      throw new TaskStoreError('invalid-state', 'Task 或 Turn 身份无效。')
    }
    if (!Array.isArray(validationIds) || validationIds.length > MAX_TURN_VALIDATION_IDS) {
      throw new TaskStoreError('invalid-state', 'validationIds 无效。')
    }
    const seen = new Set<string>()
    for (const validationId of validationIds) {
      if (!isValidIdentifier(validationId) || seen.has(validationId)) {
        throw new TaskStoreError('invalid-state', 'validationIds 无效。')
      }
      seen.add(validationId)
    }

    return this.enqueueTask(taskId, async () => {
      const task = this.requireTask(taskId)
      if (!(await pathExists(this.turnPath(task, turnId)))) {
        throw new TaskStoreError('history-not-found', '未找到指定 Turn 历史。')
      }
      const turn = await this.readTurn(task, turnId)
      const nextTurn: TurnRecordV1 = {
        ...turn,
        revision: turn.revision + 1
      }
      if (validationIds.length === 0) {
        delete nextTurn.validationIds
      } else {
        nextTurn.validationIds = [...validationIds]
      }
      const nextTask: TaskRecordV1 = {
        ...task,
        updatedAt: this.now(),
        revision: task.revision + 1
      }
      await this.writer.write(this.turnPath(task, turnId), nextTurn)
      await this.writer.write(this.taskPath(task), nextTask)
      this.tasks.set(taskId, nextTask)
      return stripTurnSchema(nextTurn)
    })
  }

  /**
   * 给已有 Turn 覆盖绑定 artifactIds。
   * 与 validationIds 一样只校验写入路径，读盘仍接受历史里未校验的可选数组。
   */
  async attachTurnArtifactIds(
    taskId: string,
    turnId: string,
    artifactIds: string[]
  ): Promise<TurnHistoryRecord> {
    if (!isValidIdentifier(taskId) || !isValidIdentifier(turnId)) {
      throw new TaskStoreError('invalid-state', 'Task 或 Turn 身份无效。')
    }
    if (!Array.isArray(artifactIds) || artifactIds.length > MAX_TURN_ARTIFACT_IDS) {
      throw new TaskStoreError('invalid-state', 'artifactIds 无效。')
    }
    const seen = new Set<string>()
    for (const artifactId of artifactIds) {
      if (!isValidIdentifier(artifactId) || seen.has(artifactId)) {
        throw new TaskStoreError('invalid-state', 'artifactIds 无效。')
      }
      seen.add(artifactId)
    }

    return this.enqueueTask(taskId, async () => {
      const task = this.requireTask(taskId)
      if (!(await pathExists(this.turnPath(task, turnId)))) {
        throw new TaskStoreError('history-not-found', '未找到指定 Turn 历史。')
      }
      const turn = await this.readTurn(task, turnId)
      const nextTurn: TurnRecordV1 = {
        ...turn,
        revision: turn.revision + 1
      }
      if (artifactIds.length === 0) {
        delete nextTurn.artifactIds
      } else {
        nextTurn.artifactIds = [...artifactIds]
      }
      const nextTask: TaskRecordV1 = {
        ...task,
        updatedAt: this.now(),
        revision: task.revision + 1
      }
      await this.writer.write(this.turnPath(task, turnId), nextTurn)
      await this.writer.write(this.taskPath(task), nextTask)
      this.tasks.set(taskId, nextTask)
      return stripTurnSchema(nextTurn)
    })
  }

  async listTurns(taskId: string, cursor?: string, limit = 20): Promise<TurnHistoryPage> {
    const task = this.requireTask(taskId)
    const acceptedLimit = clampLimit(limit, 20, 50)
    const turnIds = await fs.readdir(this.turnsDirectory(task)).catch(() => [])
    const turns: TurnRecordV1[] = []
    for (const turnId of turnIds) {
      try {
        const turn = await this.readTurn(task, turnId)
        // 普通 Turn 列表隐藏内部控制命令；历史文件仍保留，便于审计和故障排查。
        if (!isTakeoverControlTurn(turn)) turns.push(turn)
      } catch {
        // 单 Turn 损坏只从列表省略，不阻断同 Task 其它 Turn。
      }
    }
    turns.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const start = cursor ? Math.max(0, turns.findIndex((turn) => turn.turnId === cursor) + 1) : 0
    const page = turns.slice(start, start + acceptedLimit)
    return {
      items: page.map(stripTurnSchema),
      ...(start + page.length < turns.length ? { nextCursor: page.at(-1)?.turnId } : {})
    }
  }

  async listEvents(
    taskId: string,
    turnId: string,
    afterSequence = 0,
    limit = 100
  ): Promise<PersistedAgentEventPage> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new TaskStoreError('history-corrupt', '事件历史查询 sequence 无效。')
    }
    const task = this.requireTask(taskId)
    const turn = await this.readTurn(task, turnId)
    const acceptedLimit = clampLimit(limit, 100, 200)
    const history = await this.readNormalizedEventHistory(task, turn)
    const matching = history.events.filter((event) => event.sequence > afterSequence)
    const page = matching.slice(0, acceptedLimit)
    const finalSequence = page.at(-1)?.sequence ?? afterSequence
    const watermark = history.events.at(-1)?.sequence ?? afterSequence
    return {
      items: page,
      ...(matching.length > page.length ? { nextAfterSequence: finalSequence } : {}),
      watermark
    }
  }

  async previewTaskDeletion(taskId: string): Promise<DeletionPreview> {
    const task = this.requireTask(taskId)
    return this.createDeletionPreview('task', taskId, task.revision, this.taskDirectory(task))
  }

  /**
   * 先原子消费删除 token 并冻结其 revision，Broker 只有在此步骤成功后才能取消审批。
   * rollback 会恢复仍在有效期内的同一 token，便于冻结或磁盘提交失败后安全重试。
   */
  prepareTaskDeletion(taskId: string, token: string): TaskHistoryDeletionPreparation {
    const task = this.requireTask(taskId)
    if (task.activeTurnId || task.state === 'running' || task.state === 'waiting-permission') {
      throw new TaskStoreError('invalid-state', '活动 Task 不能删除历史。')
    }
    if (
      this.taskDeletionReservations.has(taskId) ||
      this.projectDeletionReservations.has(task.projectId) ||
      this.hasTaskHistoryMutation(taskId)
    ) {
      throw new TaskStoreError('invalid-state', 'Task 历史正在删除，请稍后重试。')
    }
    const consumed = this.consumeDeleteToken(token, 'task', taskId, task.revision)
    const reservationId = Symbol(taskId)
    this.taskDeletionReservations.set(taskId, reservationId)
    return this.createDeletionPreparation(
      consumed,
      async () =>
        this.enqueueTask(
          taskId,
          async () => {
            const current = this.requireTask(taskId)
            if (
              current.revision !== consumed.revision ||
              current.activeTurnId ||
              current.state === 'running' ||
              current.state === 'waiting-permission'
            ) {
              throw new TaskStoreError('invalid-state', 'Task 状态已变化，请重新预览删除影响。')
            }
            await this.moveToDeletingAndRemove(this.taskDirectory(current), `task-${taskId}`)
            this.tasks.delete(taskId)
          },
          { deletionReservationId: reservationId }
        ),
      () => {
        if (this.taskDeletionReservations.get(taskId) === reservationId) {
          this.taskDeletionReservations.delete(taskId)
        }
      }
    )
  }

  async deleteTask(taskId: string, token: string): Promise<void> {
    const preparation = this.prepareTaskDeletion(taskId, token)
    try {
      await preparation.commit()
    } catch (error) {
      preparation.rollback()
      throw error
    }
  }

  async previewProjectDeletion(projectId: string): Promise<DeletionPreview> {
    const project = this.registry.getRecord(projectId)
    return this.createDeletionPreview(
      'project-history',
      projectId,
      project.revision,
      join(this.registry.getProjectDirectory(projectId), 'tasks')
    )
  }

  /** Project 历史删除同样先验证 token/revision，再允许外层获取权限冻结 lease。 */
  prepareProjectHistoryDeletion(projectId: string, token: string): TaskHistoryDeletionPreparation {
    const project = this.registry.getRecord(projectId)
    if (
      this.projectDeletionReservations.has(projectId) ||
      [...this.tasks.values()].some(
        (task) => task.projectId === projectId && this.taskDeletionReservations.has(task.taskId)
      ) ||
      this.hasProjectHistoryMutation(projectId)
    ) {
      throw new TaskStoreError('invalid-state', 'Project 历史正在删除，请稍后重试。')
    }
    if (
      [...this.tasks.values()].some(
        (task) =>
          task.projectId === projectId &&
          (task.activeTurnId || task.state === 'running' || task.state === 'waiting-permission')
      )
    ) {
      throw new TaskStoreError('invalid-state', 'Project 中仍有活动 Task，不能删除历史。')
    }
    const consumed = this.consumeDeleteToken(token, 'project-history', projectId, project.revision)
    const reservationId = Symbol(projectId)
    this.projectDeletionReservations.set(projectId, reservationId)
    return this.createDeletionPreparation(
      consumed,
      async () =>
        this.enqueueProject(
          projectId,
          async () => {
            const taskIds = [...this.tasks.values()]
              .filter((task) => task.projectId === projectId)
              .map((task) => task.taskId)
            await Promise.all(
              taskIds.map((taskId) =>
                this.enqueueTask(taskId, async () => undefined, {
                  deletionReservationId: reservationId
                })
              )
            )

            const currentProject = this.registry.getRecord(projectId)
            if (currentProject.revision !== consumed.revision) {
              throw new TaskStoreError('invalid-state', 'Project 状态已变化，请重新预览删除影响。')
            }
            if (
              [...this.tasks.values()].some(
                (task) =>
                  task.projectId === projectId &&
                  (task.activeTurnId ||
                    task.state === 'running' ||
                    task.state === 'waiting-permission')
              )
            ) {
              throw new TaskStoreError('invalid-state', 'Project 中仍有活动 Task，不能删除历史。')
            }
            const tasksPath = join(this.registry.getProjectDirectory(projectId), 'tasks')
            await this.moveToDeletingAndRemove(tasksPath, `project-${projectId}`)
            for (const [taskId, task] of this.tasks) {
              if (task.projectId === projectId) this.tasks.delete(taskId)
            }
          },
          { deletionReservationId: reservationId }
        ),
      () => {
        if (this.projectDeletionReservations.get(projectId) === reservationId) {
          this.projectDeletionReservations.delete(projectId)
        }
      }
    )
  }

  async deleteProjectHistory(projectId: string, token: string): Promise<void> {
    const preparation = this.prepareProjectHistoryDeletion(projectId, token)
    try {
      await preparation.commit()
    } catch (error) {
      preparation.rollback()
      throw error
    }
  }

  /** 权限审计等同属历史目录的写入，必须主动复用 256 MiB 全局容量门禁。 */
  async ensureAdditionalHistoryCapacity(taskId: string, projectedBytes: number): Promise<void> {
    if (!Number.isSafeInteger(projectedBytes) || projectedBytes < 0) {
      throw new TaskStoreError('invalid-state', '历史容量增量无效。')
    }
    const task = this.requireTask(taskId)
    this.assertTaskMutationAllowed(taskId, task.projectId)
    await this.ensureHistoryCapacity(projectedBytes, taskId)
  }

  /**
   * 为独立权限审计等 Task 关联历史写入登记短期 reservation。
   * 删除准备会拒绝已有 reservation，并在 reservation 建立后阻止新的外部历史写入。
   */
  beginTaskHistoryMutation(taskId: string): TaskHistoryMutationLease {
    const task = this.requireTask(taskId)
    this.assertTaskMutationAllowed(taskId, task.projectId)
    const reservationId = Symbol(`history-${taskId}`)
    this.taskHistoryMutationReservations.set(reservationId, {
      taskId,
      projectId: task.projectId
    })
    return {
      release: () => {
        this.taskHistoryMutationReservations.delete(reservationId)
      }
    }
  }

  private async scanProject(projectId: string): Promise<void> {
    const tasksRoot = join(this.registry.getProjectDirectory(projectId), 'tasks')
    const taskEntries = await fs.readdir(tasksRoot, { withFileTypes: true }).catch(() => [])
    for (const entry of taskEntries) {
      if (!entry.isDirectory()) continue
      const taskId = entry.name
      if (!isValidIdentifier(taskId)) {
        await this.quarantine(join(tasksRoot, taskId), 'task', 'identity-mismatch')
        continue
      }
      try {
        const value = await this.writer.read(join(tasksRoot, taskId, 'task.json'), MAX_RECORD_BYTES)
        const parsed = parseTaskRecord(value)
        if (parsed.kind === 'unsupported') {
          this.unsupportedTasks.set(taskId, { projectId, schemaVersion: parsed.schemaVersion })
        } else if (
          parsed.kind === 'valid' &&
          parsed.record.taskId === taskId &&
          parsed.record.projectId === projectId
        ) {
          if (parsed.needsUpgrade) {
            await this.writer.write(join(tasksRoot, taskId, 'task.json'), parsed.record)
          }
          this.tasks.set(parsed.record.taskId, parsed.record)
        } else {
          await this.quarantine(join(tasksRoot, taskId), 'task', 'invalid-fields')
        }
      } catch {
        await this.quarantine(join(tasksRoot, taskId), 'task', 'invalid-json')
      }
    }
  }

  private async interruptUnfinishedRecords(): Promise<void> {
    for (const task of [...this.tasks.values()]) {
      await this.reconcileUnfinishedTask(task)
    }
  }

  /**
   * 启动时以 active Turn 为执行事实交叉修复 Task/Turn。
   * 已持久化终态优先于非终态，未知或缺失的活动 Turn 失败关闭为 interrupted。
   */
  private async reconcileUnfinishedTask(task: TaskRecordV1): Promise<void> {
    const activeTurnId = task.activeTurnId
    if (!activeTurnId) {
      if (!isNonTerminalHistoryState(task.state) || task.state === 'pending') return
      await this.saveRecoveredTask(task, 'interrupted', this.now())
      return
    }

    let turn: TurnRecordV1 | null = null
    try {
      turn = await this.readTurn(task, activeTurnId)
    } catch (error) {
      if (error instanceof TaskStoreError && error.code === 'history-version-unsupported') {
        throw error
      }
      const recoveredAt = this.now()
      await this.saveRecoveredTask(task, 'interrupted', recoveredAt)
      return
    }

    const taskTerminal = isTerminalHistoryState(task.state)
    const turnTerminal = isTerminalHistoryState(turn.state)
    if (taskTerminal && turnTerminal && task.state !== turn.state) {
      throw new TaskStoreError('history-corrupt', 'Task 与 Turn 终态不一致。')
    }

    if (turnTerminal) {
      const terminalState = asTerminalHistoryState(turn.state)
      await this.saveRecoveredTask(task, terminalState, turn.endedAt ?? this.now())
      return
    }

    if (taskTerminal) {
      const terminalState = asTerminalHistoryState(task.state)
      const recoveredAt = task.updatedAt
      await this.saveRecoveredTurn(task, turn, terminalState, recoveredAt)
      await this.saveRecoveredTask(task, terminalState, recoveredAt)
      return
    }

    const recoveredAt = this.now()
    await this.saveRecoveredTurn(task, turn, 'interrupted', recoveredAt)
    await this.saveRecoveredTask(task, 'interrupted', recoveredAt)
  }

  private async saveRecoveredTurn(
    task: TaskRecordV1,
    turn: TurnRecordV1,
    state: Extract<HistoryExecutionState, 'completed' | 'failed' | 'cancelled' | 'interrupted'>,
    recoveredAt: string
  ): Promise<void> {
    if (turn.state === state && turn.endedAt) return
    await this.saveTurn(task, {
      ...turn,
      state,
      stateChangedAt: recoveredAt,
      endedAt: turn.endedAt ?? recoveredAt,
      ...(state === 'interrupted' ? { reason: 'restart-recovery' as const } : {}),
      revision: turn.revision + 1
    })
  }

  private async saveRecoveredTask(
    task: TaskRecordV1,
    state: Extract<HistoryExecutionState, 'completed' | 'failed' | 'cancelled' | 'interrupted'>,
    recoveredAt: string
  ): Promise<void> {
    if (
      task.state === state &&
      task.activeTurnId === undefined &&
      task.activeExecutionId === undefined
    ) {
      return
    }
    const nextTask = {
      ...task,
      state,
      activeTurnId: undefined,
      activeExecutionId: undefined,
      updatedAt: recoveredAt,
      revision: task.revision + 1
    }
    delete nextTask.activeTurnId
    delete nextTask.activeExecutionId
    await this.writer.write(this.taskPath(nextTask), nextTask)
    this.tasks.set(nextTask.taskId, nextTask)
  }

  private async updateTurn(
    taskId: string,
    turnId: string,
    update: (task: TaskRecordV1, turn: TurnRecordV1) => { task: TaskRecordV1; turn: TurnRecordV1 }
  ): Promise<void> {
    await this.enqueueTask(taskId, async () => {
      const task = this.requireTask(taskId)
      const turn = await this.readTurn(task, turnId)
      const updated = update(task, turn)
      const observedAt = this.now()
      const nextTurn = { ...updated.turn, revision: turn.revision + 1 }
      const nextTask = { ...updated.task, updatedAt: observedAt, revision: task.revision + 1 }
      if (nextTask.activeTurnId === undefined) delete nextTask.activeTurnId
      await this.writer.write(this.turnPath(task, turnId), nextTurn)
      await this.writer.write(this.taskPath(task), nextTask)
      this.tasks.set(taskId, nextTask)
    })
  }

  private async saveTurn(task: TaskRecordV1, turn: TurnRecordV1): Promise<void> {
    await this.writer.write(this.turnPath(task, turn.turnId), turn)
  }

  private async readTurn(task: TaskRecordV1, turnId: string): Promise<TurnRecordV1> {
    const directory = this.turnDirectory(task, turnId)
    const path = this.turnPath(task, turnId)
    let parsed: RecordParseResult<TurnRecordV1>
    try {
      parsed = parseTurnRecord(await this.writer.read(path, MAX_RECORD_BYTES))
    } catch {
      await this.quarantine(directory, 'turn', 'invalid-json')
      throw new TaskStoreError('history-corrupt', 'Turn 历史记录损坏。')
    }
    if (parsed.kind === 'unsupported') {
      throw new TaskStoreError('history-version-unsupported', 'Turn 历史版本高于当前客户端。')
    }
    if (
      parsed.kind === 'corrupt' ||
      parsed.record.taskId !== task.taskId ||
      parsed.record.turnId !== turnId
    ) {
      await this.quarantine(directory, 'turn', 'invalid-fields')
      throw new TaskStoreError('history-corrupt', 'Turn 历史记录损坏。')
    }
    if (parsed.needsUpgrade) await this.writer.write(path, parsed.record)
    return parsed.record
  }

  /** 从所有合法事件块重建 Turn 内唯一、有序的持久化事件事实。 */
  private async readNormalizedEventHistory(
    task: TaskRecordV1,
    turn: TurnRecordV1
  ): Promise<NormalizedEventHistory> {
    const eventFiles = (await fs.readdir(this.eventsDirectory(task, turn.turnId)).catch(() => []))
      .filter((name) => /^\d{6}\.json$/.test(name))
      .sort()
    const eventsBySequence = new Map<number, PersistedAgentEvent>()

    for (const eventFile of eventFiles) {
      const path = join(this.eventsDirectory(task, turn.turnId), eventFile)
      try {
        const parsed = parseEventChunk(
          await this.writer.read(path, MAX_EVENT_CHUNK_BYTES * 2),
          task.taskId,
          turn.turnId
        )
        if (parsed.kind === 'unsupported') {
          throw new TaskStoreError('history-version-unsupported', '事件历史版本高于当前客户端。')
        }
        if (parsed.kind === 'corrupt') {
          await this.quarantine(path, 'event-chunk', 'invalid-fields')
          continue
        }
        for (const event of parsed.record.events) {
          const existing = eventsBySequence.get(event.sequence)
          if (existing && !arePersistedEventsEqual(existing, event)) {
            throw new TaskStoreError(
              'history-corrupt',
              '同一 Turn 的事件 sequence 对应了不同内容。'
            )
          }
          if (!existing) eventsBySequence.set(event.sequence, event)
        }
      } catch (error) {
        if (error instanceof TaskStoreError) throw error
        await this.quarantine(path, 'event-chunk', 'invalid-json')
      }
    }

    const events = [...eventsBySequence.values()].sort(
      (left, right) => left.sequence - right.sequence
    )
    return {
      events,
      eventCount: events.length,
      eventBytes: events.reduce((total, event) => total + serializedEventBytes(event), 0)
    }
  }

  private async readEventChunk(
    task: TaskRecordV1,
    turn: TurnRecordV1,
    chunkIndex: number
  ): Promise<EventChunkV1> {
    const path = this.eventChunkPath(task, turn.turnId, chunkIndex)
    try {
      const parsed = parseEventChunk(
        await this.writer.read(path, MAX_EVENT_CHUNK_BYTES * 2),
        task.taskId,
        turn.turnId
      )
      if (parsed.kind === 'unsupported') {
        throw new TaskStoreError('history-version-unsupported', '事件历史版本高于当前客户端。')
      }
      if (parsed.kind === 'corrupt') {
        await this.quarantine(path, 'event-chunk', 'invalid-fields')
        throw new TaskStoreError('history-corrupt', '事件历史记录损坏。')
      }
      return parsed.record
    } catch (error) {
      if (isFileNotFound(error)) return createEmptyChunk(task.taskId, turn.turnId, chunkIndex)
      if (error instanceof TaskStoreError) throw error
      await this.quarantine(path, 'event-chunk', 'invalid-json')
      throw new TaskStoreError('history-corrupt', '事件历史记录损坏。')
    }
  }

  private async getLastChunkIndex(task: TaskRecordV1, turnId: string): Promise<number> {
    const files = (await fs.readdir(this.eventsDirectory(task, turnId)).catch(() => []))
      .filter((name) => /^\d{6}\.json$/.test(name))
      .sort()
    const last = files.at(-1)
    return last ? Number.parseInt(last.slice(0, 6), 10) : 1
  }

  private async ensureTaskCapacity(): Promise<void> {
    if (this.tasks.size < MAX_TASKS) return
    await this.evictOldestTerminalTask()
    if (this.tasks.size >= MAX_TASKS) {
      throw new TaskStoreError('history-capacity-exceeded', 'Task 历史已达到 500 个上限。')
    }
  }

  private async ensureHistoryCapacity(
    projectedBytes: number,
    protectedTaskId?: string
  ): Promise<void> {
    let total = await directoryUsage(this.registry.historyRoot)
    while (total + projectedBytes > MAX_HISTORY_BYTES) {
      const removed = await this.evictOldestTerminalTask(protectedTaskId)
      if (!removed) {
        throw new TaskStoreError('history-capacity-exceeded', '历史容量已达到 256 MiB 上限。')
      }
      total = await directoryUsage(this.registry.historyRoot)
    }
  }

  private async evictOldestTerminalTask(protectedTaskId?: string): Promise<boolean> {
    const candidates = [...this.tasks.values()]
      .filter(
        (task) =>
          task.taskId !== protectedTaskId &&
          !this.taskDeletionReservations.has(task.taskId) &&
          !this.projectDeletionReservations.has(task.projectId) &&
          !this.hasTaskHistoryMutation(task.taskId) &&
          !task.activeTurnId &&
          ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.state)
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    for (const candidate of candidates) {
      // 正在写入的 Task 不参与本轮淘汰，避免跨 Task 队列互等形成死锁。
      if (this.taskQueues.has(candidate.taskId)) continue
      const reservationId = Symbol(`evict-${candidate.taskId}`)
      this.taskDeletionReservations.set(candidate.taskId, reservationId)
      try {
        const removed = await this.enqueueTask(
          candidate.taskId,
          async () => {
            const current = this.tasks.get(candidate.taskId)
            if (
              !current ||
              current.taskId === protectedTaskId ||
              this.projectDeletionReservations.has(current.projectId) ||
              this.hasTaskHistoryMutation(current.taskId) ||
              current.activeTurnId ||
              !['completed', 'failed', 'cancelled', 'interrupted'].includes(current.state)
            ) {
              return false
            }
            await this.moveToDeletingAndRemove(
              this.taskDirectory(current),
              `evicted-${current.taskId}`
            )
            this.tasks.delete(current.taskId)
            return true
          },
          { deletionReservationId: reservationId }
        )
        if (removed) return true
      } finally {
        if (this.taskDeletionReservations.get(candidate.taskId) === reservationId) {
          this.taskDeletionReservations.delete(candidate.taskId)
        }
      }
    }
    return false
  }

  private async createDeletionPreview(
    targetType: DeletionPreview['targetType'],
    targetId: string,
    revision: number,
    path: string
  ): Promise<DeletionPreview> {
    const stats = await inspectDirectory(path)
    const token = this.createId()
    const expiresAtMs = Date.now() + DELETE_TOKEN_TTL_MS
    this.deleteTokens.set(token, { targetType, targetId, revision, expiresAtMs })
    return {
      targetType,
      targetId,
      revision,
      fileCount: stats.fileCount,
      turnCount:
        targetType === 'task'
          ? this.requireTask(targetId).turnCount
          : [...this.tasks.values()]
              .filter((task) => task.projectId === targetId)
              .reduce((sum, task) => sum + task.turnCount, 0),
      bytes: stats.bytes,
      exclusions: ['项目目录', 'Git Worktree', 'Runtime 原生历史'],
      token,
      expiresAt: new Date(expiresAtMs).toISOString()
    }
  }

  private consumeDeleteToken(
    token: string,
    targetType: DeletionPreview['targetType'],
    targetId: string,
    revision: number
  ): DeleteTokenRecord & { token: string } {
    const record = this.deleteTokens.get(token)
    this.deleteTokens.delete(token)
    if (
      !record ||
      record.targetType !== targetType ||
      record.targetId !== targetId ||
      record.revision !== revision ||
      record.expiresAtMs < Date.now()
    ) {
      throw new TaskStoreError('deletion-token-invalid', '删除确认已过期，请重新预览影响。')
    }
    return { ...record, token }
  }

  /** 删除准备只允许提交或回滚一次，避免同一 token 被重复恢复或重复删除。 */
  private createDeletionPreparation(
    consumed: DeleteTokenRecord & { token: string },
    commitDeletion: () => Promise<void>,
    releaseReservation: () => void
  ): TaskHistoryDeletionPreparation {
    let state: 'prepared' | 'committing' | 'committed' | 'failed-closed' | 'rolled-back' =
      'prepared'
    let commitPromise: Promise<void> | undefined
    return {
      commit: async () => {
        if (state === 'committed') return
        if (state === 'rolled-back') {
          throw new TaskStoreError('invalid-state', '删除准备已回滚。')
        }
        if (commitPromise) return commitPromise
        state = 'committing'
        commitPromise = commitDeletion()
          .then(() => {
            state = 'committed'
            releaseReservation()
          })
          .catch((error) => {
            if (error instanceof TaskDeletionCommitError && !error.rollbackSafe) {
              state = 'failed-closed'
            } else {
              state = 'prepared'
              commitPromise = undefined
            }
            throw error
          })
        return commitPromise
      },
      rollback: () => {
        if (state === 'rolled-back') return true
        if (state !== 'prepared') return false
        state = 'rolled-back'
        releaseReservation()
        if (consumed.expiresAtMs >= Date.now() && !this.deleteTokens.has(consumed.token)) {
          this.deleteTokens.set(consumed.token, {
            targetType: consumed.targetType,
            targetId: consumed.targetId,
            revision: consumed.revision,
            expiresAtMs: consumed.expiresAtMs
          })
        }
        return true
      }
    }
  }

  private async moveToDeletingAndRemove(source: string, label: string): Promise<void> {
    const deletingRoot = join(this.registry.historyRoot, 'deleting')
    await this.writer.ensureDirectory(deletingRoot)
    const target = join(deletingRoot, `${label}-${this.createId()}`)
    try {
      await this.writer.renameDurably(source, target)
    } catch (error) {
      let sourceExists: boolean
      let targetExists: boolean
      try {
        ;[sourceExists, targetExists] = await Promise.all([pathExists(source), pathExists(target)])
      } catch {
        throw new TaskDeletionCommitError(false)
      }
      if (!sourceExists && targetExists) {
        // rename 已完成但目录同步失败时仍视为不可逆提交，禁止上层恢复删除 token。
      } else if (isFileNotFound(error)) {
        return
      } else {
        throw new TaskDeletionCommitError(sourceExists)
      }
    }
    // rename 是删除提交点；后续清理失败时目标保留在 deleting，启动时继续重试。
    await this.writer.removeDurably(target).catch(() => undefined)
  }

  private async cleanupDeleting(): Promise<void> {
    const deletingRoot = join(this.registry.historyRoot, 'deleting')
    await this.writer.ensureDirectory(deletingRoot)
    const entries = await fs.readdir(deletingRoot).catch(() => [])
    for (const entry of entries)
      await this.writer.removeDurably(join(deletingRoot, entry)).catch(() => undefined)
  }

  /** 运行中、等待审批或仍有活动 Turn/execution 时禁止归档。 */
  private assertTaskNotActive(task: TaskRecordV1, message: string): void {
    if (
      task.activeTurnId ||
      task.activeExecutionId ||
      task.state === 'running' ||
      task.state === 'waiting-permission'
    ) {
      throw new TaskStoreError('invalid-state', message)
    }
  }

  private requireTask(taskId: string): TaskRecordV1 {
    if (this.unsupportedTasks.has(taskId)) {
      throw new TaskStoreError('history-version-unsupported', '该 Task 历史版本高于当前客户端。')
    }
    const task = this.tasks.get(taskId)
    if (!task) throw new TaskStoreError('history-not-found', '未找到指定 Task 历史。')
    return task
  }

  private taskDirectory(task: Pick<TaskRecordV1, 'projectId' | 'taskId'>): string {
    return join(this.registry.getProjectDirectory(task.projectId), 'tasks', task.taskId)
  }

  private taskPath(task: Pick<TaskRecordV1, 'projectId' | 'taskId'>): string {
    return join(this.taskDirectory(task), 'task.json')
  }

  private turnsDirectory(task: Pick<TaskRecordV1, 'projectId' | 'taskId'>): string {
    return join(this.taskDirectory(task), 'turns')
  }

  private turnDirectory(task: Pick<TaskRecordV1, 'projectId' | 'taskId'>, turnId: string): string {
    return join(this.turnsDirectory(task), turnId)
  }

  private turnPath(task: Pick<TaskRecordV1, 'projectId' | 'taskId'>, turnId: string): string {
    return join(this.turnDirectory(task, turnId), 'turn.json')
  }

  private eventsDirectory(
    task: Pick<TaskRecordV1, 'projectId' | 'taskId'>,
    turnId: string
  ): string {
    return join(this.turnDirectory(task, turnId), 'events')
  }

  private eventChunkPath(
    task: Pick<TaskRecordV1, 'projectId' | 'taskId'>,
    turnId: string,
    index: number
  ): string {
    return join(this.eventsDirectory(task, turnId), `${String(index).padStart(6, '0')}.json`)
  }

  private async enqueueTask<T>(
    taskId: string,
    operation: () => Promise<T>,
    options: TaskMutationOptions = {}
  ): Promise<T> {
    const task = this.tasks.get(taskId)
    this.assertTaskMutationAllowed(taskId, task?.projectId, options.deletionReservationId)
    const previous = this.taskQueues.get(taskId) ?? Promise.resolve()
    let result: T
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const task = this.tasks.get(taskId)
        this.assertTaskMutationAllowed(taskId, task?.projectId, options.deletionReservationId)
        result = await operation()
      })
    this.taskQueues.set(taskId, current)
    try {
      await current
      return result!
    } finally {
      if (this.taskQueues.get(taskId) === current) this.taskQueues.delete(taskId)
    }
  }

  private async enqueueProject<T>(
    projectId: string,
    operation: () => Promise<T>,
    options: ProjectMutationOptions = {}
  ): Promise<T> {
    this.assertProjectMutationAllowed(projectId, options.deletionReservationId)
    const previous = this.projectQueues.get(projectId) ?? Promise.resolve()
    let result: T
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        this.assertProjectMutationAllowed(projectId, options.deletionReservationId)
        result = await operation()
      })
    this.projectQueues.set(projectId, current)
    try {
      await current
      return result!
    } finally {
      if (this.projectQueues.get(projectId) === current) this.projectQueues.delete(projectId)
    }
  }

  /** 删除 reservation 存在时，只有持有同一 leaseId 的删除提交可以进入写队列。 */
  private assertTaskMutationAllowed(
    taskId: string,
    projectId?: string,
    deletionReservationId?: DeletionReservationId
  ): void {
    const taskReservation = this.taskDeletionReservations.get(taskId)
    const projectReservation = projectId
      ? this.projectDeletionReservations.get(projectId)
      : undefined
    if (
      (taskReservation && taskReservation !== deletionReservationId) ||
      (projectReservation && projectReservation !== deletionReservationId)
    ) {
      throw new TaskStoreError('invalid-state', 'Task 历史正在删除，不能继续写入。')
    }
  }

  private assertProjectMutationAllowed(
    projectId: string,
    deletionReservationId?: DeletionReservationId
  ): void {
    const reservation = this.projectDeletionReservations.get(projectId)
    if (reservation && reservation !== deletionReservationId) {
      throw new TaskStoreError('invalid-state', 'Project 历史正在删除，不能创建新 Task。')
    }
  }

  private hasTaskHistoryMutation(taskId: string): boolean {
    return [...this.taskHistoryMutationReservations.values()].some(
      (reservation) => reservation.taskId === taskId
    )
  }

  private hasProjectHistoryMutation(projectId: string): boolean {
    return [...this.taskHistoryMutationReservations.values()].some(
      (reservation) => reservation.projectId === projectId
    )
  }

  /** 隔离仅保存有限原因枚举；Runtime 原始错误和历史内容不会复制到说明文件。 */
  private async quarantine(
    source: string,
    label: string,
    reason: 'invalid-json' | 'invalid-fields' | 'identity-mismatch'
  ): Promise<void> {
    const quarantineRoot = join(this.registry.historyRoot, 'quarantine')
    await this.writer.ensureDirectory(quarantineRoot)
    const target = join(quarantineRoot, `${Date.now()}-${label}-${this.createId()}`)
    try {
      await this.writer.renameDurably(source, target)
      await this.writer.write(`${target}.reason.json`, { reason })
    } catch (error) {
      if (!isFileNotFound(error)) throw error
    }
  }
}

function toTaskSummary(task: TaskRecordV1): TaskHistorySummary {
  const resumeCapability = task.runtimeSession.capabilityEvidence
  const resumable =
    resumeCapability.resume !== 'unsupported' || resumeCapability.load !== 'unsupported'
  return {
    taskId: task.taskId,
    projectId: task.projectId,
    runtimeId: task.runtimeId,
    title: task.title,
    state: task.state,
    turnCount: task.turnCount,
    resumable,
    ...(!resumable ? { resumeMessage: 'Runtime 未声明可用的会话恢复能力。' } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    revision: task.revision,
    ...(task.archivedAt ? { archived: true as const } : {})
  }
}

function stripTurnSchema(turn: TurnRecordV1): TurnHistoryRecord {
  return {
    turnId: turn.turnId,
    taskId: turn.taskId,
    promptDisplayText: turn.promptDisplayText,
    ...(turn.turnKind ? { turnKind: turn.turnKind } : {}),
    model: turn.model,
    state: turn.state,
    createdAt: turn.createdAt,
    ...(turn.dispatchedAt ? { dispatchedAt: turn.dispatchedAt } : {}),
    ...(turn.endedAt ? { endedAt: turn.endedAt } : {}),
    ...(turn.usage ? { usage: turn.usage } : {}),
    ...(turn.historyTruncated ? { historyTruncated: true } : {}),
    ...(turn.truncationReason ? { truncationReason: turn.truncationReason } : {}),
    eventCount: turn.eventCount,
    eventBytes: turn.eventBytes,
    ...(turn.attachmentIds ? { attachmentIds: turn.attachmentIds } : {}),
    ...(turn.artifactIds ? { artifactIds: turn.artifactIds } : {}),
    ...(turn.validationIds ? { validationIds: turn.validationIds } : {}),
    revision: turn.revision
  }
}

function toCapabilityEvidence(
  snapshot: AgentRuntimeCapabilitySnapshot
): RuntimeCapabilityEvidenceV1 {
  return {
    resume: mapCapabilityEvidence(snapshot.capabilities['session.resume']),
    load: mapCapabilityEvidence(snapshot.capabilities['session.load']),
    observedAt: snapshot.observedAt
  }
}

function mapCapabilityEvidence(
  capability: AgentRuntimeCapabilitySnapshot['capabilities']['session.resume']
): 'unsupported' | 'declared' | 'verified' {
  if (capability.support !== 'native') return 'unsupported'
  return capability.verification === 'verified' ? 'verified' : 'declared'
}

const MAX_TASK_TITLE_BYTES = 4 * 1024

/** 重命名标题必须可展示：去空白、禁 NUL、限制大小。 */
function normalizeTaskTitle(title: string): string {
  if (typeof title !== 'string' || title.includes('\0')) {
    throw new TaskStoreError('invalid-state', 'Task 标题无效。')
  }
  const trimmed = title.trim()
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > MAX_TASK_TITLE_BYTES) {
    throw new TaskStoreError('invalid-state', 'Task 标题无效。')
  }
  return trimmed
}

function deriveTaskTitle(prompt: string): string {
  const compact = prompt.replace(/\s+/g, ' ').trim()
  return compact ? [...compact].slice(0, 80).join('') : '新任务'
}

function clampLimit(value: number, defaultValue: number, max: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : defaultValue
}

function createEmptyChunk(taskId: string, turnId: string, chunkIndex: number): EventChunkV1 {
  return { schemaVersion: EVENT_SCHEMA_VERSION, taskId, turnId, chunkIndex, events: [] }
}

type RecordParseResult<T> =
  | { kind: 'valid'; record: T; needsUpgrade?: boolean }
  | { kind: 'unsupported'; schemaVersion: number }
  | { kind: 'corrupt' }

function parseTaskRecord(value: unknown): RecordParseResult<TaskRecordV1> {
  const version = readCompatibleSchemaVersion(
    value,
    TASK_SCHEMA_VERSION,
    LEGACY_TASK_SCHEMA_VERSION
  )
  if (version.kind === 'unsupported' || version.kind === 'corrupt') return version
  if (!isRecord(value) || !isValidIdentifier(value.taskId) || !isValidIdentifier(value.projectId)) {
    return { kind: 'corrupt' }
  }
  if (!['grok', 'codex'].includes(String(value.runtimeId)) || !isRecord(value.runtimeSession)) {
    return { kind: 'corrupt' }
  }
  if (
    value.runtimeSession.runtimeId !== value.runtimeId ||
    typeof value.runtimeSession.runtimeSessionId !== 'string' ||
    typeof value.runtimeSession.workspace !== 'string' ||
    !isRecord(value.environment) ||
    value.environment.kind !== 'local' ||
    value.environment.projectId !== value.projectId ||
    typeof value.environment.rootSnapshot !== 'string'
  ) {
    return { kind: 'corrupt' }
  }
  if (
    typeof value.title !== 'string' ||
    !isHistoryState(value.state) ||
    !Number.isSafeInteger(value.turnCount) ||
    Number(value.turnCount) < 0 ||
    Number(value.turnCount) > MAX_TURNS_PER_TASK ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    (value.activeTurnId !== undefined && !isValidIdentifier(value.activeTurnId)) ||
    (value.activeExecutionId !== undefined && !isValidIdentifier(value.activeExecutionId)) ||
    (value.lastTurnId !== undefined && !isValidIdentifier(value.lastTurnId)) ||
    (value.archivedAt !== undefined && !isIsoTimestamp(value.archivedAt))
  ) {
    return { kind: 'corrupt' }
  }
  const environmentId =
    version.schemaVersion === LEGACY_TASK_SCHEMA_VERSION
      ? createLocalEnvironmentId(value.projectId, value.environment.rootSnapshot)
      : value.environment.environmentId
  if (
    typeof environmentId !== 'string' ||
    environmentId !== createLocalEnvironmentId(value.projectId, value.environment.rootSnapshot) ||
    (version.schemaVersion === TASK_SCHEMA_VERSION &&
      (value.environment.version !== 1 || typeof value.environment.environmentId !== 'string'))
  ) {
    return { kind: 'corrupt' }
  }
  const takeover = readTakeoverSnapshot(value)
  const permissionPromptStyle = readPermissionPromptStyle(value)
  const takeoverApplied = takeover.takeoverEnabled && value.takeoverApplied === true
  const upgraded: Record<string, unknown> = {
    ...value,
    schemaVersion: TASK_SCHEMA_VERSION,
    environment: {
      kind: 'local' as const,
      version: 1 as const,
      environmentId,
      projectId: value.projectId,
      rootSnapshot: value.environment.rootSnapshot
    },
    takeoverEnabled: takeover.takeoverEnabled,
    permissionPromptStyle
  }
  // 缺字段或非法类型 fail-closed 为 false / assist，不把整条 Task 标 corrupt，也不 bump schema。
  if (takeover.takeoverUpdatedAt) {
    upgraded.takeoverUpdatedAt = takeover.takeoverUpdatedAt
  } else {
    delete upgraded.takeoverUpdatedAt
  }
  if (takeoverApplied) {
    upgraded.takeoverApplied = true
  } else {
    delete upgraded.takeoverApplied
  }
  return {
    kind: 'valid',
    record: upgraded as unknown as TaskRecordV1,
    needsUpgrade: version.schemaVersion === LEGACY_TASK_SCHEMA_VERSION
  }
}

function parseTurnRecord(value: unknown): RecordParseResult<TurnRecordV1> {
  const version = readCompatibleSchemaVersion(
    value,
    TURN_SCHEMA_VERSION,
    LEGACY_TURN_SCHEMA_VERSION
  )
  if (version.kind === 'unsupported' || version.kind === 'corrupt') return version
  if (!isRecord(value) || !isValidIdentifier(value.turnId) || !isValidIdentifier(value.taskId)) {
    return { kind: 'corrupt' }
  }
  if (
    typeof value.promptDisplayText !== 'string' ||
    Buffer.byteLength(value.promptDisplayText, 'utf8') > 64 * 1024 ||
    !isRecord(value.model) ||
    typeof value.model.modelId !== 'string' ||
    !isHistoryState(value.state) ||
    !isIsoTimestamp(value.createdAt) ||
    (value.executionId !== undefined && !isValidIdentifier(value.executionId)) ||
    (value.environmentId !== undefined && !isValidIdentifier(value.environmentId)) ||
    (value.stateChangedAt !== undefined && !isIsoTimestamp(value.stateChangedAt)) ||
    (value.reason !== undefined && !isPersistedExecutionReason(value.reason))
  )
    return { kind: 'corrupt' }
  if (!Number.isSafeInteger(value.eventCount) || !Number.isSafeInteger(value.eventBytes))
    return { kind: 'corrupt' }
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) {
    return { kind: 'corrupt' }
  }
  if (value.attachmentIds !== undefined) {
    if (
      !Array.isArray(value.attachmentIds) ||
      value.attachmentIds.length > 8 ||
      value.attachmentIds.some((id) => typeof id !== 'string' || !isValidIdentifier(id))
    ) {
      return { kind: 'corrupt' }
    }
  }
  if (value.artifactIds !== undefined) {
    if (
      !Array.isArray(value.artifactIds) ||
      value.artifactIds.length > MAX_TURN_ARTIFACT_IDS ||
      value.artifactIds.some((id) => typeof id !== 'string' || !isValidIdentifier(id))
    ) {
      return { kind: 'corrupt' }
    }
  }
  const upgraded = {
    ...value,
    schemaVersion: TURN_SCHEMA_VERSION,
    ...(version.schemaVersion === LEGACY_TURN_SCHEMA_VERSION
      ? { stateChangedAt: value.endedAt ?? value.dispatchedAt ?? value.createdAt }
      : {})
  }
  return {
    kind: 'valid',
    record: upgraded as unknown as TurnRecordV1,
    needsUpgrade: version.schemaVersion === LEGACY_TURN_SCHEMA_VERSION
  }
}

function parseEventChunk(
  value: unknown,
  taskId: string,
  turnId: string
): RecordParseResult<EventChunkV1> {
  const version = readSchemaVersion(value, EVENT_SCHEMA_VERSION)
  if (version.kind !== 'current') return version
  if (!isRecord(value)) return { kind: 'corrupt' }
  if (value.taskId !== taskId || value.turnId !== turnId || !Array.isArray(value.events))
    return { kind: 'corrupt' }
  if (!Number.isSafeInteger(value.chunkIndex) || value.events.length > MAX_EVENTS_PER_CHUNK) {
    return { kind: 'corrupt' }
  }
  if (
    value.events.some(
      (event) => !isRecord(event) || !isValidPersistedEventIdentity(event, taskId, turnId)
    )
  ) {
    return { kind: 'corrupt' }
  }
  return { kind: 'valid', record: value as unknown as EventChunkV1 }
}

function readCompatibleSchemaVersion(
  value: unknown,
  currentVersion: number,
  legacyVersion: number
):
  | { kind: 'current'; schemaVersion: number }
  | { kind: 'unsupported'; schemaVersion: number }
  | { kind: 'corrupt' } {
  if (!isRecord(value) || !Number.isSafeInteger(value.schemaVersion)) return { kind: 'corrupt' }
  const schemaVersion = Number(value.schemaVersion)
  if (schemaVersion === currentVersion || schemaVersion === legacyVersion) {
    return { kind: 'current', schemaVersion }
  }
  return schemaVersion > currentVersion
    ? { kind: 'unsupported', schemaVersion }
    : { kind: 'corrupt' }
}

function readSchemaVersion(
  value: unknown,
  currentVersion: number
): { kind: 'current' } | { kind: 'unsupported'; schemaVersion: number } | { kind: 'corrupt' } {
  if (!isRecord(value) || !Number.isSafeInteger(value.schemaVersion)) return { kind: 'corrupt' }
  const schemaVersion = Number(value.schemaVersion)
  if (schemaVersion === currentVersion) return { kind: 'current' }
  return schemaVersion > currentVersion
    ? { kind: 'unsupported', schemaVersion }
    : { kind: 'corrupt' }
}

function isValidIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    !value.includes('\0') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    Buffer.byteLength(value, 'utf8') <= 4 * 1024
  )
}

function isHistoryState(value: unknown): value is HistoryExecutionState {
  return [
    'pending',
    'queued',
    'running',
    'waiting-permission',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
    'interrupted'
  ].includes(String(value))
}

function isPersistedExecutionReason(value: unknown): value is PersistedExecutionReason {
  return [
    'dispatch-failed',
    'runtime-error',
    'runtime-exit',
    'protocol-error',
    'persistence-failed',
    'cancelled-before-dispatch',
    'runtime-cancelled',
    'restart-recovery',
    'cancel-timeout',
    'forced-shutdown',
    'runtime-result-unknown'
  ].includes(String(value))
}

function isNonTerminalHistoryState(state: HistoryExecutionState): boolean {
  return ['pending', 'queued', 'running', 'waiting-permission', 'cancelling'].includes(state)
}

function isTerminalHistoryState(
  state: HistoryExecutionState
): state is Extract<HistoryExecutionState, 'completed' | 'failed' | 'cancelled' | 'interrupted'> {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(state)
}

function asTerminalHistoryState(
  state: HistoryExecutionState
): Extract<HistoryExecutionState, 'completed' | 'failed' | 'cancelled' | 'interrupted'> {
  if (!isTerminalHistoryState(state)) {
    throw new TaskStoreError('history-corrupt', '执行历史终态无效。')
  }
  return state
}

function serializedEventBytes(event: PersistedAgentEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8')
}

function arePersistedEventsEqual(left: PersistedAgentEvent, right: PersistedAgentEvent): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isValidPersistedEventIdentity(
  event: Record<string, unknown> | PersistedAgentEvent,
  taskId: string,
  turnId: string
): event is PersistedAgentEvent {
  return (
    event.taskId === taskId &&
    event.turnId === turnId &&
    Number.isSafeInteger(event.sequence) &&
    Number(event.sequence) > 0
  )
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path)
    return true
  } catch (error) {
    if (isFileNotFound(error)) return false
    throw error
  }
}

async function directoryUsage(path: string): Promise<number> {
  return (await inspectDirectory(path)).bytes
}

async function inspectDirectory(path: string): Promise<{ bytes: number; fileCount: number }> {
  let bytes = 0
  let fileCount = 0
  const entries = await fs.readdir(path, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      const nested = await inspectDirectory(child)
      bytes += nested.bytes
      fileCount += nested.fileCount
    } else if (entry.isFile()) {
      bytes += (await fs.stat(child)).size
      fileCount += 1
    }
  }
  return { bytes, fileCount }
}

/** 把实时事件逐字段投影为历史事件，禁止 runtimeSessionId 和未知属性落盘。 */
export function projectPersistedAgentEvent(
  event: AgentEvent,
  redactText: (text: string) => string
): PersistedAgentEvent {
  const base = {
    runtimeId: event.runtimeId,
    capabilityState: event.capabilityState,
    taskId: event.taskId,
    turnId: event.turnId,
    sequence: event.sequence,
    observedAt: event.observedAt,
    ...(event.truncated ? { truncated: true as const } : {})
  }
  switch (event.kind) {
    case 'agent-message':
    case 'agent-thought':
      return {
        ...base,
        kind: event.kind,
        text: redactText(event.text),
        ...(event.messageId ? { messageId: redactText(event.messageId) } : {})
      }
    case 'agent-attachment':
      return {
        ...base,
        kind: 'agent-attachment',
        attachmentId: event.attachmentId,
        attachmentKind: 'image',
        originalName: redactText(event.originalName)
      }
    case 'tool-call':
      return {
        ...base,
        kind: 'tool-call',
        toolCallId: redactText(event.toolCallId),
        title: redactText(event.title),
        ...(event.status ? { status: event.status } : {}),
        ...(event.parentId?.trim() ? { parentId: redactText(event.parentId) } : {})
      }
    case 'tool-update':
      return {
        ...base,
        kind: 'tool-update',
        toolCallId: redactText(event.toolCallId),
        ...(event.title ? { title: redactText(event.title) } : {}),
        ...(event.status ? { status: event.status } : {}),
        ...(event.parentId?.trim() ? { parentId: redactText(event.parentId) } : {})
      }
    case 'plan':
      return {
        ...base,
        kind: 'plan',
        entries: event.entries.map((entry) => ({ ...entry, content: redactText(entry.content) }))
      }
    case 'diff':
      return {
        ...base,
        kind: 'diff',
        diffs: event.diffs.map((diff) =>
          diff.format === 'snapshot'
            ? {
                format: 'snapshot',
                path: redactText(diff.path),
                before: diff.before == null ? null : redactText(diff.before),
                after: redactText(diff.after)
              }
            : {
                format: 'unified',
                paths: diff.paths.map(redactText),
                patch: redactText(diff.patch)
              }
        ),
        ...(event.toolCallId ? { toolCallId: redactText(event.toolCallId) } : {})
      }
    case 'usage':
      return { ...base, kind: 'usage', usage: structuredClone(event.usage) }
    case 'turn-complete':
      return {
        ...base,
        kind: 'turn-complete',
        outcome: event.outcome,
        ...(event.usage ? { usage: structuredClone(event.usage) } : {})
      }
    case 'error':
      return {
        ...base,
        kind: 'error',
        message: redactText(event.message),
        recoverable: event.recoverable,
        ...(event.code ? { code: redactText(event.code) } : {})
      }
  }
}
