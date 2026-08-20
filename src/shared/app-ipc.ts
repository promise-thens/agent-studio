import type { AppAppearanceMode, AppAppearanceState } from './app-appearance'
import type { DesktopIpcResult } from './ipc-result'
import type { DeletionPreview, ProjectSummary } from './task-history'

export const APP_INVOKE_CHANNELS = {
  chooseProject: 'app:choose-project',
  listProjects: 'app:list-projects',
  removeProject: 'app:remove-project',
  previewProjectHistoryDeletion: 'app:preview-project-history-deletion',
  deleteProjectHistory: 'app:delete-project-history',
  getAppearance: 'app:get-appearance',
  setAppearance: 'app:set-appearance'
} as const

export const APP_PUSH_CHANNELS = {
  appearance: 'app:appearance'
} as const

export interface AppSetAppearanceRequest {
  mode: AppAppearanceMode
}

/** Renderer 只能通过 App 域注册 Project、读写外观偏好，不能自行提交执行路径。 */
export interface AppDesktopApi {
  chooseProject: () => Promise<DesktopIpcResult<ProjectSummary | null>>
  listProjects: () => Promise<DesktopIpcResult<ProjectSummary[]>>
  removeProject: (projectId: string) => Promise<DesktopIpcResult<null>>
  previewProjectHistoryDeletion: (projectId: string) => Promise<DesktopIpcResult<DeletionPreview>>
  deleteProjectHistory: (projectId: string, token: string) => Promise<DesktopIpcResult<null>>
  getAppearance: () => Promise<DesktopIpcResult<AppAppearanceState>>
  setAppearance: (mode: AppAppearanceMode) => Promise<DesktopIpcResult<AppAppearanceState>>
  onAppearanceChanged: (listener: (state: AppAppearanceState) => void) => () => void
}
