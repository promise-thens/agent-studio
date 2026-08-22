import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentRuntimeCapabilitySnapshot, AgentTurnUsage } from '../../shared/agent'
import type {
  TaskExecutionCancellationRequest,
  QueuedTaskExecution,
  TaskExecutionDto,
  TaskExecutionSnapshot
} from '../../shared/task-execution'
import type { TurnModelSnapshot } from '../../shared/task-history'
import type {
  AgentRuntimeAdapter,
  AgentRuntimeSessionRef,
  AgentRuntimeTurnRef
} from './agent-runtime-adapter'
import { OperationGate, type OperationLease } from './operation-gate'
import { transitionTaskExecution, type TaskExecutionTransition } from './task-execution-state'
import {
  TaskStore,
  projectPersistedAgentEvent,
  type ExecutionIdentity,
  type ExecutionTerminalCommitResult
} from './task-store'

export interface TaskExecutorStartInput {
  taskId: string
  projectId: string
  runtimeId: 'grok' | 'codex'
  session: AgentRuntimeSessionRef
  environmentId: string
  resolvedExecutionRoot: string
  prompt: string
  promptDisplayText: string
  model: TurnModelSnapshot
  capabilitySnapshot: AgentRuntimeCapabilitySnapshot
  /** admission 激活后再准备 Runtime session，确保 connect/resume 复用同一 execution lease。 */
  prepareRuntime?: (lease: OperationLease) => Promise<void>
}

export interface TaskExecutorOptions {
  taskStore: TaskStore
  adapter: AgentRuntimeAdapter
  operationGate: OperationGate
  createId?: () => string
  now?: () => string
  executorEpoch?: string
  onSnapshot?: (snapshot: TaskExecutionSnapshot) => void
  onEvent?: (event: AgentEvent) => void
  redactText?: (text: string) => string
  cancelTimeoutMs?: number
  forceDisconnectTimeoutMs?: number
  scheduleTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearScheduledTimeout?: (timer: ReturnType<typeof setTimeout>) => void
  /** cancel deadline 到期时先撤销属于该 Turn 的主进程审批，再强制断开 Runtime。 */
  onCancelTimeout?: (identity: ExecutionIdentity) => Promise<void>
  /**
   * 身份校验与 admit 成功之后、this.active/publish 之前捕获变更基线。
   * 缺省为 no-op；抛错不得让 Turn 失败。start() 可短等只读 git。
   */
  ensureChangeBaseline?: (input: {
    taskId: string
    projectId: string
    environmentId: string
    executionRoot: string
  }) => Promise<void>
}

interface ActiveExecution {
  identity: ExecutionIdentity
  runtimeTurn: AgentRuntimeTurnRef
  dto: TaskExecutionDto
  lease: OperationLease
  prompt: string
  resolvedExecutionRoot: string
  capabilitySnapshot: AgentRuntimeCapabilitySnapshot
  prepareRuntime?: (lease: OperationLease) => Promise<void>
  terminalPromise: Promise<ExecutionTerminalCommitResult> | null
  terminalCandidate: Extract<
    TaskExecutionTransition,
    { state: 'completed' | 'failed' | 'cancelled' | 'interrupted' }
  > | null
  firstHistoryError: unknown
  historyTail: Promise<void>
  nextExpectedEventSequence: number
  eventHistoryTruncated: boolean
  terminalEventUsage?: AgentTurnUsage
  acceptedEvents: AgentEvent[]
  publishedEventSequences: Set<number>
  terminalPreparation: Promise<void>
  completionPromise: Promise<void>
  resolveCompletion: () => void
  cancelRequestPromise: Promise<boolean> | null
  cancelDeadlineTimer: ReturnType<typeof setTimeout> | null
}

export class TaskExecutorConflictError extends Error {
  readonly code = 'invalid-state' as const

  constructor(message = '已有 Turn 正在执行。') {
    super(message)
    this.name = 'TaskExecutorConflictError'
  }
}

/**
 * 持有唯一活动 execution，并负责 admission、后台 dispatch、状态 revision 与终态提交。
 * Adapter 和 Renderer 都不能直接释放执行槽或覆盖已提交终态。
 */
export class TaskExecutor {
  private readonly taskStore: TaskStore
  private readonly adapter: AgentRuntimeAdapter
  private readonly operationGate: OperationGate
  private readonly createId: () => string
  private readonly now: () => string
  private readonly onSnapshot: (snapshot: TaskExecutionSnapshot) => void
  private readonly onEvent: (event: AgentEvent) => void
  private readonly redactText: (text: string) => string
  private readonly executorEpoch: string
  private readonly cancelTimeoutMs: number
  private readonly forceDisconnectTimeoutMs: number
  private readonly scheduleTimeout: NonNullable<TaskExecutorOptions['scheduleTimeout']>
  private readonly clearScheduledTimeout: NonNullable<TaskExecutorOptions['clearScheduledTimeout']>
  private readonly onCancelTimeout: NonNullable<TaskExecutorOptions['onCancelTimeout']>
  private readonly ensureChangeBaseline?: TaskExecutorOptions['ensureChangeBaseline']
  private executionRevision = 0
  private active: ActiveExecution | null = null
  private lastExecution: TaskExecutionDto | null = null

  constructor(options: TaskExecutorOptions) {
    this.taskStore = options.taskStore
    this.adapter = options.adapter
    this.operationGate = options.operationGate
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => new Date().toISOString())
    this.executorEpoch = options.executorEpoch ?? randomUUID()
    this.onSnapshot = options.onSnapshot ?? (() => undefined)
    this.onEvent = options.onEvent ?? (() => undefined)
    this.redactText = options.redactText ?? ((text) => text)
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? 5_000
    this.forceDisconnectTimeoutMs = options.forceDisconnectTimeoutMs ?? 2_000
    this.scheduleTimeout = options.scheduleTimeout ?? setTimeout
    this.clearScheduledTimeout = options.clearScheduledTimeout ?? clearTimeout
    this.onCancelTimeout = options.onCancelTimeout ?? (() => Promise.resolve())
    this.ensureChangeBaseline = options.ensureChangeBaseline
  }

  getSnapshot(): TaskExecutionSnapshot {
    return {
      executorEpoch: this.executorEpoch,
      executionRevision: this.executionRevision,
      execution: this.lastExecution ? structuredClone(this.lastExecution) : null
    }
  }

  getActiveIdentity(): ExecutionIdentity | null {
    return this.active ? { ...this.active.identity } : null
  }

  getActiveRuntimeTurn(): AgentRuntimeTurnRef | null {
    return this.active ? { ...this.active.runtimeTurn } : null
  }

  getActiveState(): TaskExecutionDto['state'] | null {
    return this.active?.dto.state ?? null
  }

  async updatePermissionPendingCount(count: number): Promise<boolean> {
    const active = this.active
    if (!active || !Number.isSafeInteger(count) || count < 0) return false
    if (count > 0) {
      return this.transitionCurrent({
        state: 'waiting-permission',
        pendingPermissionCount: count,
        stateChangedAt: this.now()
      })
    }
    if (active.dto.state !== 'waiting-permission') return true
    return this.transitionCurrent({ state: 'running', dispatchedAt: active.dto.dispatchedAt })
  }

  async interrupt(reason: 'forced-shutdown' | 'cancel-timeout'): Promise<boolean> {
    const active = this.active
    if (!active) return true
    try {
      await this.complete(active, { state: 'interrupted', endedAt: this.now(), reason })
      return !this.active
    } catch {
      return false
    }
  }

  async waitForTerminal(): Promise<void> {
    const active = this.active
    if (!active) return
    await active.completionPromise
  }

  hasActiveExecution(): boolean {
    return this.active !== null
  }

  async start(input: TaskExecutorStartInput): Promise<TaskExecutionSnapshot> {
    let admission
    try {
      admission = this.operationGate.acquireExecutionAdmission()
    } catch {
      throw new TaskExecutorConflictError()
    }

    let activeLease: OperationLease | null = null
    try {
      const task = this.taskStore.getTaskRecord(input.taskId)
      if (
        task.projectId !== input.projectId ||
        task.runtimeId !== input.runtimeId ||
        task.runtimeSession.runtimeId !== input.session.runtimeId ||
        task.runtimeSession.runtimeSessionId !== input.session.runtimeSessionId ||
        task.environment.environmentId !== input.environmentId ||
        task.environment.rootSnapshot !== input.resolvedExecutionRoot
      ) {
        throw new TaskExecutorConflictError('Task 执行身份与持久化事实不一致。')
      }

      const acceptedAt = this.now()
      const executionId = this.createId()
      const turnId = this.createId()
      const identity = { executionId, taskId: input.taskId, turnId }
      const queued: QueuedTaskExecution = {
        executionId,
        taskId: input.taskId,
        turnId,
        projectId: input.projectId,
        runtimeId: input.runtimeId,
        model: structuredClone(input.model),
        environment: { environmentId: input.environmentId, kind: 'local', version: 1 },
        state: 'queued',
        acceptedAt,
        stateChangedAt: acceptedAt
      }
      await this.taskStore.admitExecutionTurn({
        ...identity,
        environmentId: input.environmentId,
        promptDisplayText: input.promptDisplayText,
        model: input.model
      })
      activeLease = admission.activate()
      if (!activeLease) {
        await this.taskStore.commitExecutionTerminal(identity, {
          state: 'interrupted',
          endedAt: this.now(),
          reason: 'forced-shutdown'
        })
        throw new TaskExecutorConflictError('应用正在退出，不能开始新的 Turn。')
      }
      // 基线必须在 this.active/publish 之前完成：queued 窗口内 cancel 再 start 不得 dispatch 到新 execution。
      if (this.ensureChangeBaseline) {
        try {
          await this.ensureChangeBaseline({
            taskId: input.taskId,
            projectId: input.projectId,
            environmentId: input.environmentId,
            executionRoot: input.resolvedExecutionRoot
          })
        } catch {
          // 基线捕获失败不得拒绝 Turn；后续只读审阅会看到 missing/unavailable。
        }
      }
      const completion = deferredCompletion()
      const active: ActiveExecution = {
        identity,
        runtimeTurn: {
          taskId: input.taskId,
          turnId,
          runtimeSessionId: input.session.runtimeSessionId
        },
        dto: queued,
        lease: activeLease,
        prompt: input.prompt,
        resolvedExecutionRoot: input.resolvedExecutionRoot,
        capabilitySnapshot: structuredClone(input.capabilitySnapshot),
        ...(input.prepareRuntime ? { prepareRuntime: input.prepareRuntime } : {}),
        terminalPromise: null,
        terminalCandidate: null,
        firstHistoryError: null,
        historyTail: Promise.resolve(),
        nextExpectedEventSequence: 1,
        eventHistoryTruncated: false,
        acceptedEvents: [],
        publishedEventSequences: new Set(),
        terminalPreparation: Promise.resolve(),
        completionPromise: completion.promise,
        resolveCompletion: completion.resolve,
        cancelRequestPromise: null,
        cancelDeadlineTimer: null
      }
      this.active = active
      this.publish(queued)
      void this.dispatch(active).catch(() => undefined)
      return this.getSnapshot()
    } catch (error) {
      activeLease?.release()
      admission.release()
      throw error
    }
  }

  handleRuntimeEvent(event: AgentEvent): boolean {
    const active = this.active
    if (!active || !matchesEvent(active, event) || active.terminalCandidate) return false
    if (event.sequence !== active.nextExpectedEventSequence) return false
    active.nextExpectedEventSequence += 1
    active.acceptedEvents.push(structuredClone(event))
    if (event.kind === 'turn-complete') {
      active.terminalCandidate = toTerminalTransition(event.outcome, this.now())
      active.terminalEventUsage = event.usage
    }
    this.queueHistory(active, async () => {
      if (active.eventHistoryTruncated) return
      const result = await this.taskStore.appendEvent(
        projectPersistedAgentEvent(event, this.redactText)
      )
      if (result.kind === 'committed') {
        active.publishedEventSequences.add(event.sequence)
        this.safeNotifyEvent(event)
      } else if (result.kind === 'repaired') {
        if (!active.publishedEventSequences.has(event.sequence)) {
          active.publishedEventSequences.add(event.sequence)
          this.safeNotifyEvent(event)
        }
      } else if (result.kind === 'history-truncated') {
        active.eventHistoryTruncated = true
      }
    })
    if (event.kind === 'turn-complete') {
      const terminalCandidate = active.terminalCandidate
      if (terminalCandidate) void this.complete(active, terminalCandidate)
    }
    return true
  }

  async cancel(request: TaskExecutionCancellationRequest): Promise<boolean> {
    const active = this.active
    if (
      !active ||
      active.identity.executionId !== request.executionId ||
      active.identity.taskId !== request.taskId ||
      active.identity.turnId !== request.turnId
    ) {
      return false
    }
    if (active.cancelRequestPromise) return active.cancelRequestPromise
    const cancelRequest = this.cancelCurrent(active)
    active.cancelRequestPromise = cancelRequest
    void cancelRequest.then(
      (accepted) => {
        if (!accepted && this.active === active && active.cancelRequestPromise === cancelRequest) {
          active.cancelRequestPromise = null
        }
      },
      () => {
        if (this.active === active && active.cancelRequestPromise === cancelRequest) {
          active.cancelRequestPromise = null
        }
      }
    )
    return cancelRequest
  }

  /** 同一 execution 的所有取消调用共用该 Promise，避免重复状态写入和 Adapter cancel。 */
  private async cancelCurrent(active: ActiveExecution): Promise<boolean> {
    if (active.dto.state === 'queued') {
      try {
        await this.complete(active, {
          state: 'cancelled',
          endedAt: this.now(),
          reason: 'cancelled-before-dispatch'
        })
        return true
      } catch {
        return false
      }
    }
    const previousState = active.dto
    const cancelRequestedAt = this.now()
    const transitioned = await this.transitionCurrent({ state: 'cancelling', cancelRequestedAt })
    if (!transitioned) return false
    try {
      await this.adapter.cancelTurn(active.runtimeTurn)
      this.scheduleCancelDeadline(active)
      return true
    } catch {
      active.dto = previousState
      await this.taskStore.transitionExecution(
        active.identity,
        previousState.state === 'waiting-permission' ? 'waiting-permission' : 'running',
        this.now()
      )
      this.publish(previousState)
      return false
    }
  }

  async transitionCurrent(transition: TaskExecutionTransition): Promise<boolean> {
    const active = this.active
    if (!active) return false
    const result = transitionTaskExecution(active.dto, transition)
    if (result.kind !== 'transitioned') return result.kind === 'duplicate'
    await this.taskStore.transitionExecution(
      active.identity,
      result.execution.state as never,
      result.execution.stateChangedAt
    )
    active.dto = result.execution
    this.publish(result.execution)
    return true
  }

  private async dispatch(active: ActiveExecution): Promise<void> {
    if (this.active !== active || active.terminalCandidate) return
    try {
      await active.prepareRuntime?.(active.lease)
      if (this.active !== active || active.terminalCandidate) return
      const dispatchedAt = this.now()
      await this.taskStore.transitionExecution(active.identity, 'running', dispatchedAt)
      const result = transitionTaskExecution(active.dto, { state: 'running', dispatchedAt })
      if (result.kind !== 'transitioned') throw new Error('invalid-running-transition')
      active.dto = result.execution
      this.publish(result.execution)
      const outcome = await this.adapter.startTurn({
        ...active.runtimeTurn,
        workspace: active.resolvedExecutionRoot,
        prompt: active.prompt
      })
      await this.complete(active, toTerminalTransition(outcome.outcome, this.now()))
    } catch {
      await this.complete(active, {
        state: 'failed',
        endedAt: this.now(),
        reason: 'dispatch-failed'
      })
    }
  }

  async retryPersistence(): Promise<boolean> {
    const active = this.active
    if (!active || !active.terminalCandidate) return false
    active.terminalPromise = null
    active.firstHistoryError = null
    active.historyTail = Promise.resolve()
    try {
      await this.complete(active, active.terminalCandidate)
      return !this.active
    } catch {
      return false
    }
  }

  private complete(
    active: ActiveExecution,
    transition: Extract<
      TaskExecutionTransition,
      { state: 'completed' | 'failed' | 'cancelled' | 'interrupted' }
    >
  ): Promise<ExecutionTerminalCommitResult> {
    if (this.active !== active) return Promise.resolve({ kind: 'stale' })
    if (active.terminalPromise) return active.terminalPromise
    active.terminalCandidate ??= transition
    this.clearCancelDeadline(active)

    active.terminalPromise = (async () => {
      try {
        await active.terminalPreparation
        await active.historyTail
        if (active.firstHistoryError) throw active.firstHistoryError
        const result = transitionTaskExecution(active.dto, active.terminalCandidate ?? transition)
        if (result.kind === 'conflict' || result.kind === 'invalid') {
          return { kind: 'conflict' }
        }
        const terminal = result.execution
        if (!isTerminalDto(terminal)) return { kind: 'conflict' }
        const committed = await this.taskStore.commitExecutionTerminal(active.identity, {
          state: terminal.state,
          endedAt: terminal.endedAt,
          ...('reason' in terminal ? { reason: terminal.reason } : {}),
          ...(active.terminalEventUsage ? { usage: active.terminalEventUsage } : {})
        })
        if (
          committed.kind === 'committed' ||
          committed.kind === 'repaired' ||
          committed.kind === 'duplicate'
        ) {
          active.dto = terminal
          this.publish(terminal)
          if (this.active === active) {
            this.active = null
            active.lease.release()
            active.resolveCompletion()
          }
        }
        return committed
      } catch (error) {
        active.terminalPromise = null
        throw error
      }
    })()
    return active.terminalPromise
  }

  /** cancel 被 Runtime 忽略时锁定 interrupted 终态，并在有界清理后提交释放槽。 */
  private scheduleCancelDeadline(active: ActiveExecution): void {
    if (this.active !== active || active.terminalCandidate || active.cancelDeadlineTimer) return
    active.cancelDeadlineTimer = this.scheduleTimeout(() => {
      active.cancelDeadlineTimer = null
      if (this.active !== active || active.terminalCandidate) return
      const transition = {
        state: 'interrupted' as const,
        endedAt: this.now(),
        reason: 'cancel-timeout' as const
      }
      active.terminalCandidate = transition
      active.terminalPreparation = this.withTimeout(
        Promise.allSettled([
          this.onCancelTimeout({ ...active.identity }),
          this.adapter.disconnect()
        ]).then(() => undefined),
        this.forceDisconnectTimeoutMs
      )
      void this.complete(active, transition).catch(() => undefined)
    }, this.cancelTimeoutMs)
  }

  private clearCancelDeadline(active: ActiveExecution): void {
    if (!active.cancelDeadlineTimer) return
    this.clearScheduledTimeout(active.cancelDeadlineTimer)
    active.cancelDeadlineTimer = null
  }

  /** Runtime 或 Broker 不返回时只等待固定期限，绝不让取消清理永久占用执行槽。 */
  private async withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false
      const timer = this.scheduleTimeout(() => {
        if (settled) return
        settled = true
        resolve()
      }, timeoutMs)
      void operation.then(
        () => {
          if (settled) return
          settled = true
          this.clearScheduledTimeout(timer)
          resolve()
        },
        () => {
          if (settled) return
          settled = true
          this.clearScheduledTimeout(timer)
          resolve()
        }
      )
    })
  }

  private queueHistory(active: ActiveExecution, operation: () => Promise<void>): void {
    const previous = active.historyTail.catch(() => undefined)
    active.historyTail = previous.then(async () => {
      if (active.firstHistoryError) throw active.firstHistoryError
      try {
        await operation()
      } catch (error) {
        active.firstHistoryError ??= error
        throw error
      }
    })
    void active.historyTail.catch(() => undefined)
  }

  private safeNotifyEvent(event: AgentEvent): void {
    try {
      this.onEvent(event)
    } catch {
      // Renderer observer 失败不能改变主进程执行事实。
    }
  }

  private publish(execution: TaskExecutionDto): void {
    this.lastExecution = structuredClone(execution)
    this.executionRevision += 1
    try {
      this.onSnapshot(this.getSnapshot())
    } catch {
      // Snapshot observer 失败不能阻断 dispatch、终态提交或 lease 释放。
    }
  }
}

function matchesEvent(active: ActiveExecution, event: AgentEvent): boolean {
  return (
    event.taskId === active.identity.taskId &&
    event.turnId === active.identity.turnId &&
    event.runtimeId === active.dto.runtimeId &&
    (!event.runtimeSessionId || event.runtimeSessionId === active.runtimeTurn.runtimeSessionId)
  )
}

function toTerminalTransition(
  outcome: 'completed' | 'cancelled' | 'refused' | 'limit-reached' | 'failed',
  endedAt: string
): Extract<
  TaskExecutionTransition,
  { state: 'completed' | 'failed' | 'cancelled' | 'interrupted' }
> {
  if (outcome === 'completed') return { state: 'completed', endedAt }
  if (outcome === 'cancelled') {
    return { state: 'cancelled', endedAt, reason: 'runtime-cancelled' }
  }
  return { state: 'failed', endedAt, reason: 'runtime-error' }
}

function isTerminalDto(
  execution: TaskExecutionDto
): execution is Extract<
  TaskExecutionDto,
  { state: 'completed' | 'failed' | 'cancelled' | 'interrupted' }
> {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(execution.state)
}

/** admission 时创建稳定完成信号；只有终态落盘并释放 execution lease 后才解析。 */
function deferredCompletion(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
