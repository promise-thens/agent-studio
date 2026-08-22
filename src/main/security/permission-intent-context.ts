/**
 * Broker 要求 context.active 且 turnId 与意图一致。
 * Turn 结束后仍要用原 turnId 做受控恢复，但不能让历史身份在活动 Turn 期间冒充活跃。
 */
export function resolvePermissionTurnIdentity(input: {
  activeTurnId?: string
  lastTurnId?: string
  state: string
  requestedTurnId: string
}): { turnId: string; active: boolean } {
  const live =
    Boolean(input.activeTurnId) &&
    (input.state === 'running' || input.state === 'waiting-permission')
  if (live) {
    return {
      turnId: input.activeTurnId ?? '',
      active: input.activeTurnId === input.requestedTurnId
    }
  }
  const idleRestore = Boolean(input.lastTurnId) && input.lastTurnId === input.requestedTurnId
  return {
    turnId: idleRestore ? input.requestedTurnId : (input.lastTurnId ?? ''),
    active: idleRestore
  }
}
