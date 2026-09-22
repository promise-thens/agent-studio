import { describe, expect, it, vi } from 'vitest'
import type { TaskExecutionSnapshot } from '../../shared/task-execution'
import { runPermissionControlTurn } from './permission-control-turn'

/** 只投影控制器读取的身份和状态，显式模拟终态早于槽释放。 */
function snapshot(state: string, executionId = 'control-1'): TaskExecutionSnapshot {
  return { executorEpoch: 'epoch', executionRevision: 1, execution: { executionId, state } } as TaskExecutionSnapshot
}

describe('权限控制回合终态确认', () => {
  it('start 返回和终态推送均不能提前应用，必须等执行槽释放', async () => {
    let release!: () => void
    const completion = new Promise<void>((resolve) => { release = resolve })
    let active = true
    let current = snapshot('queued')
    const executor = {
      waitForTerminal: () => completion,
      getSnapshot: () => current,
      hasActiveExecution: () => active
    }
    const finished = vi.fn()
    const result = runPermissionControlTurn(executor, async () => current).then((outcome) => {
      finished(outcome)
      return outcome
    })
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    current = snapshot('completed')
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    active = false
    release()
    await expect(result).resolves.toBe('completed')
  })

  it.each(['failed', 'cancelled', 'interrupted'])('失败终态 %s 不得确认成功', async (state) => {
    const executor = {
      waitForTerminal: async () => undefined,
      getSnapshot: () => snapshot(state),
      hasActiveExecution: () => false
    }
    await expect(runPermissionControlTurn(executor, async () => snapshot('queued'))).resolves.toBe(state === 'cancelled' ? 'cancelled' : 'failed')
  })

  it('错身份或未释放槽保持失败关闭', async () => {
    for (const [id, active] of [['other', false], ['control-1', true]] as const) {
      const executor = {
        waitForTerminal: async () => undefined,
        getSnapshot: () => snapshot('completed', id),
        hasActiveExecution: () => active
      }
      await expect(runPermissionControlTurn(executor, async () => snapshot('queued'))).rejects.toThrow('状态不确定')
    }
  })
})
