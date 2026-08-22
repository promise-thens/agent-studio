import { describe, expect, it } from 'vitest'
import { resolvePermissionTurnIdentity } from './permission-intent-context'

describe('resolvePermissionTurnIdentity', () => {
  it('活动 Turn 只让当前 turnId 通过，历史轮次不能冒充活跃', () => {
    expect(
      resolvePermissionTurnIdentity({
        activeTurnId: 'turn-live',
        lastTurnId: 'turn-live',
        state: 'running',
        requestedTurnId: 'turn-live'
      })
    ).toEqual({ turnId: 'turn-live', active: true })
    expect(
      resolvePermissionTurnIdentity({
        activeTurnId: 'turn-live',
        lastTurnId: 'turn-old',
        state: 'waiting-permission',
        requestedTurnId: 'turn-old'
      })
    ).toEqual({ turnId: 'turn-live', active: false })
  })

  it('无活动 Turn 时只允许 lastTurn 进入 Broker，供最新一轮受控恢复', () => {
    expect(
      resolvePermissionTurnIdentity({
        lastTurnId: 'turn-1',
        state: 'completed',
        requestedTurnId: 'turn-1'
      })
    ).toEqual({ turnId: 'turn-1', active: true })
    expect(
      resolvePermissionTurnIdentity({
        lastTurnId: 'turn-1',
        state: 'completed',
        requestedTurnId: 'turn-0'
      })
    ).toEqual({ turnId: 'turn-1', active: false })
  })
})
