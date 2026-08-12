import { describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeTurnRef } from './agent-runtime-adapter'
import { TaskExecutionConflictError, TaskExecutionController } from './task-execution-controller'

const FIRST_TURN: AgentRuntimeTurnRef = {
  taskId: 'task-1',
  turnId: 'turn-1',
  runtimeSessionId: 'session-1'
}

describe('TaskExecutionController', () => {
  it('只允许一个活动 Turn，并在操作完成后释放执行槽', async () => {
    const controller = new TaskExecutionController()
    const operation = deferred<void>()
    const firstExecution = controller.execute(FIRST_TURN, () => operation.promise)

    expect(controller.getActiveTurn()).toEqual(FIRST_TURN)
    await expect(
      controller.execute(
        { taskId: 'task-2', turnId: 'turn-2', runtimeSessionId: 'session-2' },
        async () => undefined
      )
    ).rejects.toBeInstanceOf(TaskExecutionConflictError)

    operation.resolve()
    await firstExecution
    expect(controller.getActiveTurn()).toBeNull()
  })

  it('重复取消只调用一次 Runtime，取消失败后允许重试', async () => {
    const controller = new TaskExecutionController()
    const operation = deferred<void>()
    const execution = controller.execute(FIRST_TURN, () => operation.promise)
    const cancel = vi.fn().mockResolvedValue(undefined)

    await controller.cancel(cancel)
    await controller.cancel(cancel)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith(FIRST_TURN)

    operation.resolve()
    await execution

    const retryOperation = deferred<void>()
    const retryExecution = controller.execute(FIRST_TURN, () => retryOperation.promise)
    const rejectedCancel = vi.fn().mockRejectedValueOnce(new Error('有限测试错误'))
    await expect(controller.cancel(rejectedCancel)).rejects.toThrow('有限测试错误')
    await expect(controller.cancel(rejectedCancel)).resolves.toBeUndefined()
    expect(rejectedCancel).toHaveBeenCalledTimes(2)

    retryOperation.resolve()
    await retryExecution
  })

  it('旧 Turn 的晚到 release 不会清空后来占用的新槽', async () => {
    const controller = new TaskExecutionController()
    const firstOperation = deferred<void>()
    const firstExecution = controller.execute(FIRST_TURN, () => firstOperation.promise)
    controller.release(FIRST_TURN)

    const secondTurn: AgentRuntimeTurnRef = {
      taskId: 'task-2',
      turnId: 'turn-2',
      runtimeSessionId: 'session-2'
    }
    const secondOperation = deferred<void>()
    const secondExecution = controller.execute(secondTurn, () => secondOperation.promise)

    firstOperation.resolve()
    await firstExecution
    expect(controller.getActiveTurn()).toEqual(secondTurn)

    secondOperation.resolve()
    await secondExecution
    expect(controller.getActiveTurn()).toBeNull()
  })
})

/** 构造可控 Promise，精确验证并发与收束时序。 */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
