import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type {
  AgentEvent,
  AgentExecutionState,
  AgentPermissionRequest,
  AgentRuntimeCapabilitySnapshot,
  AgentRuntimeStatus,
  AgentTaskRuntimeState,
  AgentTurnExecutionResult,
  AgentTurnOutcome
} from '../../shared/agent'
import {
  AgentRuntimeAdapterError,
  type AgentRuntimeAdapter,
  type AgentRuntimeAdapterErrorCode,
  type AgentRuntimeSessionRef,
  type AgentRuntimeTurnRef
} from './agent-runtime-adapter'
import { TaskExecutionConflictError, TaskExecutionController } from './task-execution-controller'

const MAX_WORKSPACE_BYTES = 4 * 1024
const MAX_PROMPT_BYTES = 64 * 1024
const MAX_IDENTIFIER_BYTES = 4 * 1024

export type AgentServiceErrorCode =
  | AgentRuntimeAdapterErrorCode
  | 'invalid-input'
  | 'payload-too-large'
  | 'task-not-found'
  | 'workspace-mismatch'

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
}

interface AgentTaskRecord extends AgentTaskRuntimeState {
  runtimeSessionId: string
  session: AgentRuntimeSessionRef
}

interface PendingPermissionRef {
  taskId: string
  turnId: string
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
 * 首版全部为内存态，活动执行槽只委托 TaskExecutionController，避免出现第二份 busy 状态源。
 */
export class AgentService {
  private readonly tasks = new Map<string, AgentTaskRecord>()
  private readonly allocatedTaskIds = new Set<string>()
  private readonly allocatedTurnIds = new Set<string>()
  private readonly pendingPermissions = new Map<string, PendingPermissionRef>()
  private selectedTaskId: string | null = null
  private sessionOperationActive = false
  private readonly createId: () => string
  private readonly now: () => string

  constructor(
    private readonly adapter: AgentRuntimeAdapter,
    private readonly executionController: TaskExecutionController,
    options: AgentServiceOptions = {}
  ) {
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => new Date().toISOString())
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
  async connect(workspace: string): Promise<AgentRuntimeStatus> {
    const validatedWorkspace = validateWorkspace(workspace)
    if (this.executionController.hasActiveTurn()) {
      throw new AgentServiceError('invalid-state', '活动 Turn 收束前不能重新连接 Runtime。')
    }

    return this.runExclusiveSessionOperation(async () => {
      const status = await this.runAdapterOperation(() => this.adapter.connect(validatedWorkspace))
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
        this.finishTurn(activeTurn.taskId, activeTurn.turnId, 'cancelled')
        this.executionController.release(activeTurn)
        this.clearPendingPermissions(activeTurn)
      }
      this.selectedTaskId = null
      return status
    })
  }

  /** 新 Task 创建唯一产品 ID，并把 Adapter 返回的 session 引用仅保存在主进程注册表。 */
  async createTask(workspace: string): Promise<AgentTaskRuntimeState> {
    const validatedWorkspace = validateWorkspace(workspace)
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
        runtimeId: this.adapter.runtimeId,
        workspace: validatedWorkspace,
        runtimeSessionId: session.runtimeSessionId,
        state: 'pending',
        createdAt: observedAt,
        updatedAt: observedAt,
        session
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
    this.markTurnRunning(task, turnId)

    try {
      const result = await this.executionController.execute(turnRef, async () => {
        await this.activateTaskSession(task)
        return this.adapter.startTurn({
          ...turnRef,
          workspace: task.workspace,
          prompt: validatedPrompt
        })
      })
      this.finishTurn(task.taskId, turnId, result.outcome)
      return {
        taskId: task.taskId,
        turnId,
        outcome: result.outcome,
        task: cloneTask(task)
      }
    } catch (error) {
      this.finishTurn(task.taskId, turnId, 'failed')
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
      this.clearPendingPermissions({
        taskId,
        turnId: task.activeTurnId ?? '',
        runtimeSessionId: task.runtimeSessionId
      })
      if (this.selectedTaskId === taskId) this.selectedTaskId = null
    })
  }

  /**
   * Adapter sink 收到权限请求后调用此方法；只有完全匹配当前 Turn/session 的请求才改变状态。
   */
  handlePermissionRequest(request: AgentPermissionRequest): void {
    const task = this.tasks.get(request.taskId)
    const activeTurn = this.executionController.getActiveTurn()
    if (
      !task ||
      !activeTurn ||
      request.runtimeId !== task.runtimeId ||
      activeTurn.taskId !== request.taskId ||
      activeTurn.turnId !== request.turnId ||
      activeTurn.runtimeSessionId !== task.runtimeSessionId ||
      (request.runtimeSessionId && request.runtimeSessionId !== task.runtimeSessionId)
    ) {
      return
    }

    this.pendingPermissions.set(request.id, {
      taskId: request.taskId,
      turnId: request.turnId
    })
    task.state = 'waiting-permission'
    task.updatedAt = this.now()
  }

  /** 权限响应只转发一次；重复、晚到或不属于当前 Turn 的响应安全忽略。 */
  respondPermission(requestId: string, optionId?: string): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return

    this.pendingPermissions.delete(requestId)
    this.adapter.respondPermission(requestId, optionId)
    const task = this.tasks.get(pending.taskId)
    if (task?.activeTurnId === pending.turnId && task.state === 'waiting-permission') {
      task.state = 'running'
      task.updatedAt = this.now()
    }
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
    if (event.kind !== 'turn-complete') return

    this.finishTurn(event.taskId, event.turnId, event.outcome)
    this.executionController.release({
      taskId: event.taskId,
      turnId: event.turnId,
      runtimeSessionId: task.runtimeSessionId
    })
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
  private async activateTaskSession(task: AgentTaskRecord): Promise<void> {
    if (this.selectedTaskId === task.taskId) return

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
        return
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
        return
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
    this.clearPendingPermissions({ taskId, turnId, runtimeSessionId: task.runtimeSessionId })
  }

  private clearPendingPermissions(turn: AgentRuntimeTurnRef): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.taskId === turn.taskId && (!turn.turnId || pending.turnId === turn.turnId)) {
        this.pendingPermissions.delete(requestId)
      }
    }
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
  return new AgentServiceError('operation-failed', 'Agent Runtime 操作失败。')
}
