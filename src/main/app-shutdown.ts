export interface AppShutdownDependencies {
  shutdownPermissions: () => Promise<void>
  disconnectRuntime: () => Promise<unknown>
  quit: () => void
}

/**
 * Electron before-quit 不等待 Promise；此门禁只拦截首次退出，等权限审计与 Runtime 清理后再重试。
 * 多次 before-quit 共享同一 Promise，清理完成后的重试不再 preventDefault。
 */
export function createAppShutdownGate(dependencies: AppShutdownDependencies): {
  handleBeforeQuit: (event: { preventDefault(): void }) => void
} {
  let cleanup: Promise<void> | null = null
  let cleanupFinished = false

  return {
    handleBeforeQuit(event): void {
      if (cleanupFinished) return
      event.preventDefault()
      if (cleanup) return

      cleanup = (async () => {
        try {
          await dependencies.shutdownPermissions()
        } catch {
          // 权限审计失败不能阻止 Runtime 最终退出，但 Runtime 清理必须在权限路径收束后开始。
        }
        await dependencies.disconnectRuntime().catch(() => undefined)
      })()
      void cleanup.finally(() => {
        cleanupFinished = true
        dependencies.quit()
      })
    }
  }
}
