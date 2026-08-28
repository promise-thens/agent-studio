import type { AgentPermissionRequest } from '../../shared/agent'

export interface PermissionRequestIdentity {
  approvalId: string
  taskId: string
  turnId: string
}

export interface PermissionQueueState {
  queue: AgentPermissionRequest[]
  respondingPermission: PermissionRequestIdentity | null
}

/** 审批 ID 必须与 Task/Turn 共同构成身份，旧事件不得误删新 Turn 请求。 */
export function matchesPermissionIdentity(
  request: PermissionRequestIdentity,
  identity: PermissionRequestIdentity
): boolean {
  return (
    request.approvalId === identity.approvalId &&
    request.taskId === identity.taskId &&
    request.turnId === identity.turnId
  )
}

/** 只有当前队首本身正在提交时才锁住按钮，旧请求在途不得阻塞新的队首审批。 */
export function isPermissionResponsePending(
  request: PermissionRequestIdentity | null,
  respondingPermission: PermissionRequestIdentity | null
): boolean {
  return Boolean(
    request && respondingPermission && matchesPermissionIdentity(request, respondingPermission)
  )
}

/** 异步响应结束时只清理自己的身份，旧请求的 finally 不得覆盖后续响应状态。 */
export function clearRespondingPermission(
  respondingPermission: PermissionRequestIdentity | null,
  settledIdentity: PermissionRequestIdentity
): PermissionRequestIdentity | null {
  return respondingPermission && matchesPermissionIdentity(respondingPermission, settledIdentity)
    ? null
    : respondingPermission
}

/** 审批队列只接受尚未过期的请求；同一张卡补路径时原地替换，不新增 FIFO 项。 */
export function enqueuePermissionRequest(
  queue: AgentPermissionRequest[],
  request: AgentPermissionRequest,
  now = Date.now()
): AgentPermissionRequest[] {
  const expiresAt = Date.parse(request.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return queue
  const existingIndex = queue.findIndex((item) => matchesPermissionIdentity(item, request))
  if (existingIndex >= 0) {
    const next = [...queue]
    next[existingIndex] = request
    return next
  }
  return [...queue, request]
}

export function removePermissionRequest(
  queue: AgentPermissionRequest[],
  identity: PermissionRequestIdentity
): AgentPermissionRequest[] {
  return queue.filter((item) => !matchesPermissionIdentity(item, identity))
}

/** 查看身份只对审批做可见/后台分组，不产生任何隐式权限决策。 */
export function reconcilePermissionRequests(
  queue: AgentPermissionRequest[],
  taskId: string,
  projectId: string
): { active: AgentPermissionRequest[]; stale: AgentPermissionRequest[] } {
  const active: AgentPermissionRequest[] = []
  const stale: AgentPermissionRequest[] = []
  for (const request of queue) {
    if (request.taskId === taskId && request.projectId === projectId) active.push(request)
    else stale.push(request)
  }
  return { active, stale }
}

export function removeExpiredPermissionRequests(
  queue: AgentPermissionRequest[],
  now = Date.now()
): AgentPermissionRequest[] {
  return queue.filter((item) => {
    const expiresAt = Date.parse(item.expiresAt)
    return Number.isFinite(expiresAt) && expiresAt > now
  })
}

export function getNextPermissionExpiry(queue: AgentPermissionRequest[]): number | null {
  const nextExpiry = queue.reduce((earliest, item) => {
    const expiresAt = Date.parse(item.expiresAt)
    return Number.isFinite(expiresAt) ? Math.min(earliest, expiresAt) : earliest
  }, Number.POSITIVE_INFINITY)
  return Number.isFinite(nextExpiry) ? nextExpiry : null
}

/** Runtime 断开或异常后同时复位队列与响应状态，避免下一项看似可点击却被旧请求锁住。 */
export function clearPermissionQueueState(): PermissionQueueState {
  return { queue: [], respondingPermission: null }
}
