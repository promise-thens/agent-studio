export type AppShutdownChoice = 'continue-waiting' | 'cancel-and-quit' | 'force-quit'

export interface AppShutdownDependencies {
  hasActiveExecution?: () => boolean
  chooseActiveExecutionAction?: () => Promise<AppShutdownChoice>
  beginShutdown?: () => void
  cancelActiveExecution?: () => Promise<void>
  interruptActiveExecution?: () => Promise<void>
  drainHistory?: () => Promise<void>
  shutdownPermissions: () => Promise<void>
  disconnectRuntime: () => Promise<unknown>
  quit: () => void
  forceQuit?: () => void
  gracefulTimeoutMs?: number
  forceTimeoutMs?: number
  scheduleTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearScheduledTimeout?: (timer: ReturnType<typeof setTimeout>) => void
}

export interface AppShutdownGate {
  handleBeforeQuit(event: { preventDefault(): void }): void
  isShuttingDown(): boolean
}

/**
 * Electron before-quit 不等待 Promise；Gate 在不可逆 shutdown 前先完成活动执行选择。
 * 继续等待不会关闭 Broker；确认退出后所有 drain 都受总期限约束，重复事件复用同一 transaction。
 */
export function createAppShutdownGate(dependencies: AppShutdownDependencies): AppShutdownGate {
  let transaction: Promise<void> | null = null
  let cleanupFinished = false
  let shuttingDown = false
  const schedule = dependencies.scheduleTimeout ?? setTimeout
  const clear = dependencies.clearScheduledTimeout ?? clearTimeout

  async function withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    fallback: () => T
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      let settled = false
      const timer = schedule(() => {
        if (settled) return
        settled = true
        resolve(fallback())
      }, timeoutMs)
      void operation.then(
        (value) => {
          if (settled) return
          settled = true
          clear(timer)
          resolve(value)
        },
        () => {
          if (settled) return
          settled = true
          clear(timer)
          resolve(fallback())
        }
      )
    })
  }

  async function runShutdown(
    choice: Exclude<AppShutdownChoice, 'continue-waiting'>
  ): Promise<void> {
    shuttingDown = true
    dependencies.beginShutdown?.()
    const gracefulTimeout = dependencies.gracefulTimeoutMs ?? 5_000
    const forceTimeout = dependencies.forceTimeoutMs ?? 2_000

    if (choice === 'cancel-and-quit') {
      await withTimeout(
        dependencies.cancelActiveExecution?.() ?? Promise.resolve(),
        gracefulTimeout,
        () => undefined
      )
    } else {
      await withTimeout(
        dependencies.interruptActiveExecution?.() ?? Promise.resolve(),
        forceTimeout,
        () => undefined
      )
    }

    await withTimeout(
      dependencies.drainHistory?.() ?? Promise.resolve(),
      forceTimeout,
      () => undefined
    )
    await withTimeout(dependencies.shutdownPermissions(), forceTimeout, () => undefined)
    await withTimeout(dependencies.disconnectRuntime(), forceTimeout, () => undefined)
  }

  return {
    handleBeforeQuit(event): void {
      if (cleanupFinished) return
      event.preventDefault()
      if (transaction) return

      transaction = (async () => {
        const hasActiveExecution = dependencies.hasActiveExecution?.() ?? false
        const choice = hasActiveExecution
          ? await (dependencies.chooseActiveExecutionAction?.() ??
              Promise.resolve<AppShutdownChoice>('cancel-and-quit'))
          : 'cancel-and-quit'
        if (choice === 'continue-waiting') {
          transaction = null
          return
        }
        await runShutdown(choice)
        cleanupFinished = true
        if (choice === 'force-quit') dependencies.forceQuit?.()
        else dependencies.quit()
      })().catch(() => {
        cleanupFinished = true
        dependencies.forceQuit?.()
      })
    },
    isShuttingDown(): boolean {
      return shuttingDown
    }
  }
}
