import type { TrustedIpcInvokeEvent } from './security/ipc-sender-validation'

export type DesktopIpcHandler = (event: TrustedIpcInvokeEvent, ...args: unknown[]) => unknown

/** 主进程模块只依赖注册固定 Handler 的最窄接口，便于隔离测试。 */
export interface DesktopIpcMain {
  handle: (channel: string, listener: DesktopIpcHandler) => void
}
