import { createHash, randomUUID } from 'node:crypto'
import { relative } from 'node:path'
import type {
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentPermissionResolutionReason,
  AgentPermissionRisk,
  AgentPermissionScope,
  AgentRuntimeId,
  OperationIntent
} from '../../shared/agent'
import type { PermissionAuditRecord } from '../../shared/task-history'
import type { AgentPermissionCancellation } from '../../shared/agent-ipc'
import {
  MAX_PERMISSION_AUDIT_RECORD_BYTES,
  type PermissionAuditStore
} from './permission-audit-store'
import {
  PermissionPolicyError,
  createOperationGrantKey,
  evaluatePermissionPolicy,
  resolveOperationIntentTargets,
  type ResolvedOperationIntent
} from './permission-policy'

export const PERMISSION_APPROVAL_TTL_MS = 2 * 60 * 1000
const MAX_APPROVAL_ID_ATTEMPTS = 8
const MAX_DISPLAY_FIELD_BYTES = 4 * 1024

export type PermissionAuthorizationResult<T> =
  | {
      ok: true
      value: T
      reason: Extract<
        AgentPermissionResolutionReason,
        'auto-allowed' | 'grant-reused' | 'user-allowed'
      >
      scope: AgentPermissionScope
    }
  | {
      ok: false
      reason: Exclude<
        AgentPermissionResolutionReason,
        'auto-allowed' | 'grant-reused' | 'user-allowed'
      >
    }

export interface AgentPermissionResponse {
  approvalId: string
  taskId: string
  turnId: string
  decision: AgentPermissionDecision
}

export interface AuthorizeOperationOptions {
  /** Runtime 没有唯一 allow_once 时仍进入 Broker 审计，但不会生成可批准请求。 */
  executionSupported?: boolean
  /** 异步路径解析、等待审批和授权复用前都重新确认原 Task/Turn 身份仍然有效。 */
  isActive?: () => boolean
  onPendingChange?: (count: number) => void
  /** 仅供主进程精确关联 Runtime 请求与产品审批，永不进入 Renderer DTO。 */
  cancellationId?: string
}

export interface PermissionBrokerOptions {
  auditStore: PermissionAuditStore
  onApproval: (request: AgentPermissionRequest) => boolean
  onApprovalCancelled?: (request: AgentPermissionCancellation) => void
  /** Broker 通过权威 TaskStore 解析身份，禁止调用方自报 Project、root、环境或 Runtime。 */
  resolveIntentContext: (taskId: string, turnId: string) => PermissionIntentContext | null
  redactText?: (text: string) => string
  createId?: () => string
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

export interface PermissionIntentContext {
  taskId: string
  turnId: string
  projectId: string
  executionRoot: string
  environmentId: string
  runtimeId: AgentRuntimeId
  environmentKind: 'local' | 'worktree' | 'unknown'
  active: boolean
}

interface TaskGrant {
  key: string
  taskId: string
  projectId: string
  environmentId: string
  createdAt: string
}

export interface PermissionDeletionLease {
  commit(): void
  rollback(): void
}

interface PendingApproval {
  approval: AgentPermissionRequest
  intent: ResolvedOperationIntent
  policyRisk: AgentPermissionRisk
  grantKey: string
  execute: (intent: ResolvedOperationIntent) => Promise<unknown>
  isActive?: () => boolean
  onPendingChange?: (count: number) => void
  cancellationId?: string
  timer: ReturnType<typeof setTimeout>
  resolve: (result: PermissionAuthorizationResult<unknown>) => void
  phase: 'waiting' | 'settling' | 'executing' | 'settled'
  settlement?: Promise<void>
  cancelReason?: Extract<AgentPermissionResolutionReason, 'cancelled' | 'expired'>
  cancellationNotified: boolean
}

interface ActiveAuthorization {
  taskId: string
  projectId: string
  completed: Promise<void>
}

interface ApprovalAdmission {
  ready: Promise<void>
  release: () => void
}

/**
 * 主进程唯一权限事实源：先规范化目标和评估策略，再命中精确 Task grant 或创建审批。
 * 任何内部错误都失败关闭，副作用回调只会在允许审计成功后执行一次。
 */
export class PermissionBroker {
  private readonly auditStore: PermissionAuditStore
  private readonly onApproval: PermissionBrokerOptions['onApproval']
  private readonly onApprovalCancelled?: PermissionBrokerOptions['onApprovalCancelled']
  private readonly resolveIntentContext: PermissionBrokerOptions['resolveIntentContext']
  private readonly redactText: (text: string) => string
  private readonly createId: () => string
  private readonly now: () => number
  private readonly setTimer: NonNullable<PermissionBrokerOptions['setTimer']>
  private readonly clearTimer: NonNullable<PermissionBrokerOptions['clearTimer']>
  private readonly pending = new Map<string, PendingApproval>()
  private readonly taskGrants = new Map<string, TaskGrant>()
  private readonly activeAuthorizations = new Map<symbol, ActiveAuthorization>()
  private readonly approvalAdmissionTails = new Map<string, Promise<void>>()
  private readonly frozenTasks = new Map<string, symbol>()
  private readonly frozenProjects = new Map<string, symbol>()
  private shuttingDown = false

  constructor(options: PermissionBrokerOptions) {
    this.auditStore = options.auditStore
    this.onApproval = options.onApproval
    this.onApprovalCancelled = options.onApprovalCancelled
    this.resolveIntentContext = options.resolveIntentContext
    this.redactText = options.redactText ?? ((text) => text)
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
  }

  /**
   * App 自有服务和 Runtime 请求共用此入口。
   * execute 不会被缓存；每次具体操作都在当前决策完成后调用，拒绝时调用次数恒为零。
   */
  async authorizeOperation<T>(
    intent: OperationIntent,
    execute: (intent: ResolvedOperationIntent) => T | Promise<T>,
    options: AuthorizeOperationOptions = {}
  ): Promise<PermissionAuthorizationResult<T>> {
    if (this.shuttingDown || this.isFrozen(intent.taskId, intent.projectId)) {
      // 删除冻结后不再写入原 Task 目录，避免物理删除期间重建“幽灵”审计文件。
      return { ok: false, reason: 'cancelled' }
    }
    const finishAuthorization = this.trackAuthorization(intent.taskId, intent.projectId)
    const admission = this.reserveApprovalAdmission(intent.taskId, intent.turnId)
    try {
      // 同一 Task/Turn 按调用到达顺序完成准入；上一项一旦登记审批就立即放行下一项。
      await admission.ready
      if (this.shuttingDown || this.isFrozen(intent.taskId, intent.projectId)) {
        return { ok: false, reason: 'cancelled' }
      }
      let resolved: ResolvedOperationIntent
      try {
        resolved = await resolveOperationIntentTargets(intent)
      } catch (error) {
        const reason =
          error instanceof PermissionPolicyError && error.code === 'invalid-target'
            ? 'invalid-target'
            : 'internal-error'
        // 已确定不会创建审批，先放行同 Task/Turn；完整审计仍由 activeAuthorizations 跟踪。
        admission.release()
        await this.auditBestEffort(intent, 'L3', reason, undefined, '目标或操作意图校验失败。')
        return { ok: false, reason }
      }

      if (this.shuttingDown || this.isFrozen(resolved.taskId, resolved.projectId)) {
        return { ok: false, reason: 'cancelled' }
      }
      const contextFailure = this.getAuthorizationContextFailure(resolved)
      if (contextFailure || !this.isCallerActive(options.isActive)) {
        const reason = contextFailure ?? 'cancelled'
        admission.release()
        await this.auditBestEffort(
          resolved,
          'L3',
          reason,
          undefined,
          reason === 'cancelled' ? '原 Task 或 Turn 已结束。' : '操作身份与权威 Task 上下文不匹配。'
        )
        return { ok: false, reason }
      }

      const policy = evaluatePermissionPolicy(resolved)
      if (options.executionSupported === false || policy.kind === 'deny') {
        admission.release()
        await this.auditBestEffort(
          resolved,
          policy.risk,
          'unsupported',
          undefined,
          '当前调用方没有安全的单次执行映射。'
        )
        return { ok: false, reason: 'unsupported' }
      }

      const grantKey = createOperationGrantKey(resolved)
      if (policy.kind === 'allow') {
        admission.release()
        return await this.executeAllowed(
          resolved,
          execute,
          policy.risk,
          'auto-allowed',
          'once',
          options.isActive
        )
      }

      if (this.taskGrants.has(grantKey)) {
        admission.release()
        return await this.executeAllowed(
          resolved,
          execute,
          policy.risk,
          'grant-reused',
          'task',
          options.isActive
        )
      }

      const approvalResult = this.waitForApproval(
        resolved,
        execute,
        policy.risk,
        policy.allowedScopes,
        grantKey,
        options
      )
      // waitForApproval 在返回前已同步登记 pending；无需等待用户结算即可准入下一审批。
      admission.release()
      return await approvalResult
    } finally {
      admission.release()
      finishAuthorization()
    }
  }

  /** Renderer 响应只按 approvalId + Task/Turn + decision 匹配；晚到或重复响应幂等忽略。 */
  async respond(response: AgentPermissionResponse): Promise<void> {
    const pending = this.pending.get(response.approvalId)
    if (
      !pending ||
      pending.approval.taskId !== response.taskId ||
      pending.approval.turnId !== response.turnId ||
      this.now() >= Date.parse(pending.approval.expiresAt)
    ) {
      if (pending && this.now() >= Date.parse(pending.approval.expiresAt)) {
        await this.settlePending(pending, 'expired')
      }
      return
    }

    if (pending.phase !== 'waiting') {
      await pending.settlement
      return
    }
    if (this.getQueueHead(response.taskId, response.turnId) !== pending) return

    if (response.decision === 'allow-task' && !pending.approval.allowedScopes.includes('task')) {
      return
    }
    if (response.decision === 'deny') {
      await this.settlePending(pending, 'user-denied')
      return
    }
    await this.settlePending(
      pending,
      'user-allowed',
      response.decision === 'allow-task' ? 'task' : 'once'
    )
  }

  /** Turn 终态只取消该 Turn 的等待审批；已确认的 Task grant 可继续跨 Turn 使用。 */
  async cancelTurn(
    taskId: string,
    turnId: string,
    reason: Extract<AgentPermissionResolutionReason, 'cancelled' | 'expired'> = 'cancelled'
  ): Promise<void> {
    const matches = [...this.pending.values()].filter(
      (pending) => pending.approval.taskId === taskId && pending.approval.turnId === turnId
    )
    await Promise.all(matches.map((pending) => this.settlePending(pending, reason)))
  }

  /** Runtime ToolCall 终止时只撤销完整匹配的单个审批，晚到用户响应会因 pending 已删除而忽略。 */
  async cancelAuthorization(cancellationId: string, taskId: string, turnId: string): Promise<void> {
    const pending = [...this.pending.values()].find(
      (candidate) =>
        candidate.cancellationId === cancellationId &&
        candidate.approval.taskId === taskId &&
        candidate.approval.turnId === turnId
    )
    if (!pending) return

    const shouldNotify = pending.phase === 'waiting' || pending.phase === 'settling'
    const settlement = this.settlePending(pending, 'cancelled')
    if (shouldNotify && !pending.cancellationNotified) {
      pending.cancellationNotified = true
      try {
        this.onApprovalCancelled?.({
          approvalId: pending.approval.approvalId,
          taskId: pending.approval.taskId,
          turnId: pending.approval.turnId,
          reason: 'cancelled'
        })
      } catch {
        // Renderer 通知失败不能恢复已经撤销的主进程授权状态。
      }
    }
    await settlement
  }

  /** Task 显式关闭或身份边界变化时，同时清除等待审批和内存授权。 */
  async invalidateTask(taskId: string): Promise<void> {
    await this.cancelPendingByTask(taskId)
    this.removeTaskGrants(taskId)
  }

  /** Project 被切换、移除或历史删除时，清除其全部等待审批和 Task grant。 */
  async invalidateProject(projectId: string): Promise<void> {
    await this.cancelPendingByProject(projectId)
    this.removeProjectGrants(projectId)
  }

  /**
   * 删除前先冻结 Task，取消等待审批并阻止新授权；删除失败时 rollback 只解除冻结，保留既有 grant。
   */
  async beginTaskDeletion(taskId: string): Promise<PermissionDeletionLease> {
    const leaseId = Symbol(taskId)
    if (this.frozenTasks.has(taskId)) throw new Error('Task 删除门禁已存在。')
    this.frozenTasks.set(taskId, leaseId)
    try {
      await this.cancelPendingByTask(taskId)
      await this.waitForActiveAuthorizations((operation) => operation.taskId === taskId)
    } catch (error) {
      this.frozenTasks.delete(taskId)
      throw error
    }
    return {
      commit: () => {
        if (this.frozenTasks.get(taskId) !== leaseId) return
        // 授权必须先于解冻被清除；若清理异常，冻结状态会保留并继续失败关闭。
        this.removeTaskGrants(taskId)
        this.frozenTasks.delete(taskId)
      },
      rollback: () => {
        if (this.frozenTasks.get(taskId) === leaseId) this.frozenTasks.delete(taskId)
      }
    }
  }

  /** Project 历史删除使用同一可回滚冻结语义，避免删除提交窗口复用旧授权。 */
  async beginProjectDeletion(projectId: string): Promise<PermissionDeletionLease> {
    const leaseId = Symbol(projectId)
    if (this.frozenProjects.has(projectId)) throw new Error('Project 删除门禁已存在。')
    this.frozenProjects.set(projectId, leaseId)
    try {
      await this.cancelPendingByProject(projectId)
      await this.waitForActiveAuthorizations((operation) => operation.projectId === projectId)
    } catch (error) {
      this.frozenProjects.delete(projectId)
      throw error
    }
    return {
      commit: () => {
        if (this.frozenProjects.get(projectId) !== leaseId) return
        // Project 下全部授权清除后才能解冻，避免不可逆删除后旧 grant 复活。
        this.removeProjectGrants(projectId)
        this.frozenProjects.delete(projectId)
      },
      rollback: () => {
        if (this.frozenProjects.get(projectId) === leaseId) this.frozenProjects.delete(projectId)
      }
    }
  }

  /** Runtime 连接切换时只清空 Task grant；在途授权仍由删除和退出门禁等待收束。 */
  clearTaskGrants(): void {
    this.taskGrants.clear()
  }

  /** App 退出时取消所有等待请求并清空不跨重启的 Task grant。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    await Promise.all(
      [...this.pending.values()].map((pending) => this.settlePending(pending, 'cancelled'))
    )
    await this.waitForActiveAuthorizations(() => true)
    this.taskGrants.clear()
    this.frozenTasks.clear()
    this.frozenProjects.clear()
  }

  getPendingCount(taskId: string, turnId: string): number {
    return [...this.pending.values()].filter(
      (pending) => pending.approval.taskId === taskId && pending.approval.turnId === turnId
    ).length
  }

  private async waitForApproval<T>(
    intent: ResolvedOperationIntent,
    execute: (intent: ResolvedOperationIntent) => T | Promise<T>,
    risk: AgentPermissionRisk,
    allowedScopes: AgentPermissionScope[],
    grantKey: string,
    options: AuthorizeOperationOptions
  ): Promise<PermissionAuthorizationResult<T>> {
    const approvalId = this.allocateApprovalId()
    const expiresAtMs = this.now() + PERMISSION_APPROVAL_TTL_MS
    const approval = createApprovalRequest(
      approvalId,
      intent,
      risk,
      allowedScopes,
      expiresAtMs,
      this.redactText
    )

    return new Promise((resolve) => {
      const timer = this.setTimer(() => {
        const pending = this.pending.get(approvalId)
        if (pending) void this.settlePending(pending, 'expired')
      }, PERMISSION_APPROVAL_TTL_MS)
      const pending: PendingApproval = {
        approval,
        intent,
        policyRisk: risk,
        grantKey,
        execute: async (resolvedIntent) => execute(resolvedIntent),
        ...(options.isActive ? { isActive: options.isActive } : {}),
        ...(options.onPendingChange ? { onPendingChange: options.onPendingChange } : {}),
        ...(options.cancellationId ? { cancellationId: options.cancellationId } : {}),
        timer,
        resolve: (result) => resolve(result as PermissionAuthorizationResult<T>),
        phase: 'waiting',
        cancellationNotified: false
      }
      this.pending.set(approvalId, pending)
      this.publishPendingCount(pending)

      let delivered = false
      try {
        delivered = this.onApproval(approval)
      } catch {
        delivered = false
      }
      if (!delivered) void this.settlePending(pending, 'cancelled')
    })
  }

  /**
   * 审批只能建立一条结算 Promise；审计等待期仍保留在 pending 中，
   * 让 Turn 取消、删除和退出都能设置 sticky 取消标记并等待同一收束链。
   */
  private settlePending(
    pending: PendingApproval,
    reason: Extract<
      AgentPermissionResolutionReason,
      'user-allowed' | 'user-denied' | 'cancelled' | 'expired'
    >,
    scope?: AgentPermissionScope
  ): Promise<void> {
    if (pending.phase === 'settled') return pending.settlement ?? Promise.resolve()
    if (reason === 'cancelled' || reason === 'expired') pending.cancelReason ??= reason
    if (pending.phase !== 'waiting') return pending.settlement ?? Promise.resolve()

    pending.phase = 'settling'
    this.clearTimer(pending.timer)
    // 先公布唯一 Promise 再进入异步审计，避免审计回调同步取消时看不到在途结算。
    const settlement = Promise.resolve().then(() =>
      this.runPendingSettlement(pending, reason, scope)
    )
    pending.settlement = settlement
    return settlement
  }

  /** 完成审计、二次活性校验和受控执行，最终移出队列并只 resolve 一次。 */
  private async runPendingSettlement(
    pending: PendingApproval,
    reason: Extract<
      AgentPermissionResolutionReason,
      'user-allowed' | 'user-denied' | 'cancelled' | 'expired'
    >,
    scope?: AgentPermissionScope
  ): Promise<void> {
    if (reason !== 'user-allowed' || !scope) {
      const initialReason = (pending.cancelReason ?? reason) as Extract<
        AgentPermissionResolutionReason,
        'user-denied' | 'cancelled' | 'expired'
      >
      await this.auditBestEffort(pending.intent, pending.policyRisk, initialReason, scope)
      const finalReason = pending.cancelReason ?? initialReason
      if (finalReason !== initialReason) {
        await this.auditBestEffort(
          pending.intent,
          pending.policyRisk,
          finalReason,
          undefined,
          '审批审计写入期间原请求已失效。'
        )
      }
      this.finishPending(pending, { ok: false, reason: finalReason })
      return
    }

    const cancellationBeforeAudit = this.getPendingCancellationReason(pending)
    if (cancellationBeforeAudit) {
      await this.auditBestEffort(
        pending.intent,
        pending.policyRisk,
        cancellationBeforeAudit,
        undefined,
        '原 Task 或 Turn 已结束。'
      )
      this.finishPending(pending, { ok: false, reason: cancellationBeforeAudit })
      return
    }

    const auditSaved = await this.auditAllowed(
      pending.intent,
      pending.policyRisk,
      'user-allowed',
      scope
    )
    const cancellationAfterAudit = this.getPendingCancellationReason(pending)
    if (cancellationAfterAudit) {
      await this.auditBestEffort(
        pending.intent,
        pending.policyRisk,
        cancellationAfterAudit,
        undefined,
        '审计写入后原 Task 或 Turn 已结束。'
      )
      this.finishPending(pending, { ok: false, reason: cancellationAfterAudit })
      return
    }
    if (!auditSaved) {
      this.finishPending(pending, { ok: false, reason: 'internal-error' })
      return
    }

    // 进入 executing 即代表副作用已经开始提交；后续取消不伪造“撤回”，但会阻止扩大 Task grant。
    pending.phase = 'executing'
    try {
      const value = await pending.execute(pending.intent)
      if (scope === 'task' && !this.getPendingCancellationReason(pending)) {
        // 只有首个获批副作用真正成功后才登记 Task grant，避免失败操作扩大后续权限。
        this.taskGrants.set(pending.grantKey, {
          key: pending.grantKey,
          taskId: pending.intent.taskId,
          projectId: pending.intent.projectId,
          environmentId: pending.intent.environmentId,
          createdAt: new Date(this.now()).toISOString()
        })
      }
      this.finishPending(pending, { ok: true, value, reason: 'user-allowed', scope })
    } catch {
      await this.auditBestEffort(
        pending.intent,
        pending.policyRisk,
        'internal-error',
        scope,
        '获批操作在受控执行回调内失败。'
      )
      this.finishPending(pending, { ok: false, reason: 'internal-error' })
    }
  }

  /** 队列头以 Task + Turn 为作用域，无关 Turn 不因全局 FIFO 互相阻塞。 */
  private getQueueHead(taskId: string, turnId: string): PendingApproval | undefined {
    return [...this.pending.values()].find(
      (pending) => pending.approval.taskId === taskId && pending.approval.turnId === turnId
    )
  }

  private getPendingCancellationReason(
    pending: PendingApproval
  ): Extract<AgentPermissionResolutionReason, 'cancelled' | 'expired'> | null {
    if (pending.cancelReason) return pending.cancelReason
    if (
      this.shuttingDown ||
      this.isFrozen(pending.intent.taskId, pending.intent.projectId) ||
      !this.isAuthorizationActive(pending.intent, pending.isActive)
    ) {
      return 'cancelled'
    }
    return null
  }

  private finishPending(
    pending: PendingApproval,
    result: PermissionAuthorizationResult<unknown>
  ): void {
    if (pending.phase === 'settled') return
    pending.phase = 'settled'
    if (this.pending.get(pending.approval.approvalId) === pending) {
      this.pending.delete(pending.approval.approvalId)
    }
    this.clearTimer(pending.timer)
    this.publishPendingCount(pending)
    pending.resolve(result)
  }

  private async executeAllowed<T>(
    intent: ResolvedOperationIntent,
    execute: (intent: ResolvedOperationIntent) => T | Promise<T>,
    risk: AgentPermissionRisk,
    reason: Extract<AgentPermissionResolutionReason, 'auto-allowed' | 'grant-reused'>,
    scope: AgentPermissionScope,
    isActive?: () => boolean
  ): Promise<PermissionAuthorizationResult<T>> {
    if (
      this.isFrozen(intent.taskId, intent.projectId) ||
      !this.isAuthorizationActive(intent, isActive)
    ) {
      await this.auditBestEffort(intent, risk, 'cancelled')
      return { ok: false, reason: 'cancelled' }
    }
    if (!(await this.auditAllowed(intent, risk, reason, scope))) {
      return { ok: false, reason: 'internal-error' }
    }
    if (
      this.isFrozen(intent.taskId, intent.projectId) ||
      !this.isAuthorizationActive(intent, isActive)
    ) {
      await this.auditBestEffort(intent, risk, 'cancelled')
      return { ok: false, reason: 'cancelled' }
    }
    try {
      return { ok: true, value: await execute(intent), reason, scope }
    } catch {
      await this.auditBestEffort(
        intent,
        risk,
        'internal-error',
        scope,
        '获批操作在受控执行回调内失败。'
      )
      return { ok: false, reason: 'internal-error' }
    }
  }

  private async auditAllowed(
    intent: ResolvedOperationIntent,
    risk: AgentPermissionRisk,
    reason: Extract<
      AgentPermissionResolutionReason,
      'auto-allowed' | 'grant-reused' | 'user-allowed'
    >,
    scope: AgentPermissionScope
  ): Promise<boolean> {
    try {
      await this.auditStore.append(this.createAuditRecord(intent, risk, reason, scope))
      return true
    } catch {
      return false
    }
  }

  private async auditBestEffort(
    intent: OperationIntent,
    risk: AgentPermissionRisk,
    reason: Exclude<
      AgentPermissionResolutionReason,
      'auto-allowed' | 'grant-reused' | 'user-allowed'
    >,
    scope?: AgentPermissionScope,
    detail?: string
  ): Promise<void> {
    try {
      await this.auditStore.append(this.createAuditRecord(intent, risk, reason, scope, detail))
    } catch {
      // 拒绝路径不因审计失败反向放行；磁盘异常只影响回看证据。
    }
  }

  private createAuditRecord(
    intent: OperationIntent,
    risk: AgentPermissionRisk,
    reason: AgentPermissionResolutionReason,
    scope?: AgentPermissionScope,
    detail?: string
  ): PermissionAuditRecord {
    // 审批展示文案不复用于落盘；审计只保存稳定类别和有限说明，避免原始命令进入历史。
    const title = safeDisplayText(`权限决策：${intent.operationType}`, this.redactText)
    const impact = safeDisplayText(
      '仅保存操作类别、受限目标摘要与决策结果，敏感参数未持久化。',
      this.redactText
    )
    const targetSummaries = summarizeAuditTargets(intent, this.redactText)
    const safeDetail = detail ? safeDisplayText(detail, this.redactText) : undefined
    return fitAuditRecord({
      auditId: this.createId(),
      taskId: intent.taskId,
      turnId: intent.turnId,
      projectId: intent.projectId,
      environmentId: intent.environmentId,
      initiator: intent.initiator.kind,
      ...(intent.initiator.kind === 'runtime' ? { runtimeId: intent.initiator.runtimeId } : {}),
      ...(intent.initiator.kind === 'app' ? { appService: intent.initiator.service } : {}),
      operationType: intent.operationType,
      risk,
      targetSummaries: targetSummaries.values,
      title: title.value,
      impact: impact.value,
      reason,
      ...(scope ? { scope } : {}),
      ...(safeDetail ? { detail: safeDetail.value } : {}),
      createdAt: new Date(this.now()).toISOString(),
      ...(title.truncated || impact.truncated || targetSummaries.truncated || safeDetail?.truncated
        ? { truncated: true }
        : {})
    })
  }

  private publishPendingCount(pending: PendingApproval): void {
    pending.onPendingChange?.(
      this.getPendingCount(pending.approval.taskId, pending.approval.turnId)
    )
  }

  private isFrozen(taskId: string, projectId: string): boolean {
    return this.frozenTasks.has(taskId) || this.frozenProjects.has(projectId)
  }

  private isAuthorizationActive(
    intent: ResolvedOperationIntent,
    callerCheck?: () => boolean
  ): boolean {
    try {
      return !this.getAuthorizationContextFailure(intent) && this.isCallerActive(callerCheck)
    } catch {
      return false
    }
  }

  /** 身份字段不匹配按 invalid-target，非 Local 环境按 unsupported，终态或缺失 Task 按 cancelled。 */
  private getAuthorizationContextFailure(
    intent: ResolvedOperationIntent
  ): Extract<
    AgentPermissionResolutionReason,
    'cancelled' | 'invalid-target' | 'unsupported'
  > | null {
    try {
      const context = this.resolveIntentContext(intent.taskId, intent.turnId)
      if (!context || !context.active || context.turnId !== intent.turnId) return 'cancelled'
      if (context.environmentKind !== 'local') return 'unsupported'
      if (
        context.taskId !== intent.taskId ||
        context.projectId !== intent.projectId ||
        context.executionRoot !== intent.executionRoot ||
        context.environmentId !== intent.environmentId ||
        (intent.initiator.kind === 'runtime' && context.runtimeId !== intent.initiator.runtimeId)
      ) {
        return 'invalid-target'
      }
      return null
    } catch {
      return 'cancelled'
    }
  }

  private isCallerActive(callerCheck?: () => boolean): boolean {
    if (!callerCheck) return true
    try {
      return callerCheck()
    } catch {
      return false
    }
  }

  private trackAuthorization(taskId: string, projectId: string): () => void {
    const operationId = Symbol(taskId)
    let resolveCompleted!: () => void
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve
    })
    this.activeAuthorizations.set(operationId, { taskId, projectId, completed })
    return () => {
      this.activeAuthorizations.delete(operationId)
      resolveCompleted()
    }
  }

  /**
   * 只串行同一 Task/Turn 从到达至“审批已登记”的短窗口。
   * 不同 Turn 互不阻塞，已登记的多个审批仍可同时处于 pending。
   */
  private reserveApprovalAdmission(taskId: string, turnId: string): ApprovalAdmission {
    const key = JSON.stringify([taskId, turnId])
    const ready = this.approvalAdmissionTails.get(key) ?? Promise.resolve()
    let resolveCurrent!: () => void
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve
    })
    this.approvalAdmissionTails.set(key, current)
    let released = false
    return {
      ready,
      release: () => {
        if (released) return
        released = true
        resolveCurrent()
        if (this.approvalAdmissionTails.get(key) === current) {
          this.approvalAdmissionTails.delete(key)
        }
      }
    }
  }

  private async waitForActiveAuthorizations(
    matches: (operation: ActiveAuthorization) => boolean
  ): Promise<void> {
    await Promise.all(
      [...this.activeAuthorizations.values()]
        .filter(matches)
        .map((operation) => operation.completed)
    )
  }

  private removeTaskGrants(taskId: string): void {
    for (const [key, grant] of this.taskGrants) {
      if (grant.taskId === taskId) this.taskGrants.delete(key)
    }
  }

  private removeProjectGrants(projectId: string): void {
    for (const [key, grant] of this.taskGrants) {
      if (grant.projectId === projectId) this.taskGrants.delete(key)
    }
  }

  private async cancelPendingByTask(taskId: string): Promise<void> {
    await Promise.all(
      [...this.pending.values()]
        .filter((pending) => pending.approval.taskId === taskId)
        .map((pending) => this.settlePending(pending, 'cancelled'))
    )
  }

  private async cancelPendingByProject(projectId: string): Promise<void> {
    await Promise.all(
      [...this.pending.values()]
        .filter((pending) => pending.approval.projectId === projectId)
        .map((pending) => this.settlePending(pending, 'cancelled'))
    )
  }

  private allocateApprovalId(): string {
    for (let attempt = 0; attempt < MAX_APPROVAL_ID_ATTEMPTS; attempt += 1) {
      const approvalId = this.createId()
      if (
        typeof approvalId === 'string' &&
        approvalId.trim() &&
        !approvalId.includes('\0') &&
        !this.pending.has(approvalId)
      ) {
        return approvalId
      }
    }
    throw new Error('无法分配唯一审批 ID。')
  }
}

function createApprovalRequest(
  approvalId: string,
  intent: ResolvedOperationIntent,
  risk: AgentPermissionRisk,
  allowedScopes: AgentPermissionScope[],
  expiresAtMs: number,
  redactText: (text: string) => string
): AgentPermissionRequest {
  const title = safeDisplayText(intent.title, redactText)
  const impact = safeDisplayText(intent.impact, redactText)
  const targets = summarizeApprovalTargets(intent, redactText)
  return {
    approvalId,
    initiator: intent.initiator.kind,
    ...(intent.initiator.kind === 'runtime' ? { runtimeId: intent.initiator.runtimeId } : {}),
    ...(intent.initiator.kind === 'app' ? { appService: intent.initiator.service } : {}),
    taskId: intent.taskId,
    turnId: intent.turnId,
    projectId: intent.projectId,
    environmentId: intent.environmentId,
    operationType: intent.operationType,
    risk,
    title: title.value,
    impact: impact.value,
    targets: targets.values,
    allowedScopes: [...allowedScopes],
    expiresAt: new Date(expiresAtMs).toISOString(),
    ...(title.truncated || impact.truncated || targets.truncated ? { truncated: true } : {})
  }
}

interface TargetSummaryResult {
  values: string[]
  truncated: boolean
}

/** 审批摘要允许展示已脱敏、限长的命令，便于用户在执行前理解实际影响。 */
function summarizeApprovalTargets(
  intent: OperationIntent,
  redactText: (text: string) => string
): TargetSummaryResult {
  let truncated = false
  const values = intent.targets.slice(0, 32).map((target) => {
    const value =
      target.kind === 'path' && intent.executionRoot
        ? relative(intent.executionRoot, target.value) || '.'
        : target.value
    const summary = safeDisplayText(`${target.kind}: ${value}`, redactText)
    truncated ||= summary.truncated
    return summary.value
  })
  return { values, truncated }
}

/**
 * 持久化审计不得保存原始命令或未知正文；只保留类别、不可逆摘要和有限说明。
 * 路径、Project、origin 等已结构化目标仍按相对路径或脱敏值记录。
 */
function summarizeAuditTargets(
  intent: OperationIntent,
  redactText: (text: string) => string
): TargetSummaryResult {
  let truncated = false
  const values = intent.targets.slice(0, 32).map((target) => {
    if (target.kind === 'command' || target.kind === 'unknown') {
      const digest = createHash('sha256').update(target.value).digest('hex')
      return `${target.kind}: sha256:${digest}`
    }
    const value =
      target.kind === 'path' && intent.executionRoot
        ? relative(intent.executionRoot, target.value) || '.'
        : target.value
    const summary = safeDisplayText(`${target.kind}: ${value}`, redactText)
    truncated ||= summary.truncated
    return summary.value
  })
  return { values, truncated }
}

/** 优先丢弃末尾目标摘要和可选说明，使每条持久化记录严格不超过 16 KiB。 */
function fitAuditRecord(record: PermissionAuditRecord): PermissionAuditRecord {
  const fitted = structuredClone(record)
  while (
    fitted.targetSummaries.length > 1 &&
    Buffer.byteLength(JSON.stringify(fitted), 'utf8') > MAX_PERMISSION_AUDIT_RECORD_BYTES
  ) {
    fitted.targetSummaries.pop()
    fitted.truncated = true
  }
  if (
    fitted.detail &&
    Buffer.byteLength(JSON.stringify(fitted), 'utf8') > MAX_PERMISSION_AUDIT_RECORD_BYTES
  ) {
    delete fitted.detail
    fitted.truncated = true
  }
  if (Buffer.byteLength(JSON.stringify(fitted), 'utf8') > MAX_PERMISSION_AUDIT_RECORD_BYTES) {
    throw new Error('权限审计记录超过 16 KiB 上限。')
  }
  return fitted
}

function safeDisplayText(
  value: string,
  redactText: (text: string) => string
): { value: string; truncated: boolean } {
  let redacted: string
  try {
    redacted = redactText(value)
  } catch {
    redacted = '敏感内容已隐藏。'
  }
  redacted = redacted.replace(/\p{Cc}/gu, ' ').trim() || '未提供可展示摘要。'
  if (Buffer.byteLength(redacted, 'utf8') <= MAX_DISPLAY_FIELD_BYTES) {
    return { value: redacted, truncated: false }
  }
  let result = ''
  let used = 0
  for (const character of redacted) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > MAX_DISPLAY_FIELD_BYTES) break
    result += character
    used += bytes
  }
  return { value: result, truncated: true }
}
