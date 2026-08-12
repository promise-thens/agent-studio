import type { DesktopIpcResult } from './ipc-result'
import type { DeletionPreview, ProjectSummary } from './task-history'

export const APP_INVOKE_CHANNELS = {
  chooseProject: 'app:choose-project',
  listProjects: 'app:list-projects',
  removeProject: 'app:remove-project',
  previewProjectHistoryDeletion: 'app:preview-project-history-deletion',
  deleteProjectHistory: 'app:delete-project-history'
} as const

/** Renderer 只能通过 App 域注册和管理 Project，不能自行提交执行路径。 */
export interface AppDesktopApi {
  chooseProject: () => Promise<DesktopIpcResult<ProjectSummary | null>>
  listProjects: () => Promise<DesktopIpcResult<ProjectSummary[]>>
  removeProject: (projectId: string) => Promise<DesktopIpcResult<null>>
  previewProjectHistoryDeletion: (projectId: string) => Promise<DesktopIpcResult<DeletionPreview>>
  deleteProjectHistory: (projectId: string, token: string) => Promise<DesktopIpcResult<null>>
}
