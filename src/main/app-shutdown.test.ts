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
