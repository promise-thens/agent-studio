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
import type { AgentRuntimeSessionRef } from './agent-runtime-adapter'
import { ProjectRegistry } from '../project/project-registry'
import { AtomicJsonWriter } from '../storage/atomic-json-file'

const TASK_SCHEMA_VERSION = 1
const TURN_SCHEMA_VERSION = 1
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
  environment: { kind: 'local'; projectId: string; rootSnapshot: string }
  runtimeSession: PersistedRuntimeSessionRefV1
  permissionPolicy: { kind: 'legacy-runtime' }
  title: string
  state: HistoryExecutionState
  activeTurnId?: string
  lastTurnId?: string
  turnCount: number
  createdAt: string
  updatedAt: string
  revision: number
}

interface TurnRecordV1 extends TurnHistoryRecord {
  schemaVersion: typeof TURN_SCHEMA_VERSION
}

interface EventChunkV1 {
  schemaVersion: typeof EVENT_SCHEMA_VERSION
  taskId: string
  turnId: string
  chunkIndex: number
  events: PersistedAgentEvent[]
}

interface DeleteTokenRecord {
  targetType: DeletionPreview['targetType']
  targetId: string
  revision: number
  expiresAtMs: number
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
  private readonly deleteTokens = new Map<string, DeleteTokenRecord>()

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
    await this.ensureTaskCapacity()
    const observedAt = this.now()
    const task: TaskRecordV1 = {
      schemaVersion: TASK_SCHEMA_VERSION,
      taskId: input.taskId,
      projectId: input.projectId,
      runtimeId: input.runtimeId,
      environment: { kind: 'local', projectId: input.projectId, rootSnapshot: input.root },
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
      revision: 1
    }
    await this.writer.write(this.taskPath(task), task)
    this.tasks.set(task.taskId, task)
    return structuredClone(task)
  }

  async createTurn(input: {
    taskId: string
    turnId: string
    promptDisplayText: string
    model: TurnModelSnapshot
  }): Promise<TurnRecordV1> {
    return this.enqueueTask(input.taskId, async () => {
      const task = this.requireTask(input.taskId)
      if (task.turnCount >= MAX_TURNS_PER_TASK) {
        throw new TaskStoreError('task-turn-limit-reached', '当前 Task 已达到 100 个 Turn 上限。')
      }
      await this.ensureHistoryCapacity(Buffer.byteLength(input.promptDisplayText, 'utf8'))
      const observedAt = this.now()
      const turn: TurnRecordV1 = {
        schemaVersion: TURN_SCHEMA_VERSION,
        turnId: input.turnId,
        taskId: input.taskId,
        promptDisplayText: input.promptDisplayText,
        model: input.model,
        state: 'pending',
        createdAt: observedAt,
        eventCount: 0,
        eventBytes: 0,
        revision: 1
      }
      const nextTask: TaskRecordV1 = {
        ...task,
        title: task.turnCount === 0 ? deriveTaskTitle(input.promptDisplayText) : task.title,
        state: 'pending',
        activeTurnId: input.turnId,
        lastTurnId: input.turnId,
        turnCount: task.turnCount + 1,
        updatedAt: observedAt,
        revision: task.revision + 1
      }
      await this.writer.write(this.turnPath(nextTask, input.turnId), turn)
      try {
        await this.writer.write(this.taskPath(nextTask), nextTask)
      } catch (error) {
        await this.writer
          .removeDurably(this.turnDirectory(nextTask, input.turnId))
          .catch(() => undefined)
        throw error
      }
      this.tasks.set(nextTask.taskId, nextTask)
      return turn
    })
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

  async appendEvent(event: PersistedAgentEvent): Promise<boolean> {
    return this.enqueueTask(event.taskId, async () => {
      const task = this.requireTask(event.taskId)
      const turn = await this.readTurn(task, event.turnId)
      const serializedBytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
      if (serializedBytes > MAX_EVENT_BYTES) {
        if (!turn.historyTruncated) {
          await this.saveTurn(task, {
            ...turn,
            historyTruncated: true,
            truncationReason: 'event-bytes',
            revision: turn.revision + 1
          })
        }
        return false
      }
      if (
        turn.eventCount >= MAX_EVENTS_PER_TURN ||
        turn.eventBytes + serializedBytes > MAX_TURN_EVENT_BYTES
      ) {
        if (!turn.historyTruncated) {
          const reason = turn.eventCount >= MAX_EVENTS_PER_TURN ? 'event-count' : 'turn-bytes'
          await this.saveTurn(task, {
            ...turn,
            historyTruncated: true,
            truncationReason: reason,
            revision: turn.revision + 1
          })
        }
        return false
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
        eventCount: turn.eventCount + 1,
        eventBytes: turn.eventBytes + serializedBytes,
        revision: turn.revision + 1
      })
      return true
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

  async listTasks(projectId: string, cursor?: string, limit = 50): Promise<TaskHistoryPage> {
    const acceptedLimit = clampLimit(limit, 50, 100)
    const all = [...this.tasks.values()]
      .filter((task) => task.projectId === projectId)
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

  async listTurns(taskId: string, cursor?: string, limit = 20): Promise<TurnHistoryPage> {
    const task = this.requireTask(taskId)
    const acceptedLimit = clampLimit(limit, 20, 50)
    const turnIds = await fs.readdir(this.turnsDirectory(task)).catch(() => [])
    const turns: TurnRecordV1[] = []
    for (const turnId of turnIds) {
      try {
        turns.push(await this.readTurn(task, turnId))
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
    const task = this.requireTask(taskId)
    const turn = await this.readTurn(task, turnId)
    const acceptedLimit = clampLimit(limit, 100, 200)
    const eventFiles = (await fs.readdir(this.eventsDirectory(task, turnId)).catch(() => []))
      .filter((name) => name.endsWith('.json'))
      .sort()
    const events: PersistedAgentEvent[] = []
    for (const eventFile of eventFiles) {
      const path = join(this.eventsDirectory(task, turnId), eventFile)
      try {
        const parsed = parseEventChunk(
          await this.writer.read(path, MAX_EVENT_CHUNK_BYTES * 2),
          taskId,
          turnId
        )
        if (parsed.kind === 'unsupported') {
          throw new TaskStoreError('history-version-unsupported', '事件历史版本高于当前客户端。')
        }
        if (parsed.kind === 'corrupt') {
          await this.quarantine(path, 'event-chunk', 'invalid-fields')
          continue
        }
        events.push(...parsed.record.events)
      } catch (error) {
        if (error instanceof TaskStoreError) throw error
        await this.quarantine(path, 'event-chunk', 'invalid-json')
      }
    }
    const page = events.filter((event) => event.sequence > afterSequence).slice(0, acceptedLimit)
    const finalSequence = page.at(-1)?.sequence ?? afterSequence
    return {
      items: page,
      ...(events.some((event) => event.sequence > finalSequence)
        ? { nextCursor: String(finalSequence) }
        : {}),
      ...(turn.historyTruncated && page.length === 0 ? {} : {})
    }
  }

  async previewTaskDeletion(taskId: string): Promise<DeletionPreview> {
    const task = this.requireTask(taskId)
    return this.createDeletionPreview('task', taskId, task.revision, this.taskDirectory(task))
  }

  async deleteTask(taskId: string, token: string): Promise<void> {
    const task = this.requireTask(taskId)
    if (task.activeTurnId || task.state === 'running' || task.state === 'waiting-permission') {
      throw new TaskStoreError('invalid-state', '活动 Task 不能删除历史。')
    }
    this.consumeDeleteToken(token, 'task', taskId, task.revision)
    await this.moveToDeletingAndRemove(this.taskDirectory(task), `task-${taskId}`)
    this.tasks.delete(taskId)
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

  async deleteProjectHistory(projectId: string, token: string): Promise<void> {
    const project = this.registry.getRecord(projectId)
    if (
      [...this.tasks.values()].some((task) => task.projectId === projectId && task.activeTurnId)
    ) {
      throw new TaskStoreError('invalid-state', 'Project 中仍有活动 Task，不能删除历史。')
    }
    this.consumeDeleteToken(token, 'project-history', projectId, project.revision)
    const tasksPath = join(this.registry.getProjectDirectory(projectId), 'tasks')
    await this.moveToDeletingAndRemove(tasksPath, `project-${projectId}`)
    for (const [taskId, task] of this.tasks)
      if (task.projectId === projectId) this.tasks.delete(taskId)
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
      if (task.state !== 'running' && task.state !== 'waiting-permission') continue
      const nextTask = {
        ...task,
        state: 'interrupted' as const,
        activeTurnId: undefined,
        updatedAt: this.now(),
        revision: task.revision + 1
      }
      if (task.activeTurnId) {
        try {
          const turn = await this.readTurn(task, task.activeTurnId)
          await this.saveTurn(task, {
            ...turn,
            state: 'interrupted',
            endedAt: this.now(),
            revision: turn.revision + 1
          })
        } catch {
          // Task 状态仍需收束，损坏 Turn 单独忽略。
        }
      }
      await this.writer.write(this.taskPath(nextTask), nextTask)
      this.tasks.set(nextTask.taskId, nextTask)
    }
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
    return parsed.record
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

  private async ensureHistoryCapacity(projectedBytes: number): Promise<void> {
    let total = await directoryUsage(this.registry.historyRoot)
    while (total + projectedBytes > MAX_HISTORY_BYTES) {
      const removed = await this.evictOldestTerminalTask()
      if (!removed) {
        throw new TaskStoreError('history-capacity-exceeded', '历史容量已达到 256 MiB 上限。')
      }
      total = await directoryUsage(this.registry.historyRoot)
    }
  }

  private async evictOldestTerminalTask(): Promise<boolean> {
    const candidate = [...this.tasks.values()]
      .filter(
        (task) =>
          !task.activeTurnId &&
          ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.state)
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0]
    if (!candidate) return false
    await this.moveToDeletingAndRemove(this.taskDirectory(candidate), `evicted-${candidate.taskId}`)
    this.tasks.delete(candidate.taskId)
    return true
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
  ): void {
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
  }

  private async moveToDeletingAndRemove(source: string, label: string): Promise<void> {
    const deletingRoot = join(this.registry.historyRoot, 'deleting')
    await this.writer.ensureDirectory(deletingRoot)
    const target = join(deletingRoot, `${label}-${this.createId()}`)
    try {
      await this.writer.renameDurably(source, target)
    } catch (error) {
      if (isFileNotFound(error)) return
      throw error
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

  private async enqueueTask<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskQueues.get(taskId) ?? Promise.resolve()
    let result: T
    const current = previous
      .catch(() => undefined)
      .then(async () => {
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
    revision: task.revision
  }
}

function stripTurnSchema(turn: TurnRecordV1): TurnHistoryRecord {
  return {
    turnId: turn.turnId,
    taskId: turn.taskId,
    promptDisplayText: turn.promptDisplayText,
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
  | { kind: 'valid'; record: T }
  | { kind: 'unsupported'; schemaVersion: number }
  | { kind: 'corrupt' }

function parseTaskRecord(value: unknown): RecordParseResult<TaskRecordV1> {
  const version = readSchemaVersion(value, TASK_SCHEMA_VERSION)
  if (version.kind !== 'current') return version
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
    !isIsoTimestamp(value.updatedAt)
  )
    return { kind: 'corrupt' }
  return { kind: 'valid', record: value as unknown as TaskRecordV1 }
}

function parseTurnRecord(value: unknown): RecordParseResult<TurnRecordV1> {
  const version = readSchemaVersion(value, TURN_SCHEMA_VERSION)
  if (version.kind !== 'current') return version
  if (!isRecord(value) || !isValidIdentifier(value.turnId) || !isValidIdentifier(value.taskId)) {
    return { kind: 'corrupt' }
  }
  if (
    typeof value.promptDisplayText !== 'string' ||
    Buffer.byteLength(value.promptDisplayText, 'utf8') > 64 * 1024 ||
    !isRecord(value.model) ||
    typeof value.model.modelId !== 'string' ||
    !isHistoryState(value.state) ||
    !isIsoTimestamp(value.createdAt)
  )
    return { kind: 'corrupt' }
  if (!Number.isSafeInteger(value.eventCount) || !Number.isSafeInteger(value.eventBytes))
    return { kind: 'corrupt' }
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) {
    return { kind: 'corrupt' }
  }
  return { kind: 'valid', record: value as unknown as TurnRecordV1 }
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
      (event) => !isRecord(event) || event.taskId !== taskId || event.turnId !== turnId
    )
  ) {
    return { kind: 'corrupt' }
  }
  return { kind: 'valid', record: value as unknown as EventChunkV1 }
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
    'running',
    'waiting-permission',
    'completed',
    'failed',
    'cancelled',
    'interrupted'
  ].includes(String(value))
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
    case 'tool-call':
      return {
        ...base,
        kind: 'tool-call',
        toolCallId: redactText(event.toolCallId),
        title: redactText(event.title),
        ...(event.status ? { status: event.status } : {})
      }
    case 'tool-update':
      return {
        ...base,
        kind: 'tool-update',
        toolCallId: redactText(event.toolCallId),
        ...(event.title ? { title: redactText(event.title) } : {}),
        ...(event.status ? { status: event.status } : {})
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
