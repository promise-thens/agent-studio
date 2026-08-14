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
import type { RuntimeResumeSummary, TurnModelSnapshot } from '../../shared/task-history'
import {
  AgentRuntimeAdapterError,
  type AgentRuntimeAdapter,
  type AgentRuntimeAdapterErrorCode,
  type AgentRuntimePermissionCancellation,
  type AgentRuntimePermissionRequest,
  type AgentRuntimeSessionRef,
  type AgentRuntimeTurnRef
} from './agent-runtime-adapter'
import { TaskExecutionConflictError, TaskExecutionController } from './task-execution-controller'
import { ProjectRegistry, ProjectRegistryError } from '../project/project-registry'
import {
  projectPersistedAgentEvent,
  TaskStore,
  TaskStoreError,
  type TaskRecordV1
} from './task-store'
import type { AgentRespondPermissionRequest } from '../../shared/agent-ipc'
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
  private readonly allocatedTurnIds = new Set<string>()
  private selectedTaskId: string | null = null
  private sessionOperationActive = false
  private readonly createId: () => string
  private readonly now: () => string
  private readonly projectRegistry?: ProjectRegistry
  private readonly taskStore?: TaskStore
  private readonly getTurnModel: () => TurnModelSnapshot
  private readonly redactText: (text: string) => string
  private readonly permissionBroker?: PermissionBroker
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
    for (const persistedTask of this.taskStore?.listTaskRecords() ?? []) {
      const task = restoreRuntimeTask(persistedTask)
      this.tasks.set(task.taskId, task)
      this.allocatedTaskIds.add(task.taskId)
    }
  }

  getStatus(): AgentRuntimeStatus {
    return this.adapter.getStatus()
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
    return this.sessionOperationActive || this.executionController.hasActiveTurn()
  }

  /** 连接前再次校验工作区，并禁止连接动作隐式打断活动 Turn。 */
  async connect(projectIdOrWorkspace: string): Promise<AgentRuntimeStatus> {
    const validatedWorkspace = await this.resolveWorkspace(projectIdOrWorkspace)
    if (this.executionController.hasActiveTurn()) {
      throw new AgentServiceError('invalid-state', '活动 Turn 收束前不能重新连接 Runtime。')
    }

    return this.runExclusiveSessionOperation(async () => {
      const previousWorkspace = this.adapter.getStatus().workspace
      const status = await this.runAdapterOperation(() => this.adapter.connect(validatedWorkspace))
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
    })
  }

  /**
   * 断开直接委托 Adapter 终止 Runtime；不得先等待可能永不返回的 ACP cancel。
   * Adapter 成功收束后再释放服务层槽位，避免 Provider 重连和应用退出被取消请求卡住。
   */
  async disconnect(): Promise<AgentRuntimeStatus> {
    return this.runExclusiveSessionOperation(async () => {
      const activeTurn = this.executionController.getActiveTurn()
      const status = await this.runAdapterOperation(() => this.adapter.disconnect())
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
    })
  }

  /** 新 Task 创建唯一产品 ID，并把 Adapter 返回的 session 引用仅保存在主进程注册表。 */
  async createTask(projectIdOrWorkspace: string): Promise<AgentTaskRuntimeState> {
    const validatedWorkspace = await this.resolveWorkspace(projectIdOrWorkspace)
    if (this.executionController.hasActiveTurn()) {
      throw new AgentServiceError('invalid-state', '活动 Turn 执行期间不能创建新 Task。')
    }

    return this.runExclusiveSessionOperation(async () => {
      this.assertRuntimeReady(validatedWorkspace)
      const taskId = this.allocateTaskId()
      const session = await this.runAdapterOperation(() =>
        this.adapter.createSession({ workspace: validatedWorkspace })
      )
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
    })
  }

  /**
   * 为每轮 Prompt 分配新的 turnId；同 Task 复用 session，切回旧 Task 时先恢复其绑定会话。
   * 第二个并发调用在生成 ID 前即被明确拒绝。
   */
  async startTurn(taskId: string, prompt: string): Promise<AgentTurnExecutionResult> {
    const task = this.requireTask(taskId)
    const validatedPrompt = validatePrompt(prompt)
    if (this.sessionOperationActive || this.executionController.hasActiveTurn()) {
      throw new AgentServiceError('invalid-state', '已有 Turn 正在执行。')
    }
    this.assertRuntimeReady(task.workspace)

    const turnId = this.allocateTurnId()
    const turnRef: AgentRuntimeTurnRef = {
      taskId: task.taskId,
      turnId,
      runtimeSessionId: task.runtimeSessionId
    }
    if (this.taskStore) {
      await this.taskStore.createTurn({
        taskId: task.taskId,
        turnId,
        promptDisplayText: this.redactText(validatedPrompt),
        model: this.getTurnModel()
      })
    }
    this.markTurnRunning(task, turnId)

    try {
      const result = await this.executionController.execute(turnRef, async () => {
        await this.activateTaskSession(task)
        await this.taskStore?.markTurnDispatched(task.taskId, turnId)
        return this.adapter.startTurn({
          ...turnRef,
          workspace: task.workspace,
          prompt: validatedPrompt
        })
      })
      await this.flushHistoryWrites(task.taskId, turnId)
      this.finishTurn(task.taskId, turnId, result.outcome)
      await this.taskStore?.finishTurn(task.taskId, turnId, result.outcome)
      return {
        taskId: task.taskId,
        turnId,
        outcome: result.outcome,
        task: cloneTask(task)
      }
    } catch (error) {
      await this.flushHistoryWrites(task.taskId, turnId)
      this.finishTurn(task.taskId, turnId, 'failed')
      await this.taskStore?.finishTurn(task.taskId, turnId, 'failed').catch(() => undefined)
      throw normalizeServiceError(error)
    }
  }

  /** 重复取消同一活动 Turn 只会向 Adapter 发送一次请求；终态仍由 Runtime 回包确认。 */
  async cancelTurn(taskId: string): Promise<void> {
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
  async closeTask(taskId: string): Promise<void> {
    const task = this.requireTask(taskId)
    const activeTurn = this.executionController.getActiveTurn()
    if (activeTurn?.taskId === taskId) {
      throw new AgentServiceError('invalid-state', '活动 Turn 收束前不能关闭 Task。')
    }

    await this.runExclusiveSessionOperation(async () => {
      await this.runAdapterOperation(() => this.adapter.closeSession(task.session))
      this.tasks.delete(taskId)
      await this.permissionBroker?.invalidateTask(taskId)
      if (this.selectedTaskId === taskId) this.selectedTaskId = null
    })
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
    void this.permissionBroker
      .authorizeOperation(
        {
          initiator: { kind: 'runtime', runtimeId: request.runtimeId },
          taskId: request.taskId,
          turnId: request.turnId,
          projectId: task.projectId,
          environmentId,
          executionRoot: task.workspace,
          operationType: request.operationType,
          targets: request.targets,
          parameterFingerprint: request.parameterFingerprint,
          title: request.title,
          impact: request.impact,
          ...(request.minimumRisk ? { minimumRisk: request.minimumRisk } : {})
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
    const task = this.tasks.get(event.taskId)
    if (
      !task ||
      event.runtimeId !== task.runtimeId ||
      event.turnId !== task.activeTurnId ||
      (event.runtimeSessionId && event.runtimeSessionId !== task.runtimeSessionId)
    ) {
      return
    }
    this.queueHistoryWrite(
      event.taskId,
      event.turnId,
      () =>
        this.taskStore
          ?.appendEvent(projectPersistedAgentEvent(event, this.redactText))
          .then(() => undefined) ?? Promise.resolve()
    )
    if (event.kind !== 'turn-complete') return

    this.finishTurn(event.taskId, event.turnId, event.outcome)
    this.executionController.release({
      taskId: event.taskId,
      turnId: event.turnId,
      runtimeSessionId: task.runtimeSessionId
    })
  }

  /** 只读历史显式继续时重新连接 Project，并在当前能力验证后恢复原生会话。 */
  async resumeTask(taskId: string): Promise<RuntimeResumeSummary> {
    const task = this.requireTask(taskId)
    if (!task.projectId || !this.projectRegistry) {
      throw new AgentServiceError('history-not-found', '该 Task 不包含可恢复的 Project 历史。')
    }
    await this.projectRegistry.resolveAvailableRoot(task.projectId)
    await this.connect(task.projectId)
    const method = await this.activateTaskSession(task)
    return {
      resumed: true,
      ...(method ? { method } : {}),
      message:
        method === 'load' ? '已通过 Runtime load 恢复 Task。' : '已恢复 Runtime Task 上下文。',
      task: cloneTask(task)
    }
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
  private async activateTaskSession(task: AgentTaskRecord): Promise<'resume' | 'load' | undefined> {
    if (this.selectedTaskId === task.taskId) return undefined

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
        await this.adapter.resumeSession(task.session)
        this.selectedTaskId = task.taskId
        return 'resume'
      } catch (error) {
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
        await this.adapter.loadSession(task.session)
        this.selectedTaskId = task.taskId
        return 'load'
      } catch (error) {
        throw normalizeServiceError(error)
      }
    }

    throw normalizeServiceError(resumeError)
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

  private isRuntimePermissionCurrent(request: AgentRuntimePermissionRequest): boolean {
    const task = this.tasks.get(request.taskId)
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

  /** session 创建、关闭和连接切换串行执行，避免并发响应互相使代次失效。 */
  private async runExclusiveSessionOperation<T>(operation: () => Promise<T>): Promise<T> {
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

  private async resolveWorkspace(projectIdOrWorkspace: string): Promise<string> {
    return this.projectRegistry
      ? this.projectRegistry.resolveAvailableRoot(projectIdOrWorkspace)
      : validateWorkspace(projectIdOrWorkspace)
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

function restoreRuntimeTask(task: TaskRecordV1): AgentTaskRecord {
  const state: AgentExecutionState = task.state === 'interrupted' ? 'failed' : task.state
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
