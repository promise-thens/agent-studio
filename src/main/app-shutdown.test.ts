import { describe, expect, it, vi } from 'vitest'
import { createAppShutdownGate } from './app-shutdown'

describe('App 退出清理门禁', () => {
  it('首次退出会等待权限审计和 Runtime 清理，多次事件不会重复执行', async () => {
    const permissionCleanup = deferred<void>()
    const runtimeCleanup = deferred<void>()
    const quit = vi.fn()
    const disconnectRuntime = vi.fn(() => runtimeCleanup.promise)
    const gate = createAppShutdownGate({
      shutdownPermissions: vi.fn(() => permissionCleanup.promise),
      disconnectRuntime,
      quit
    })
    const firstEvent = { preventDefault: vi.fn() }
    const duplicateEvent = { preventDefault: vi.fn() }

    gate.handleBeforeQuit(firstEvent)
    gate.handleBeforeQuit(duplicateEvent)
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce()
    expect(duplicateEvent.preventDefault).toHaveBeenCalledOnce()
    expect(quit).not.toHaveBeenCalled()
    expect(disconnectRuntime).not.toHaveBeenCalled()

    permissionCleanup.resolve()
    await vi.waitFor(() => expect(disconnectRuntime).toHaveBeenCalledOnce())
    expect(quit).not.toHaveBeenCalled()
    runtimeCleanup.resolve()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())

    const retriedEvent = { preventDefault: vi.fn() }
    gate.handleBeforeQuit(retriedEvent)
    expect(retriedEvent.preventDefault).not.toHaveBeenCalled()
  })

  it('继续等待会取消本次退出且不会关闭 Broker 或冻结新操作', async () => {
    const shutdownPermissions = vi.fn(async () => undefined)
    const beginShutdown = vi.fn()
    const quit = vi.fn()
    const gate = createAppShutdownGate({
      hasActiveExecution: () => true,
      chooseActiveExecutionAction: async () => 'continue-waiting',
      beginShutdown,
      shutdownPermissions,
      disconnectRuntime: vi.fn(async () => undefined),
      quit
    })

    gate.handleBeforeQuit({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(gate.isShuttingDown()).toBe(false))
    expect(beginShutdown).not.toHaveBeenCalled()
    expect(shutdownPermissions).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })

  it('确认退出后先冻结操作，再按取消、历史、权限和 Runtime 顺序收束', async () => {
    const calls: string[] = []
    const quit = vi.fn()
    const gate = createAppShutdownGate({
      hasActiveExecution: () => true,
      chooseActiveExecutionAction: async () => 'cancel-and-quit',
      beginShutdown: () => calls.push('begin'),
      cancelActiveExecution: async () => {
        calls.push('cancel')
      },
      drainHistory: async () => {
        calls.push('history')
      },
      shutdownPermissions: async () => {
        calls.push('permissions')
      },
      disconnectRuntime: async () => {
        calls.push('runtime')
      },
      quit
    })

    gate.handleBeforeQuit({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    expect(calls).toEqual(['begin', 'cancel', 'history', 'permissions', 'runtime'])
  })

  it('force 路径使用中断语义并调用 forceQuit', async () => {
    const interrupt = vi.fn(async () => undefined)
    const forceQuit = vi.fn()
    const gate = createAppShutdownGate({
      hasActiveExecution: () => true,
      chooseActiveExecutionAction: async () => 'force-quit',
      interruptActiveExecution: interrupt,
      shutdownPermissions: vi.fn(async () => undefined),
      disconnectRuntime: vi.fn(async () => undefined),
      quit: vi.fn(),
      forceQuit
    })

    gate.handleBeforeQuit({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(forceQuit).toHaveBeenCalledOnce())
    expect(interrupt).toHaveBeenCalledOnce()
  })

  it('单项清理失败仍会等待全部收束后重试退出', async () => {
    const runtimeCleanup = deferred<void>()
    const quit = vi.fn()
    const disconnectRuntime = vi.fn(() => runtimeCleanup.promise)
    const gate = createAppShutdownGate({
      shutdownPermissions: vi.fn(async () => {
        throw new Error('audit failed')
      }),
      disconnectRuntime,
      quit
    })

    gate.handleBeforeQuit({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(disconnectRuntime).toHaveBeenCalledOnce())
    expect(quit).not.toHaveBeenCalled()
    runtimeCleanup.resolve()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
  })
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value?: T | PromiseLike<T>) => void
} {
  let resolve!: (value?: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise as (value?: T | PromiseLike<T>) => void
  })
  return { promise, resolve }
}
