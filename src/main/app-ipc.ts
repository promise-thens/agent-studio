import { APP_INVOKE_CHANNELS } from '../shared/app-ipc'
import type { DesktopIpcResult } from '../shared/ipc-result'
import type { DesktopIpcMain } from './ipc-types'
import {
  DesktopIpcFailure,
  runDesktopIpcOperation,
  type TrustedIpcInvokeEvent
} from './security/ipc-sender-validation'

export interface AppIpcDependencies {
  ipcMain: DesktopIpcMain
  assertTrustedSender: (event: TrustedIpcInvokeEvent) => void
  chooseWorkspace: () => Promise<string | null>
  sanitizeError: (error: unknown) => string
}

/** 注册只负责桌面目录选择的 App IPC，不向 Renderer 暴露 Dialog 对象。 */
export function registerAppIpcHandlers(dependencies: AppIpcDependencies): void {
  dependencies.ipcMain.handle(
    APP_INVOKE_CHANNELS.chooseWorkspace,
    (event, ...args): Promise<DesktopIpcResult<string | null>> =>
      runDesktopIpcOperation(async () => {
        dependencies.assertTrustedSender(event)
        if (args.length !== 0) {
          throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
        }
        return dependencies.chooseWorkspace()
      }, dependencies.sanitizeError)
  )
}
