import type { DesktopIpcResult } from './ipc-result'

export const APP_INVOKE_CHANNELS = {
  chooseWorkspace: 'app:choose-workspace'
} as const

/** Renderer 只能通过 App 域打开工作目录选择器。 */
export interface AppDesktopApi {
  chooseWorkspace: () => Promise<DesktopIpcResult<string | null>>
}
