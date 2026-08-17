import { describe, expect, it } from 'vitest'
import { OperationGate, OperationGateConflictError, type OperationLease } from './operation-gate'

const ACQUIRES = [
  ['execution-admission', (gate: OperationGate) => gate.acquireExecutionAdmission()],
  ['provider-mutation', (gate: OperationGate) => gate.acquireProviderMutation()],
  ['session-operation', (gate: OperationGate) => gate.acquireSessionOperation()]
] as const

describe('OperationGate', () => {
  it('初始为空闲且尚未进入 shutdown', () => {
    const gate = new OperationGate()
    expect(gate.getState()).toBe('idle')
    expect(gate.isShuttingDown()).toBe(false)
  })

  it.each(ACQUIRES)('%s lease 同步占用并可精确释放', (kind, acquire) => {
    const gate = new OperationGate()
    const lease = acquire(gate)

    expect(lease.kind).toBe(kind)
    expect(lease.isCurrent()).toBe(true)
    expect(gate.getState()).not.toBe('idle')
    expect(lease.release()).toBe(true)
    expect(lease.release()).toBe(false)
    expect(gate.getState()).toBe('idle')
  })

  it.each(ACQUIRES)('持有 %s 时拒绝所有其它普通操作', (_kind, acquire) => {
    const gate = new OperationGate()
    const current = acquire(gate)

    for (const [requested, request] of ACQUIRES) {
      expect(() => request(gate)).toThrowError(OperationGateConflictError)
      try {
        request(gate)
      } catch (error) {
        expect(error).toMatchObject({ requested, currentState: gate.getState() })
      }
    }
    expect(current.isCurrent()).toBe(true)
  })

  it('admission activate 会原子替换 token，旧 lease 立即失效', () => {
    const gate = new OperationGate()
    const admission = gate.acquireExecutionAdmission()
    const active = admission.activate()

    expect(active).not.toBeNull()
    expect(active?.kind).toBe('execution-active')
    expect(gate.getState()).toBe('execution-active')
    expect(admission.isCurrent()).toBe(false)
    expect(admission.release()).toBe(false)
    expect(admission.activate()).toBeNull()
    expect(active?.release()).toBe(true)
    expect(gate.getState()).toBe('idle')
  })

  it('admission 释放后不能重新 activate', () => {
    const gate = new OperationGate()
    const admission = gate.acquireExecutionAdmission()

    expect(admission.release()).toBe(true)
    expect(admission.activate()).toBeNull()
    expect(gate.getState()).toBe('idle')
  })

  it('旧 lease 的晚到 finally 不会释放后来建立的新 reservation', () => {
    const gate = new OperationGate()
    const first = gate.acquireProviderMutation()
    expect(first.release()).toBe(true)
    const second = gate.acquireProviderMutation()

    expect(first.release()).toBe(false)
    expect(second.isCurrent()).toBe(true)
    expect(gate.getState()).toBe('provider-mutation')
  })

  it('只认可本 Gate 签发且仍 current 的 lease', () => {
    const gate = new OperationGate()
    const foreignGate = new OperationGate()
    const own = gate.acquireProviderMutation()
    const foreign = foreignGate.acquireProviderMutation()

    expect(gate.ownsCurrentLease(own)).toBe(true)
    expect(gate.ownsCurrentLease(foreign)).toBe(false)
    expect(own.release()).toBe(true)
    expect(gate.ownsCurrentLease(own)).toBe(false)
  })

  it('execution active 释放后旧 active lease 不能影响新 admission', () => {
    const gate = new OperationGate()
    const admission = gate.acquireExecutionAdmission()
    const active = requireLease(admission.activate())
    expect(active.release()).toBe(true)
    const next = gate.acquireExecutionAdmission()

    expect(active.release()).toBe(false)
    expect(next.isCurrent()).toBe(true)
    expect(gate.getState()).toBe('admitting-execution')
  })

  it('shutdown 可从任意状态开始，且旧 lease drain 后仍不可逆', () => {
    for (const [, acquire] of ACQUIRES) {
      const gate = new OperationGate()
      const lease = acquire(gate)
      const before = gate.getState()
      const shutdown = gate.beginShutdown()

      expect(shutdown.previousState).toBe(before)
      expect(gate.getState()).toBe('shutting-down')
      expect(gate.isShuttingDown()).toBe(true)
      expect(lease.release()).toBe(true)
      expect(gate.getState()).toBe('shutting-down')
      assertAllAcquiresBlocked(gate)
    }
  })

  it('shutdown 与 admission activate 竞态时禁止 dispatch', () => {
    const gate = new OperationGate()
    const admission = gate.acquireExecutionAdmission()

    gate.beginShutdown()
    expect(admission.activate()).toBeNull()
    expect(admission.release()).toBe(true)
    expect(gate.getState()).toBe('shutting-down')
  })

  it('重复 beginShutdown 复用同一 transaction identity', () => {
    const gate = new OperationGate()
    const first = gate.beginShutdown()
    const second = gate.beginShutdown()

    expect(second).toBe(first)
    expect(second.transactionId).toBe(first.transactionId)
    expect(first.isCurrent()).toBe(true)
    assertAllAcquiresBlocked(gate)
  })
})

function requireLease(lease: OperationLease | null): OperationLease {
  if (!lease) throw new Error('测试需要有效 lease。')
  return lease
}

function assertAllAcquiresBlocked(gate: OperationGate): void {
  for (const [, acquire] of ACQUIRES) {
    expect(() => acquire(gate)).toThrowError(OperationGateConflictError)
  }
}
