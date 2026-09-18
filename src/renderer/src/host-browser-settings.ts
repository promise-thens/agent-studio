import { parseBrowserOrigin } from '../../shared/browser-origin'
import type {
  HostBrowserAgentPermissionMode,
  HostBrowserLinkOpenTarget,
  HostBrowserScreenshotAnnotation,
  HostBrowserSettings
} from '../../shared/host-browser'

export const HOST_BROWSER_SETTING_PAGE_TITLE = '浏览器'

export const HOST_BROWSER_SETTING_PAGE_SUBTITLE = '管理 Browser Use 偏好设置和网站访问权限'

export const HOST_BROWSER_SETTING_TITLE = '让 Grok 控制内置浏览器'

export const HOST_BROWSER_SETTING_HINT =
  '默认开启。Grok 经宿主 MCP 操作工作台右侧同一只浏览器。更改下一 session 生效，不会假装当前 Turn 已经有或没有这些工具。'

export const HOST_BROWSER_SETTING_BUSY_TITLE = '任务执行中，结束后才能改内置浏览器'

export const HOST_BROWSER_SETTING_LOADING_COPY = '正在读取设置…'

export const HOST_BROWSER_SETTING_LOAD_ERROR_COPY = '读取设置失败。'

export const HOST_BROWSER_SETTING_RETRY_LABEL = '重试读取内置浏览器设置'

export const HOST_BROWSER_SETTING_SAVING_COPY = '正在保存…'

export const HOST_BROWSER_SETTING_SAVED_SESSION_COPY = '已保存。下一 session 生效。'

export const HOST_BROWSER_SETTING_SAVED_COPY = '已保存。'

export const HOST_BROWSER_GROUP_GENERAL_TITLE = '常规'

export const HOST_BROWSER_GROUP_PASSWORDS_TITLE = '自动填充和密码'

export const HOST_BROWSER_GROUP_DOWNLOADS_TITLE = '下载'

export const HOST_BROWSER_GROUP_AGENT_PERMISSIONS_TITLE = '智能体权限'

export const HOST_BROWSER_GROUP_EXTENSION_TITLE = '配套扩展'

export const HOST_BROWSER_GROUP_FULL_CDP_TITLE = '完整 CDP'

export const HOST_BROWSER_GROUP_CAUTIOUS_TITLE = '谨慎模式'

export const HOST_BROWSER_LINK_OPEN_LABEL = '链接打开位置'

export const HOST_BROWSER_SHOW_FULL_URL_LABEL = '显示完整网址'

export const HOST_BROWSER_SCREENSHOT_ANNOTATION_LABEL = '批注截图'

export const HOST_BROWSER_SCREENSHOT_TOKEN_HINT = '会增加 token'

export const HOST_BROWSER_CLEAR_DATA_LABEL = '清除浏览数据'

export const HOST_BROWSER_CLEAR_DATA_TITLE = '清除内置浏览器的 Cookie、缓存、历史和下载记录'

export const HOST_BROWSER_CLEAR_DATA_STATUS = '已提交清除浏览数据。'

export const HOST_BROWSER_CLEAR_DATA_KINDS = ['cookies', 'cache', 'history', 'downloads'] as const

export const HOST_BROWSER_PASSWORDS_BODY =
  '内置密码库尚未接入。Chrome 若未开放密码 API，不会假装已同步密码。'

export const HOST_BROWSER_DOWNLOAD_ASK_LABEL = '下载前询问'

export const HOST_BROWSER_EXTENSION_MISSING = '未检测到配套扩展'

export const HOST_BROWSER_COOKIE_SYNC_LABEL = '同步 Cookie 与登录态'

export const HOST_BROWSER_CHROME_CONNECT_LABEL = '连接用户 Chrome'

export const HOST_BROWSER_SYNC_BLACKLIST_LABEL = '不同步这些站点'

export const HOST_BROWSER_SYNC_BLACKLIST_HINT =
  '一行一个 origin。留空表示不同步名单为空，不是出厂白名单。'

export const HOST_BROWSER_SYNC_BLACKLIST_INVALID_COPY =
  '黑名单只接受 http(s) origin，一行一个，最多 64 项。'

export const HOST_BROWSER_FULL_CDP_HINT = '可检查并控制敏感浏览器内部功能。出厂开启。'

export const HOST_BROWSER_CAUTIOUS_HINT = '打开后才启用确认矩阵。出厂关闭。'

export const HOST_BROWSER_LINK_OPEN_OPTIONS = [
  { value: 'studio', label: 'Agent Studio' },
  { value: 'system', label: '系统浏览器' }
] as const satisfies ReadonlyArray<{ value: HostBrowserLinkOpenTarget; label: string }>

export const HOST_BROWSER_SCREENSHOT_ANNOTATION_OPTIONS = [
  { value: 'always', label: '始终包含' },
  { value: 'ask', label: '询问' },
  { value: 'never', label: '从不' }
] as const satisfies ReadonlyArray<{ value: HostBrowserScreenshotAnnotation; label: string }>

export const HOST_BROWSER_AGENT_PERMISSION_COLUMNS = [
  { key: 'browse', label: '浏览' },
  { key: 'download', label: '下载' },
  { key: 'upload', label: '上传' },
  { key: 'debug', label: '调试' }
] as const

export const HOST_BROWSER_AGENT_PERMISSION_OPTIONS = [
  { value: 'always', label: '始终允许' },
  { value: 'ask', label: '询问' }
] as const satisfies ReadonlyArray<{ value: HostBrowserAgentPermissionMode; label: string }>

export type HostBrowserSettingsLoadState = 'loading' | 'ready' | 'error'

const HOST_BROWSER_MAX_SYNC_BLACKLIST_DRAFT = 64

export function resolveHostBrowserSettingTitle(input: { runtimeBusy: boolean }): string {
  return input.runtimeBusy ? HOST_BROWSER_SETTING_BUSY_TITLE : HOST_BROWSER_SETTING_TITLE
}

/** 总开关才看 runtimeBusy；其它分组执行中仍可改。 */
export function resolveHostBrowserMasterSwitchDisabled(input: {
  runtimeBusy: boolean
  saving: boolean
  loadState: HostBrowserSettingsLoadState
}): boolean {
  return input.runtimeBusy || input.saving || input.loadState !== 'ready'
}

/** 偏好补丁不跟任务执行互斥，只在读取未完成或保存中禁用。 */
export function resolveHostBrowserPreferenceDisabled(input: {
  saving: boolean
  loadState: HostBrowserSettingsLoadState
}): boolean {
  return input.saving || input.loadState !== 'ready'
}

export function cloneHostBrowserSettingsView(settings: HostBrowserSettings): HostBrowserSettings {
  return {
    ...settings,
    agentPermissions: { ...settings.agentPermissions },
    syncBlacklist: [...settings.syncBlacklist]
  }
}

export function formatHostBrowserSyncBlacklist(origins: readonly string[]): string {
  return origins.join('\n')
}

/**
 * 黑名单草稿只在 Renderer 做交互校验；主进程仍会再 parse 一遍。
 * 非法 origin 或超过 64 项整包失败，避免把半份名单送进 IPC。
 */
export function parseHostBrowserSyncBlacklistDraft(text: string): string[] | null {
  const origins: string[] = []
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const origin = parseBrowserOrigin(trimmed)
    if (!origin) return null
    if (seen.has(origin)) continue
    seen.add(origin)
    origins.push(origin)
    if (origins.length > HOST_BROWSER_MAX_SYNC_BLACKLIST_DRAFT) return null
  }
  return origins
}
