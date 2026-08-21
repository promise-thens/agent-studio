import type { AppAppearanceMode, AppAppearanceState } from './app-appearance'
import type { DesktopIpcResult } from './ipc-result'
import type { GrokMemoryDocument, GrokMemoryEnabledState, GrokMemorySummary } from './grok-memory'
import type { McpServerInput, McpServerSummary } from './mcp-server-config'
import type { MarketplacePluginSummary } from './runtime-marketplace-plugin'
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
  getPlugin: 'app:get-plugin',
  setPluginEnabled: 'app:set-plugin-enabled',
  getGrokConfig: 'app:get-grok-config',
  saveGrokConfig: 'app:save-grok-config',
  listMemories: 'app:list-memories',
  getMemory: 'app:get-memory',
  saveMemory: 'app:save-memory',
  deleteMemory: 'app:delete-memory',
  getMemoryEnabled: 'app:get-memory-enabled',
  setMemoryEnabled: 'app:set-memory-enabled',
  listMcpServers: 'app:list-mcp-servers',
  upsertMcpServer: 'app:upsert-mcp-server',
  deleteMcpServer: 'app:delete-mcp-server',
  listMarketplacePlugins: 'app:list-marketplace-plugins',
  installPlugin: 'app:install-plugin',
  uninstallPlugin: 'app:uninstall-plugin',
  addMarketplaceSource: 'app:add-marketplace-source'
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

export interface AppSetPluginEnabledRequest {
  pluginId: string
  enabled: boolean
}

export interface AppSaveGrokConfigRequest {
  text: string
}

export interface AppGrokConfigDocument {
  text: string
  seeded?: true
}

export interface AppListMemoriesRequest {
  projectHint?: string
}

export interface AppGetMemoryRequest {
  memoryId: string
}

export interface AppSaveMemoryRequest {
  memoryId: string
  markdown: string
}

export interface AppSetMemoryEnabledRequest {
  enabled: boolean
}

export interface AppListMcpServersRequest {
  projectId?: string
}

export interface AppDeleteMcpServerRequest {
  name: string
}

export interface AppPluginEnabledState {
  pluginId: string
  enabled: boolean
}

export interface AppInstallPluginRequest {
  name: string
  trust: boolean
}

export interface AppUninstallPluginRequest {
  pluginId: string
}

export interface AppAddMarketplaceSourceRequest {
  gitUrl: string
}

/** Renderer 只能通过 App 域注册 Project、读写外观偏好与插件摘要，不能自行提交执行路径或 git URL 当安装源。 */
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
  setPluginEnabled: (
    pluginId: string,
    enabled: boolean
  ) => Promise<DesktopIpcResult<AppPluginEnabledState>>
  getGrokConfig: () => Promise<DesktopIpcResult<AppGrokConfigDocument>>
  saveGrokConfig: (text: string) => Promise<DesktopIpcResult<null>>
  listMemories: (projectHint?: string) => Promise<DesktopIpcResult<GrokMemorySummary[]>>
  getMemory: (memoryId: string) => Promise<DesktopIpcResult<GrokMemoryDocument>>
  saveMemory: (memoryId: string, markdown: string) => Promise<DesktopIpcResult<GrokMemoryDocument>>
  deleteMemory: (memoryId: string) => Promise<DesktopIpcResult<null>>
  getMemoryEnabled: () => Promise<DesktopIpcResult<GrokMemoryEnabledState>>
  setMemoryEnabled: (enabled: boolean) => Promise<DesktopIpcResult<GrokMemoryEnabledState>>
  listMcpServers: (projectId?: string) => Promise<DesktopIpcResult<McpServerSummary[]>>
  upsertMcpServer: (input: McpServerInput) => Promise<DesktopIpcResult<McpServerSummary>>
  deleteMcpServer: (name: string) => Promise<DesktopIpcResult<null>>
  /** 列出 App grok-home 市场货架摘要，不回传 path / sha / url。 */
  listMarketplacePlugins: () => Promise<DesktopIpcResult<MarketplacePluginSummary[]>>
  /**
   * 安装当前货架中的插件。trust 非 true 时主进程不得附加 --trust。
   * 成功只回 null，不回传 CLI 输出或绝对路径。
   */
  installPlugin: (name: string, trust: boolean) => Promise<DesktopIpcResult<null>>
  uninstallPlugin: (pluginId: string) => Promise<DesktopIpcResult<null>>
  addMarketplaceSource: (gitUrl: string) => Promise<DesktopIpcResult<null>>
  onAppearanceChanged: (listener: (state: AppAppearanceState) => void) => () => void
}
