import type { AppAppearanceMode, AppAppearanceState } from './app-appearance'
import type { DesktopIpcResult } from './ipc-result'
import type { RuntimePluginDetail, RuntimePluginSummary } from './runtime-plugin'
import type { DeletionPreview, ProjectSummary } from './task-history'

export const APP_INVOKE_CHANNELS = {
  chooseProject: 'app:choose-project',
  listProjects: 'app:list-projects',
  revealProject: 'app:reveal-project',
  removeProject: 'app:remove-project',
  previewProjectHistoryDeletion: 'app:preview-project-history-deletion',
  deleteProjectHistory: 'app:delete-project-history',
  getAppearance: 'app:get-appearance',
  setAppearance: 'app:set-appearance',
  listPlugins: 'app:list-plugins',
  getPlugin: 'app:get-plugin'
} as const

export const APP_PUSH_CHANNELS = {
  appearance: 'app:appearance'
} as const

export interface AppSetAppearanceRequest {
  mode: AppAppearanceMode
}

export interface AppGetPluginRequest {
  pluginId: string
}

/** Renderer 只能通过 App 域注册 Project、读写外观偏好与插件摘要，不能自行提交执行路径。 */
export interface AppDesktopApi {
  chooseProject: () => Promise<DesktopIpcResult<ProjectSummary | null>>
  listProjects: () => Promise<DesktopIpcResult<ProjectSummary[]>>
  /** 只传已注册 projectId，由主进程打开 canonicalRoot，不回传路径。 */
  revealProject: (projectId: string) => Promise<DesktopIpcResult<null>>
  removeProject: (projectId: string) => Promise<DesktopIpcResult<null>>
  previewProjectHistoryDeletion: (projectId: string) => Promise<DesktopIpcResult<DeletionPreview>>
  deleteProjectHistory: (projectId: string, token: string) => Promise<DesktopIpcResult<null>>
  getAppearance: () => Promise<DesktopIpcResult<AppAppearanceState>>
  setAppearance: (mode: AppAppearanceMode) => Promise<DesktopIpcResult<AppAppearanceState>>
  /** 列出 App 专属 grok-home 已安装插件摘要，不回传绝对路径。 */
  listPlugins: () => Promise<DesktopIpcResult<RuntimePluginSummary[]>>
  /** 读取单个插件详情；pluginId 非法 → invalid-input，缺失 → not-found。 */
  getPlugin: (pluginId: string) => Promise<DesktopIpcResult<RuntimePluginDetail>>
  onAppearanceChanged: (listener: (state: AppAppearanceState) => void) => () => void
}
