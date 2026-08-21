import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type {
  AgentEvent,
  AgentExecutionState,
  AgentRuntimeCapabilitySnapshot,
  AgentRuntimeStatus,
  AgentTaskRuntimeState,
  AgentTurnExecutionResult,
  AgentTurnOutcome
} from '../../shared/agent'
import type {
  ConversationEntryState,
  RuntimeResumeSummary,
  TurnModelSnapshot
} from '../../shared/task-history'
import type {
  TaskExecutionCancellationRequest,
  TaskExecutionSnapshot
} from '../../shared/task-execution'
import {
  AgentRuntimeAdapterError,
  type AgentRuntimeAdapter,
  type AgentRuntimeAdapterErrorCode,
  type AgentRuntimeMcpServer,
  type AgentRuntimePermissionCancellation,
  type AgentRuntimePermissionRequest,
  type AgentRuntimeSessionRef,
  type AgentRuntimeTurnRef
} from './agent-runtime-adapter'
import type { TaskExecutor } from './task-executor'
import { TaskExecutionConflictError, TaskExecutionController } from './task-execution-controller'
import { OperationGate, type OperationLease } from './operation-gate'
import { ProjectRegistry, ProjectRegistryError } from '../project/project-registry'
import {
  projectPersistedAgentEvent,
  TaskStore,
  TaskStoreError,
  type TaskRecordV1
} from './task-store'
import type { AgentRespondPermissionRequest } from '../../shared/agent-ipc'
import type { AgentAvailableCommandSnapshot } from '../../shared/agent-available-command'
import type { PermissionBroker } from '../security/permission-broker'
import { createLocalEnvironmentId } from '../security/permission-policy'

const MAX_WORKSPACE_BYTES = 4 * 1024
const MAX_PROMPT_BYTES = 64 * 1024
const MAX_IDENTIFIER_BYTES = 4 * 1024
const MAX_RUNTIME_PERMISSION_REQUESTS = 2_000

export type AgentServiceErrorCode =
  | AgentRuntimeAdapterErrorCode
  | 'invalid-input'
  | 'payload-too-large'
  | 'task-not-found'
  | 'workspace-mismatch'
  | 'project-not-found'
  | 'project-unavailable'
  | 'history-not-found'
  | 'history-corrupt'
  | 'history-version-unsupported'
  | 'history-capacity-exceeded'
  | 'task-turn-limit-reached'
  | 'deletion-token-invalid'

/** AgentService 对 IPC 层暴露的有限领域错误，不携带 Runtime 原始异常。 */
export class AgentServiceError extends Error {
  constructor(
    readonly code: AgentServiceErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AgentServiceError'
  }
}

export interface AgentServiceOptions {
  createId?: () => string
  now?: () => string
  projectRegistry?: ProjectRegistry
  taskStore?: TaskStore
  getTurnModel?: () => TurnModelSnapshot
  redactText?: (text: string) => string
  permissionBroker?: PermissionBroker
  taskExecutor?: TaskExecutor
  operationGate?: OperationGate
  onEvent?: (event: AgentEvent) => void
  /** 创建 / 恢复 session 时注入已校验的 MCP 描述；缺省为空。 */
  getSessionMcpServers?: () => Promise<AgentRuntimeMcpServer[]> | AgentRuntimeMcpServer[]
  /** 共享记忆树等 Runtime 笔记根；缺省为空，写入会被当成项目外逃逸。 */
  getTrustedExternalRoots?: () => Promise<string[]> | string[]
}

interface AgentTaskRecord extends AgentTaskRuntimeState {
  projectId?: string
  runtimeSessionId: string
  session: AgentRuntimeSessionRef
}

function cloneTask(task: AgentTaskRecord): AgentTaskRuntimeState {
  return {
    taskId: task.taskId,
    runtimeId: task.runtimeId,
    workspace: task.workspace,
    state: task.state,
    ...(task.activeTurnId ? { activeTurnId: task.activeTurnId } : {}),
    ...(task.lastTurnId ? { lastTurnId: task.lastTurnId } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  }
}

function isUsableRestoreCapability(
  snapshot: AgentRuntimeCapabilitySnapshot,
  capabilityId: 'session.load' | 'session.resume'
): boolean {
  const capability = snapshot.capabilities[capabilityId]
  return capability.support === 'native' && capability.verification !== 'unverified'
}

function isTerminalExecutionState(state: string): boolean {
  return (
    state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'interrupted'
  )
}

function mapOutcomeToExecutionState(outcome: AgentTurnOutcome): AgentExecutionState {
  if (outcome === 'completed') return 'completed'
  if (outcome === 'cancelled') return 'cancelled'
  return 'failed'
}

/**
 * 持有产品 Task / Turn 身份和 RuntimeSessionRef 注册表。
 * 活动执行槽仍只委托 TaskExecutionController；Task/Turn 历史由可选 TaskStore 持久化。
 */
export class AgentService {
  private readonly tasks = new Map<string, AgentTaskRecord>()
  private readonly allocatedTaskIds = new Set<string>()
  private readonly availableCommands = new Map<string, AgentAvailableCommandSnapshot>()
  /**
   * createSession 完成前允许收命令快照的 Task。
   * Grok 可能在 createSession 等待期间就推 available_commands_update。
   */
  private readonly pendingAvailableCommandTaskIds = new Set<string>()
  private readonly allocatedTurnIds = new Set<string>()
  private selectedTaskId: string | null = null
  private sessionOperationActive = false
  private enterGeneration = 0
  private enterInFlight: {
    taskId: string
    generation: number
    promise: Promise<ConversationEntryState>
  } | null = null
  private readonly createId: () => string
  private readonly now: () => string
  private readonly projectRegistry?: ProjectRegistry
  private readonly taskStore?: TaskStore
  private readonly getTurnModel: () => TurnModelSnapshot
  private readonly redactText: (text: string) => string
  private readonly permissionBroker?: PermissionBroker
  private readonly taskExecutor?: TaskExecutor
  private readonly operationGate?: OperationGate
  private readonly onEvent: (event: AgentEvent) => void
  private readonly getSessionMcpServers?: AgentServiceOptions['getSessionMcpServers']
  private readonly getTrustedExternalRoots?: AgentServiceOptions['getTrustedExternalRoots']
  private readonly historyWrites = new Map<string, Promise<void>>()
  private readonly runtimePermissionRequests = new Map<string, AgentRuntimePermissionRequest>()

  constructor(
    private readonly adapter: AgentRuntimeAdapter,
    private readonly executionController: TaskExecutionController,
    options: AgentServiceOptions = {}
  ) {
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => new Date().toISOString())
    this.projectRegistry = options.projectRegistry
    this.taskStore = options.taskStore
    this.getTurnModel = options.getTurnModel ?? (() => ({ modelId: 'unknown' }))
    this.redactText = options.redactText ?? ((text) => text)
    this.permissionBroker = options.permissionBroker
    this.taskExecutor = options.taskExecutor
    this.operationGate = options.operationGate
    this.onEvent = options.onEvent ?? (() => undefined)
    this.getSessionMcpServers = options.getSessionMcpServers
    this.getTrustedExternalRoots = options.getTrustedExternalRoots
    for (const persistedTask of this.taskStore?.listTaskRecords() ?? []) {
      const task = restoreRuntimeTask(persistedTask)
      this.tasks.set(task.taskId, task)
      this.allocatedTaskIds.add(task.taskId)
    }
  }

  getStatus(): AgentRuntimeStatus {
    return this.adapter.getStatus()
  }

  getExecutionSnapshot(): TaskExecutionSnapshot {
    return (
      this.taskExecutor?.getSnapshot() ?? {
        executorEpoch: 'legacy-agent-service',
        executionRevision: 0,
        execution: null
      }
    )
  }

  getCapabilitySnapshot(): AgentRuntimeCapabilitySnapshot {
    return this.adapter.getCapabilitySnapshot()
  }

  getSelectedTaskId(): string | null {
    return this.selectedTaskId
  }

  getTaskRuntimeState(taskId: string): AgentTaskRuntimeState {
    return cloneTask(this.requireTask(taskId))
  }

  listTaskRuntimeStates(): AgentTaskRuntimeState[] {
    return Array.from(this.tasks.values(), cloneTask)
  }

  /** Provider 事务用此门禁识别 Turn 或 session 操作，避免 ready 状态下并发打断恢复。 */
  hasInFlightOperation(): boolean {
    return (
      (this.operationGate?.getState() ?? 'idle') !== 'idle' ||
      this.sessionOperationActive ||
      this.taskExecutor?.hasActiveExecution() === true ||
      this.executionController.hasActiveTurn()
    )
  }

  /** 连接前再次校验工作区，并禁止连接动作隐式打断活动 Turn。 */
  async connect(
    projectIdOrWorkspace: string,
    inheritedLease?: OperationLease
  ): Promise<AgentRuntimeStatus> {
    return this.runExclusiveSessionOperation(async (lease) => {
      const validatedWorkspace = await this.resolveWorkspace(projectIdOrWorkspace)
      this.assertOperationLeaseCurrent(lease)
      if (this.executionController.hasActiveTurn()) {
        throw new AgentServiceError('invalid-state', '活动 Turn 收束前不能重新连接 Runtime。')
      }
      return this.connectWithinSessionOperation(validatedWorkspace, lease)
    }, inheritedLease)
  }

  /**
   * 断开直接委托 Adapter 终止 Runtime；不得先等待可能永不返回的 ACP cancel。
   * Adapter 成功收束后再释放服务层槽位，避免 Provider 重连和应用退出被取消请求卡住。
   */
  async disconnect(inheritedLease?: OperationLease): Promise<AgentRuntimeStatus> {
    return this.runExclusiveSessionOperation(async (lease) => {
      const activeTurn = this.executionController.getActiveTurn()
      const status = await this.runAdapterOperation(() => this.adapter.disconnect())
      this.assertOperationLeaseCurrent(lease)
      if (activeTurn) {
        await this.flushHistoryWrites(activeTurn.taskId, activeTurn.turnId).catch(() => undefined)
        this.finishTurn(activeTurn.taskId, activeTurn.turnId, 'cancelled')
        await this.taskStore
          ?.finishTurn(activeTurn.taskId, activeTurn.turnId, 'cancelled')
          .catch(() => undefined)
        this.executionController.release(activeTurn)
        await this.permissionBroker?.cancelTurn(activeTurn.taskId, activeTurn.turnId)
      }
      this.selectedTaskId = null
      return status
    }, inheritedLease)
  }

  /** 新 Task 创建唯一产品 ID，并把 Adapter 返回的 session 引用仅保存在主进程注册表。 */
  async createTask(
    projectIdOrWorkspace: string,
    inheritedLease?: OperationLease
  ): Promise<AgentTaskRuntimeState> {
    return this.runExclusiveSessionOperation(async (lease) => {
      const validatedWorkspace = await this.resolveWorkspace(projectIdOrWorkspace)
      this.assertOperationLeaseCurrent(lease)
      if (this.executionController.hasActiveTurn()) {
        throw new AgentServiceError('invalid-state', '活动 Turn 执行期间不能创建新 Task。')
      }
      this.assertRuntimeReady(validatedWorkspace)
      const taskId = this.allocateTaskId()
      // 必须在等待 createSession 前登记：否则期间到达的命令快照会因未知 taskId 被丢掉。
      this.pendingAvailableCommandTaskIds.add(taskId)
      try {
        const session = await this.runAdapterOperation(async () =>
          this.adapter.createSession({
            workspace: validatedWorkspace,
            taskId,
            mcpServers: await this.resolveMcpServers()
          })
        )
        this.assertOperationLeaseCurrent(lease)
        this.assertSessionRef(session, validatedWorkspace)

        const observedAt = this.now()
        const task: AgentTaskRecord = {
          taskId,
          ...(this.projectRegistry ? { projectId: projectIdOrWorkspace } : {}),
          runtimeId: this.adapter.runtimeId,
          workspace: validatedWorkspace,
          runtimeSessionId: session.runtimeSessionId,
          state: 'pending',
          createdAt: observedAt,
          updatedAt: observedAt,
          session
        }
        if (this.taskStore && task.projectId) {
          try {
            await this.taskStore.createTask({
              taskId,
              projectId: task.projectId,
              root: validatedWorkspace,
              runtimeId: task.runtimeId,
              session,
              capabilitySnapshot: this.adapter.getCapabilitySnapshot()
            })
          } catch (error) {
            await this.adapter.closeSession(session).catch(() => undefined)
            throw error
          }
        }
        this.tasks.set(taskId, task)
        this.selectedTaskId = taskId
        return cloneTask(task)
      } catch (error) {
        this.availableCommands.delete(taskId)
        throw error
      } finally {
        this.pendingAvailableCommandTaskIds.delete(taskId)
      }
    }, inheritedLease)
  }

  /**
   * 为每轮 Prompt 分配新的 turnId；同 Task 复用 session，切回旧 Task 时先恢复其绑定会话。
   * 第二个并发调用在生成 ID 前即被明确拒绝。
   */
  async startTurn(taskId: string, prompt: string): Promise<AgentTurnExecutionResult> {
    this.requireTask(taskId)
    const validatedPrompt = validatePrompt(prompt)
    if (this.sessionOperationActive || this.executionController.hasActiveTurn()) {
      throw new AgentServiceError('invalid-state', '已有 Turn 正在执行。')
    }
    // 先确保本 Task 的 session 已接上或已同 Task 降级重建，再生成 turnId。
    await this.ensureTaskSessionForTurn(taskId)
    const liveTask = this.requireTask(taskId)
    this.assertRuntimeReady(liveTask.workspace)

    const turnId = this.allocateTurnId()
    const turnRef: AgentRuntimeTurnRef = {
      taskId: liveTask.taskId,
      turnId,
      runtimeSessionId: liveTask.runtimeSessionId
    }
    if (this.taskStore) {
      await this.taskStore.createTurn({
        taskId: liveTask.taskId,
        turnId,
        promptDisplayText: this.redactText(validatedPrompt),
        model: this.getTurnModel()
      })
    }
    this.markTurnRunning(liveTask, turnId)

    try {
      const result = await this.executionController.execute(turnRef, async () => {
        await this.activateTaskSession(liveTask)
        await this.taskStore?.markTurnDispatched(liveTask.taskId, turnId)
        return this.adapter.startTurn({
          ...turnRef,
          workspace: liveTask.workspace,
          prompt: validatedPrompt
        })
      })
      await this.flushHistoryWrites(liveTask.taskId, turnId)
      this.finishTurn(liveTask.taskId, turnId, result.outcome)
      await this.taskStore?.finishTurn(liveTask.taskId, turnId, result.outcome)
      return {
        taskId: liveTask.taskId,
        turnId,
        outcome: result.outcome,
        task: cloneTask(liveTask)
      }
    } catch (error) {
      await this.flushHistoryWrites(liveTask.taskId, turnId)
      this.finishTurn(liveTask.taskId, turnId, 'failed')
      await this.taskStore?.finishTurn(liveTask.taskId, turnId, 'failed').catch(() => undefined)
      throw normalizeServiceError(error)
    }
  }

  /** 重复取消同一活动 Turn 只会向 Adapter 发送一次请求；终态仍由 Runtime 回包确认。 */
  async cancelTurn(request: string | TaskExecutionCancellationRequest): Promise<void> {
    if (typeof request !== 'string' && this.taskExecutor) {
      const cancelled = await this.taskExecutor.cancel(request)
      if (!cancelled) {
        throw new AgentServiceError('invalid-state', '指定 execution 当前不可取消。')
      }
      return
    }
    const taskId = typeof request === 'string' ? request : request.taskId
    this.requireTask(taskId)
    const activeTurn = this.executionController.getActiveTurn()
    if (!activeTurn) return
    if (activeTurn.taskId !== taskId) {
      throw new AgentServiceError('invalid-state', '指定 Task 当前没有活动 Turn。')
    }

    try {
      await this.executionController.cancel((turn) => this.adapter.cancelTurn(turn))
    } catch (error) {
      throw normalizeServiceError(error)
    }
  }

  /** 关闭 Task 时不影响其他内存 Task；活动 Task 必须先完成或取消。 */
  async closeTask(taskId: string, inheritedLease?: OperationLease): Promise<void> {
    const task = this.requireTask(taskId)
    const activeTurn = this.executionController.getActiveTurn()
    if (activeTurn?.taskId === taskId) {
      throw new AgentServiceError('invalid-state', '活动 Turn 收束前不能关闭 Task。')
    }

    await this.runExclusiveSessionOperation(async (lease) => {
      await this.runAdapterOperation(() => this.adapter.closeSession(task.session))
      this.assertOperationLeaseCurrent(lease)
      this.availableCommands.delete(taskId)
      this.tasks.delete(taskId)
      await this.permissionBroker?.invalidateTask(taskId)
      if (this.selectedTaskId === taskId) this.selectedTaskId = null
    }, inheritedLease)
  }

  /**
   * Adapter sink 收到权限请求后调用此方法；只有完全匹配当前 Turn/session 的请求才改变状态。
   */
  handlePermissionRequest(request: AgentRuntimePermissionRequest): void {
    const task = this.tasks.get(request.taskId)
    if (
      !task ||
      !task.projectId ||
      !this.permissionBroker ||
      !this.isRuntimePermissionCurrent(request)
    ) {
      this.adapter.respondPermission(request.requestId, 'cancelled')
      return
    }
    if (
      this.runtimePermissionRequests.has(request.requestId) ||
      this.runtimePermissionRequests.size >= MAX_RUNTIME_PERMISSION_REQUESTS
    ) {
      this.adapter.respondPermission(request.requestId, 'cancelled')
      return
    }
    this.runtimePermissionRequests.set(request.requestId, request)
    const environmentId = createLocalEnvironmentId(task.projectId, task.workspace)
    void this.authorizeRuntimePermission(request, task.projectId, task.workspace, environmentId)
  }

  /**
   * 先解析共享记忆根再授权，避免 Grok 写 MEMORY.md 被当成项目外逃逸。
   */
  private async authorizeRuntimePermission(
    request: AgentRuntimePermissionRequest,
    projectId: string,
    workspace: string,
    environmentId: string
  ): Promise<void> {
    if (!this.permissionBroker) {
      this.releaseRuntimePermission(request, 'cancelled')
      return
    }
    const trustedExternalRoots = await this.resolveTrustedExternalRoots()
    if (!this.isRuntimePermissionActive(request)) {
      this.releaseRuntimePermission(request, 'cancelled')
      return
    }
    void this.permissionBroker
      .authorizeOperation(
        {
          initiator: { kind: 'runtime', runtimeId: request.runtimeId },
          taskId: request.taskId,
          turnId: request.turnId,
          projectId,
          environmentId,
          executionRoot: workspace,
          operationType: request.operationType,
          targets: request.targets,
          parameterFingerprint: request.parameterFingerprint,
          title: request.title,
          impact: request.impact,
          ...(request.minimumRisk ? { minimumRisk: request.minimumRisk } : {}),
          ...(trustedExternalRoots.length ? { trustedExternalRoots } : {})
        },
        () => {
          if (!this.isRuntimePermissionActive(request)) throw new Error('permission-stale')
          this.adapter.respondPermission(request.requestId, 'allow-once')
        },
        {
          executionSupported: request.executionSupported,
          isActive: () => this.isRuntimePermissionActive(request),
          onPendingChange: (count) => this.updatePermissionWaitingState(request, count),
          cancellationId: request.requestId
        }
      )
      .then((result) => {
        if (result.ok) return
        this.adapter.respondPermission(
          request.requestId,
          result.reason === 'user-denied' ? 'deny-once' : 'cancelled'
        )
      })
      .catch(() => this.adapter.respondPermission(request.requestId, 'cancelled'))
      .finally(() => {
        if (this.runtimePermissionRequests.get(request.requestId) === request) {
          this.runtimePermissionRequests.delete(request.requestId)
        }
      })
  }

  /**
   * Adapter 在无 Turn 时也会推送命令快照。未知 Task 丢弃；
   * createSession 期间的 pending taskId 必须能收下，否则快照会在登记前丢失。
   * 只接受更新的 revision，避免乱序覆盖。
   */
  handleAvailableCommands(snapshot: AgentAvailableCommandSnapshot): void {
    if (
      !this.tasks.has(snapshot.taskId) &&
      !this.pendingAvailableCommandTaskIds.has(snapshot.taskId)
    ) {
      return
    }
    const current = this.availableCommands.get(snapshot.taskId)
    if (current && snapshot.revision <= current.revision) return
    this.availableCommands.set(snapshot.taskId, cloneAvailableCommandSnapshot(snapshot))
  }

  /** Task 存在但尚未收到快照时返回 revision 0 空列表，供命令板显示等待/空。 */
  getAvailableCommands(taskId: string): AgentAvailableCommandSnapshot {
    this.requireTask(taskId)
    const stored = this.availableCommands.get(taskId)
    if (!stored) {
      return { taskId, revision: 0, commands: [] }
    }
    return cloneAvailableCommandSnapshot(stored)
  }

  /** Adapter 已在本地取消 ACP Promise；这里只撤销完全匹配的 Broker 审批与 Renderer 投影。 */
  handlePermissionCancellation(cancellation: AgentRuntimePermissionCancellation): void {
    const request = this.runtimePermissionRequests.get(cancellation.requestId)
    if (!request || !matchesRuntimePermissionCancellation(request, cancellation)) return
    this.runtimePermissionRequests.delete(cancellation.requestId)
    void this.permissionBroker?.cancelAuthorization(
      cancellation.requestId,
      cancellation.taskId,
      cancellation.turnId
    )
  }

  /** Renderer 只提交产品级决策，Broker 负责身份、过期、重复和允许范围校验。 */
  async respondPermission(request: AgentRespondPermissionRequest): Promise<void> {
    await this.permissionBroker?.respond(request)
  }

  /**
   * Adapter sink 发布中性事件后调用此方法；旧 Turn 或错误 session 的晚到终态不能覆盖新状态。
   */
  handleRuntimeEvent(event: AgentEvent): void {
    if (this.taskExecutor?.handleRuntimeEvent(event)) return
    const task = this.tasks.get(event.taskId)
    if (
      !task ||
      event.runtimeId !== task.runtimeId ||
      event.turnId !== task.activeTurnId ||
      (event.runtimeSessionId && event.runtimeSessionId !== task.runtimeSessionId)
    ) {
      return
    }
    this.queueHistoryWrite(event.taskId, event.turnId, async () => {
      const result =
        (await this.taskStore?.appendEvent(projectPersistedAgentEvent(event, this.redactText))) ??
        null
      if (result?.kind === 'committed' || result?.kind === 'repaired') {
        this.safeNotifyCommittedEvent(event)
      }
    })
    if (event.kind !== 'turn-complete') return

    this.finishTurn(event.taskId, event.turnId, event.outcome)
    this.executionController.release({
      taskId: event.taskId,
      turnId: event.turnId,
      runtimeSessionId: task.runtimeSessionId
    })
  }

  /**
   * 点进历史后的自动进入：只提交 taskId，恢复失败返回可序列化结论而不是必须确认的硬错。
   */
  async enterTask(taskId: string): Promise<ConversationEntryState> {
    const task = this.requireTask(taskId)
    const generation = ++this.enterGeneration
    const previous = this.enterInFlight
    if (previous) {
      await previous.promise.catch(() => undefined)
    }
    if (generation !== this.enterGeneration) {
      return this.supersededEntry(task.taskId)
    }
    const promise = this.runEnterTask(task, generation)
    this.enterInFlight = { taskId: task.taskId, generation, promise }
    try {
      return await promise
    } finally {
      if (this.enterInFlight?.generation === generation) {
        this.enterInFlight = null
      }
    }
  }

  /** 发送前等待同一 Task 尚未结束的自动进入，避免和 session 操作抢 Gate。 */
  async waitForEnter(taskId: string): Promise<ConversationEntryState | null> {
    if (this.enterInFlight?.taskId === taskId) {
      return this.enterInFlight.promise
    }
    return null
  }

  /**
   * 发送前保证本 Task 已接上绑定 session；resume/load 都失败则同 Task 重建，不换 taskId。
   */
  async ensureTaskSessionForTurn(taskId: string, inheritedLease?: OperationLease): Promise<void> {
    await this.waitForEnter(taskId)
    const task = this.requireTask(taskId)
    if (this.isForeignExecutionActive(taskId)) {
      throw new AgentServiceError('invalid-state', '先停掉当前任务。')
    }
    if (this.isTaskSessionActive(task)) return
    await this.activateOrRebuildTaskSession(task, inheritedLease)
  }

  /** 只读历史显式继续时重新连接 Project，并在当前能力验证后恢复原生会话。 */
  async resumeTask(taskId: string, inheritedLease?: OperationLease): Promise<RuntimeResumeSummary> {
    const task = this.requireTask(taskId)
    if (!task.projectId || !this.projectRegistry) {
      throw new AgentServiceError('history-not-found', '该 Task 不包含可恢复的 Project 历史。')
    }
    return this.runExclusiveSessionOperation(async (lease) => {
      const validatedWorkspace = await this.projectRegistry!.resolveAvailableRoot(task.projectId!)
      this.assertOperationLeaseCurrent(lease)
      await this.connectWithinSessionOperation(validatedWorkspace, lease)
      const method = await this.activateTaskSession(task, lease)
      return {
        resumed: true,
        ...(method ? { method } : {}),
        message:
          method === 'load' ? '已通过 Runtime load 恢复 Task。' : '已恢复 Runtime Task 上下文。',
        task: cloneTask(task)
      }
    }, inheritedLease)
  }

  private requireTask(taskId: string): AgentTaskRecord {
    validateIdentifier(taskId, 'Task ID')
    const task = this.tasks.get(taskId)
    if (!task) throw new AgentServiceError('task-not-found', '未找到指定 Task。')
    return task
  }

  private assertRuntimeReady(workspace: string): void {
    const status = this.adapter.getStatus()
    if (status.runtimeId !== this.adapter.runtimeId || status.state !== 'ready') {
      throw new AgentServiceError('invalid-state', '请先连接 Agent Runtime。')
    }
    if (status.workspace !== workspace) {
      throw new AgentServiceError('workspace-mismatch', 'Task 不属于当前已连接项目。')
    }
  }

  private assertSessionRef(session: AgentRuntimeSessionRef, workspace: string): void {
    if (
      session.runtimeId !== this.adapter.runtimeId ||
      session.workspace !== workspace ||
      !isValidIdentifier(session.runtimeSessionId)
    ) {
      throw new AgentServiceError('operation-failed', 'Runtime 返回了无效的 session 引用。')
    }
  }

  /** 切 Task 时优先 resume；连接仍可信时才回退 load，成功后才更新当前会话指针。 */
  private async activateTaskSession(
    task: AgentTaskRecord,
    lease?: OperationLease,
    generation?: number
  ): Promise<'resume' | 'load' | undefined> {
    if (this.isTaskSessionActive(task)) return undefined

    const snapshot = this.adapter.getCapabilitySnapshot()
    const canResume = isUsableRestoreCapability(snapshot, 'session.resume')
    const canLoad = isUsableRestoreCapability(snapshot, 'session.load')
    if (!canResume && !canLoad) {
      throw new AgentServiceError(
        'session-restore-unsupported',
        '当前 Runtime 未验证会话恢复能力，不能切换到该 Task。'
      )
    }

    let resumeError: unknown
    if (canResume) {
      try {
        await this.adapter.resumeSession(task.session, task.taskId, await this.resolveMcpServers())
        this.assertOperationLeaseCurrent(lease)
        if (!this.canCommitEnter(generation)) return undefined
        this.selectedTaskId = task.taskId
        return 'resume'
      } catch (error) {
        this.assertOperationLeaseCurrent(lease)
        resumeError = error
      }
    }

    if (canLoad) {
      const currentStatus = this.adapter.getStatus()
      if (
        resumeError &&
        (currentStatus.state !== 'ready' || currentStatus.workspace !== task.workspace)
      ) {
        // resume 可能因安全门禁主动废弃连接；此时保留原始诊断，禁止用后续 load 错误覆盖根因。
        throw normalizeServiceError(resumeError)
      }
      try {
        await this.adapter.loadSession(task.session, task.taskId, await this.resolveMcpServers())
        this.assertOperationLeaseCurrent(lease)
        if (!this.canCommitEnter(generation)) return undefined
        this.selectedTaskId = task.taskId
        return 'load'
      } catch (error) {
        throw normalizeServiceError(error)
      }
    }

    throw normalizeServiceError(resumeError)
  }

  private async runEnterTask(
    task: AgentTaskRecord,
    generation: number
  ): Promise<ConversationEntryState> {
    if (!task.projectId || !this.projectRegistry) {
      return this.createEntryState(task.taskId, {
        restore: 'unavailable',
        verification: 'unverified',
        reason: '该 Task 不包含可恢复的 Project 历史。'
      })
    }
    if (this.isForeignExecutionActive(task.taskId)) {
      return this.createEntryState(task.taskId, {
        restore: 'idle',
        verification: 'unverified',
        reason: '先停掉当前任务。'
      })
    }
    try {
      await this.projectRegistry.resolveAvailableRoot(task.projectId)
    } catch (error) {
      return this.createEntryState(task.taskId, {
        restore: 'unavailable',
        verification: 'unverified',
        reason: error instanceof Error ? error.message : 'Project 目录不可用。'
      })
    }
    if (!this.canCommitEnter(generation)) return this.supersededEntry(task.taskId)

    try {
      return await this.runExclusiveSessionOperation(async (lease) => {
        if (!this.canCommitEnter(generation)) return this.supersededEntry(task.taskId)
        const validatedWorkspace = await this.projectRegistry!.resolveAvailableRoot(task.projectId!)
        this.assertOperationLeaseCurrent(lease)
        if (!this.canCommitEnter(generation)) return this.supersededEntry(task.taskId)
        await this.connectWithinSessionOperation(validatedWorkspace, lease)
        if (!this.canCommitEnter(generation)) return this.supersededEntry(task.taskId)
        const liveTask = this.requireTask(task.taskId)
        if (this.isTaskSessionActive(liveTask)) {
          return this.createEntryState(liveTask.taskId, {
            restore: 'ready',
            method: 'resume',
            verification: this.restoreVerification('session.resume')
          })
        }
        try {
          const method = await this.activateTaskSession(liveTask, lease, generation)
          if (!this.canCommitEnter(generation)) return this.supersededEntry(liveTask.taskId)
          if (method === 'load') {
            return this.createEntryState(liveTask.taskId, {
              restore: 'degraded',
              method: 'load',
              verification: this.restoreVerification('session.load'),
              reason: '可能回放旧输出，上下文完整性未核实。'
            })
          }
          return this.createEntryState(liveTask.taskId, {
            restore: 'ready',
            method: method ?? 'resume',
            verification: this.restoreVerification('session.resume')
          })
        } catch {
          if (!this.canCommitEnter(generation)) return this.supersededEntry(liveTask.taskId)
          return this.createEntryState(liveTask.taskId, {
            restore: 'degraded',
            verification: 'unverified',
            reason: '未能接回上次上下文，发送时会用新上下文接着聊。'
          })
        }
      })
    } catch (error) {
      if (!this.canCommitEnter(generation)) return this.supersededEntry(task.taskId)
      return this.createEntryState(task.taskId, {
        restore: this.isForeignExecutionActive(task.taskId) ? 'idle' : 'degraded',
        verification: 'unverified',
        reason:
          error instanceof AgentServiceError
            ? error.message
            : '未能接回上次上下文，发送时会用新上下文接着聊。'
      })
    }
  }

  private async activateOrRebuildTaskSession(
    task: AgentTaskRecord,
    inheritedLease?: OperationLease
  ): Promise<void> {
    await this.runExclusiveSessionOperation(async (lease) => {
      if (task.projectId && this.projectRegistry) {
        const root = await this.projectRegistry.resolveAvailableRoot(task.projectId)
        this.assertOperationLeaseCurrent(lease)
        await this.connectWithinSessionOperation(root, lease)
      } else {
        this.assertRuntimeReady(task.workspace)
      }
      const liveTask = this.requireTask(task.taskId)
      if (this.isTaskSessionActive(liveTask)) return
      try {
        await this.activateTaskSession(liveTask, lease)
      } catch (error) {
        const status = this.adapter.getStatus()
        const connectionTrusted =
          status.state === 'ready' && status.workspace === liveTask.workspace
        if (!connectionTrusted) {
          if (liveTask.projectId && this.projectRegistry) {
            try {
              const root = await this.projectRegistry.resolveAvailableRoot(liveTask.projectId)
              this.assertOperationLeaseCurrent(lease)
              await this.connectWithinSessionOperation(root, lease)
              await this.rebuildTaskSession(liveTask, lease)
              return
            } catch {
              throw normalizeServiceError(error)
            }
          }
          throw normalizeServiceError(error)
        }
        await this.rebuildTaskSession(liveTask, lease)
      }
    }, inheritedLease)
  }

  /** 丢掉失效 RuntimeSessionRef，在同一 taskId 上 createSession 并写回 TaskStore。 */
  private async rebuildTaskSession(task: AgentTaskRecord, lease?: OperationLease): Promise<void> {
    const session = await this.runAdapterOperation(async () =>
      this.adapter.createSession({
        workspace: task.workspace,
        taskId: task.taskId,
        mcpServers: await this.resolveMcpServers()
      })
    )
    this.assertOperationLeaseCurrent(lease)
    this.assertSessionRef(session, task.workspace)
    task.session = session
    task.runtimeSessionId = session.runtimeSessionId
    task.updatedAt = this.now()
    if (this.taskStore && task.projectId) {
      await this.taskStore.rebindRuntimeSession(
        task.taskId,
        session,
        this.adapter.getCapabilitySnapshot()
      )
    }
    this.selectedTaskId = task.taskId
  }

  private async resolveMcpServers(): Promise<AgentRuntimeMcpServer[]> {
    return (await this.getSessionMcpServers?.()) ?? []
  }

  private isTaskSessionActive(task: AgentTaskRecord): boolean {
    const status = this.adapter.getStatus()
    return (
      this.selectedTaskId === task.taskId &&
      status.state === 'ready' &&
      status.runtimeId === task.runtimeId &&
      status.workspace === task.workspace &&
      status.runtimeSessionId === task.runtimeSessionId &&
      task.session.runtimeId === task.runtimeId &&
      task.session.workspace === task.workspace &&
      task.session.runtimeSessionId === task.runtimeSessionId
    )
  }

  private isForeignExecutionActive(taskId: string): boolean {
    const execution = this.taskExecutor?.getSnapshot().execution
    if (execution && execution.taskId !== taskId && !isTerminalExecutionState(execution.state)) {
      return true
    }
    const activeTurn = this.executionController.getActiveTurn()
    return Boolean(activeTurn && activeTurn.taskId !== taskId)
  }

  private canCommitEnter(generation?: number): boolean {
    return generation === undefined || generation === this.enterGeneration
  }

  private restoreVerification(
    capabilityId: 'session.resume' | 'session.load'
  ): ConversationEntryState['verification'] {
    const capability = this.adapter.getCapabilitySnapshot().capabilities[capabilityId]
    if (capability.support !== 'native' || capability.verification === 'unverified') {
      return 'unverified'
    }
    return capability.verification === 'verified' ? 'verified' : 'declared'
  }

  private supersededEntry(taskId: string): ConversationEntryState {
    return this.createEntryState(taskId, {
      restore: 'idle',
      verification: 'unverified',
      reason: '已切换到其他对话'
    })
  }

  private createEntryState(
    taskId: string,
    fields: Omit<ConversationEntryState, 'taskId' | 'historyReady'>
  ): ConversationEntryState {
    return {
      taskId,
      historyReady: true,
      ...fields
    }
  }

  private markTurnRunning(task: AgentTaskRecord, turnId: string): void {
    task.state = 'running'
    task.activeTurnId = turnId
    task.lastTurnId = turnId
    task.updatedAt = this.now()
  }

  private finishTurn(taskId: string, turnId: string, outcome: AgentTurnOutcome): void {
    const task = this.tasks.get(taskId)
    if (!task || task.activeTurnId !== turnId) return

    task.state = mapOutcomeToExecutionState(outcome)
    delete task.activeTurnId
    task.updatedAt = this.now()
    void this.permissionBroker?.cancelTurn(taskId, turnId)
  }

  private async resolveTrustedExternalRoots(): Promise<string[]> {
    try {
      const roots = (await this.getTrustedExternalRoots?.()) ?? []
      return Array.isArray(roots) ? roots.filter((root) => typeof root === 'string') : []
    } catch {
      return []
    }
  }

  private releaseRuntimePermission(
    request: AgentRuntimePermissionRequest,
    resolution: 'cancelled'
  ): void {
    if (this.runtimePermissionRequests.get(request.requestId) === request) {
      this.runtimePermissionRequests.delete(request.requestId)
    }
    this.adapter.respondPermission(request.requestId, resolution)
  }

  private isRuntimePermissionCurrent(request: AgentRuntimePermissionRequest): boolean {
    const task = this.tasks.get(request.taskId)
    const executorTurn = this.taskExecutor?.getActiveRuntimeTurn()
    if (executorTurn) {
      return Boolean(
        task &&
        request.runtimeId === task.runtimeId &&
        executorTurn.taskId === request.taskId &&
        executorTurn.turnId === request.turnId &&
        executorTurn.runtimeSessionId === task.runtimeSessionId &&
        request.runtimeSessionId === task.runtimeSessionId
      )
    }
    const activeTurn = this.executionController.getActiveTurn()
    return Boolean(
      task &&
      activeTurn &&
      request.runtimeId === task.runtimeId &&
      activeTurn.taskId === request.taskId &&
      activeTurn.turnId === request.turnId &&
      activeTurn.runtimeSessionId === task.runtimeSessionId &&
      request.runtimeSessionId === task.runtimeSessionId &&
      task.activeTurnId === request.turnId
    )
  }

  private isRuntimePermissionActive(request: AgentRuntimePermissionRequest): boolean {
    return (
      this.runtimePermissionRequests.get(request.requestId) === request &&
      this.isRuntimePermissionCurrent(request)
    )
  }

  /** 多个并发审批只在全部收束后恢复 running，避免第二个等待请求被错误覆盖。 */
  private updatePermissionWaitingState(
    request: AgentRuntimePermissionRequest,
    pendingCount: number
  ): void {
    if (this.taskExecutor?.getActiveIdentity()?.turnId === request.turnId) {
      void this.taskExecutor.updatePermissionPendingCount(pendingCount)
      return
    }
    const task = this.tasks.get(request.taskId)
    if (!task || task.activeTurnId !== request.turnId) return
    const waiting = pendingCount > 0
    task.state = waiting ? 'waiting-permission' : 'running'
    task.updatedAt = this.now()
    this.queueHistoryWrite(
      request.taskId,
      request.turnId,
      () =>
        this.taskStore?.setPermissionState(request.taskId, request.turnId, waiting) ??
        Promise.resolve()
    )
  }

  private allocateTurnId(): string {
    const turnId = validateGeneratedIdentifier(this.createId(), 'Turn ID')
    if (this.allocatedTurnIds.has(turnId)) {
      throw new AgentServiceError('operation-failed', '无法分配唯一 Turn ID。')
    }
    this.allocatedTurnIds.add(turnId)
    return turnId
  }

  private allocateTaskId(): string {
    const taskId = validateGeneratedIdentifier(this.createId(), 'Task ID')
    if (this.allocatedTaskIds.has(taskId)) {
      throw new AgentServiceError('operation-failed', '无法分配唯一 Task ID。')
    }
    this.allocatedTaskIds.add(taskId)
    return taskId
  }

  private async runAdapterOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      throw normalizeServiceError(error)
    }
  }

  /**
   * session 创建、关闭和连接切换统一复用 OperationGate；外层 Provider/execution 事务显式传入 owner lease。
   * 未注入 Gate 的旧单测仍保留布尔门禁，避免一次迁移同时删除旧 Controller 兼容路径。
   */
  private async runExclusiveSessionOperation<T>(
    operation: (lease?: OperationLease) => Promise<T>,
    inheritedLease?: OperationLease
  ): Promise<T> {
    if (this.operationGate) {
      let lease = inheritedLease
      let ownsLease = false
      if (!lease) {
        try {
          lease = this.operationGate.acquireSessionOperation()
          ownsLease = true
        } catch {
          throw new AgentServiceError('invalid-state', this.operationConflictMessage())
        }
      }
      this.assertOperationLeaseAllowed(lease)
      try {
        const result = await operation(lease)
        this.assertOperationLeaseCurrent(lease)
        return result
      } finally {
        if (ownsLease) lease.release()
      }
    }
    if (inheritedLease) {
      throw new AgentServiceError('invalid-state', 'Runtime 会话事务未启用共享门禁。')
    }
    if (this.sessionOperationActive) {
      throw new AgentServiceError('invalid-state', '已有 Runtime 会话操作正在执行。')
    }

    this.sessionOperationActive = true
    try {
      return await operation()
    } finally {
      this.sessionOperationActive = false
    }
  }

  /** 已取得 session/provider/execution lease 后执行连接主体，禁止嵌套再次抢占 Gate。 */
  private async connectWithinSessionOperation(
    validatedWorkspace: string,
    lease?: OperationLease
  ): Promise<AgentRuntimeStatus> {
    const previousWorkspace = this.adapter.getStatus().workspace
    const status = await this.runAdapterOperation(() => this.adapter.connect(validatedWorkspace))
    this.assertOperationLeaseCurrent(lease)
    if (previousWorkspace && previousWorkspace !== validatedWorkspace) {
      this.permissionBroker?.clearTaskGrants()
    }
    const selectedTask = this.selectedTaskId ? this.tasks.get(this.selectedTaskId) : undefined
    if (
      !selectedTask ||
      status.workspace !== selectedTask.workspace ||
      status.runtimeSessionId !== selectedTask.runtimeSessionId
    ) {
      // 新连接尚未激活 Task session，旧选择指针必须失效，下一轮才能执行 resume/load。
      this.selectedTaskId = null
    }
    return status
  }

  private assertOperationLeaseAllowed(lease: OperationLease): void {
    if (
      this.operationGate?.isShuttingDown() ||
      !['session-operation', 'provider-mutation', 'execution-active'].includes(lease.kind) ||
      !this.operationGate?.ownsCurrentLease(lease)
    ) {
      throw new AgentServiceError('invalid-state', 'Runtime 会话事务身份已经失效。')
    }
  }

  private assertOperationLeaseCurrent(lease?: OperationLease): void {
    if (!lease) return
    if (!this.operationGate?.ownsCurrentLease(lease) || this.operationGate.isShuttingDown()) {
      throw new AgentServiceError('invalid-state', 'Runtime 会话事务已被新的主进程状态取代。')
    }
  }

  private operationConflictMessage(): string {
    const state = this.operationGate?.getState()
    if (state === 'execution-active' || state === 'admitting-execution') {
      return '活动 Turn 收束前不能切换 Runtime 会话。'
    }
    if (state === 'provider-mutation') return '模型配置更新期间不能切换 Runtime 会话。'
    if (state === 'shutting-down') return '应用正在退出，不能开始 Runtime 会话操作。'
    return '已有 Runtime 会话操作正在执行。'
  }

  private async resolveWorkspace(projectIdOrWorkspace: string): Promise<string> {
    return this.projectRegistry
      ? this.projectRegistry.resolveAvailableRoot(projectIdOrWorkspace)
      : validateWorkspace(projectIdOrWorkspace)
  }

  private safeNotifyCommittedEvent(event: AgentEvent): void {
    try {
      this.onEvent(event)
    } catch {
      // Renderer observer 失败不能回滚已提交的历史事实。
    }
  }

  private queueHistoryWrite(taskId: string, turnId: string, operation: () => Promise<void>): void {
    if (!this.taskStore) return
    const key = `${taskId}:${turnId}`
    const previous = this.historyWrites.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.historyWrites.set(key, current)
    void current.then(
      () => {
        if (this.historyWrites.get(key) === current) this.historyWrites.delete(key)
      },
      () => undefined
    )
  }

  private async flushHistoryWrites(taskId: string, turnId: string): Promise<void> {
    const key = `${taskId}:${turnId}`
    const current = this.historyWrites.get(key)
    if (!current) return
    try {
      await current
    } finally {
      if (this.historyWrites.get(key) === current) this.historyWrites.delete(key)
    }
  }
}

function cloneAvailableCommandSnapshot(
  snapshot: AgentAvailableCommandSnapshot
): AgentAvailableCommandSnapshot {
  return {
    taskId: snapshot.taskId,
    revision: snapshot.revision,
    commands: snapshot.commands.map((command) =>
      command.inputHint === undefined
        ? { name: command.name, description: command.description }
        : { name: command.name, description: command.description, inputHint: command.inputHint }
    )
  }
}

function matchesRuntimePermissionCancellation(
  request: AgentRuntimePermissionRequest,
  cancellation: AgentRuntimePermissionCancellation
): boolean {
  return (
    request.requestId === cancellation.requestId &&
    request.runtimeId === cancellation.runtimeId &&
    request.taskId === cancellation.taskId &&
    request.turnId === cancellation.turnId &&
    request.runtimeSessionId === cancellation.runtimeSessionId &&
    request.toolCallId === cancellation.toolCallId
  )
}

function validateWorkspace(workspace: string): string {
  const value = validateRequiredText(workspace, MAX_WORKSPACE_BYTES, '工作区')
  if (!isAbsolute(value)) {
    throw new AgentServiceError('invalid-input', '工作区必须是绝对路径。')
  }
  return value
}

function validatePrompt(prompt: string): string {
  return validateRequiredText(prompt, MAX_PROMPT_BYTES, 'Prompt')
}

function validateIdentifier(value: string, label: string): string {
  if (!isValidIdentifier(value)) {
    throw new AgentServiceError('invalid-input', `${label} 无效。`)
  }
  return value
}

function validateGeneratedIdentifier(value: string, label: string): string {
  if (!isValidIdentifier(value)) {
    throw new AgentServiceError('operation-failed', `${label} 生成失败。`)
  }
  return value
}

function isValidIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= MAX_IDENTIFIER_BYTES
  )
}

function validateRequiredText(value: string, maxBytes: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new AgentServiceError('invalid-input', `${label} 无效。`)
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new AgentServiceError('payload-too-large', `${label} 内容过大。`)
  }
  return value
}

/** 将执行层与 Adapter 错误收敛为有限服务错误，禁止未知异常细节穿过 IPC。 */
function normalizeServiceError(error: unknown): AgentServiceError {
  if (error instanceof AgentServiceError) return error
  if (error instanceof TaskExecutionConflictError) {
    return new AgentServiceError('invalid-state', error.message)
  }
  if (error instanceof AgentRuntimeAdapterError) {
    return new AgentServiceError(error.code, error.message)
  }
  if (error instanceof ProjectRegistryError || error instanceof TaskStoreError) {
    return new AgentServiceError(error.code, error.message)
  }
  return new AgentServiceError('operation-failed', 'Agent Runtime 操作失败。')
}

function mapHistoryStateToRuntimeState(state: TaskRecordV1['state']): AgentExecutionState {
  if (state === 'queued' || state === 'cancelling') return 'running'
  if (state === 'interrupted') return 'failed'
  return state
}

function restoreRuntimeTask(task: TaskRecordV1): AgentTaskRecord {
  const state: AgentExecutionState = mapHistoryStateToRuntimeState(task.state)
  return {
    taskId: task.taskId,
    projectId: task.projectId,
    runtimeId: task.runtimeId,
    workspace: task.environment.rootSnapshot,
    runtimeSessionId: task.runtimeSession.runtimeSessionId,
    session: {
      runtimeId: task.runtimeSession.runtimeId,
      runtimeSessionId: task.runtimeSession.runtimeSessionId,
      workspace: task.runtimeSession.workspace
    },
    state,
    ...(task.lastTurnId ? { lastTurnId: task.lastTurnId } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  }
}
