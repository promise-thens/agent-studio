import { parseBrowserOrigin } from './browser-origin'

/** 地址栏与 IPC 共用的 URL 上限，避免把整页 data URL 送进主进程。 */
export const HOST_BROWSER_MAX_URL_CHARS = 2048
/** 标题只用于 chrome 展示，截断后不得把页面全文带回 Renderer。 */
export const HOST_BROWSER_MAX_TITLE_CHARS = 512
/** Bounds 以 CSS 像素计；超出这个范围视为测量错误而不是超大窗口。 */
export const HOST_BROWSER_MAX_BOUND = 1_000_000

/**
 * Retina 上 capturePage 是物理像素，click_xy 是 CSS。
 * 截图必须缩到这个 viewport，模型按 PNG 点才不会整块偏掉。
 */
export function resolveScreenshotViewportCssSize(input: {
  viewportWidth: number
  viewportHeight: number
}): { width: number; height: number } | undefined {
  const width = input.viewportWidth
  const height = input.viewportHeight
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined
  if (width < 1 || height < 1) return undefined
  if (width > HOST_BROWSER_MAX_BOUND || height > HOST_BROWSER_MAX_BOUND) return undefined
  return { width: Math.round(width), height: Math.round(height) }
}

/** 图像素与 viewport CSS 不一致时必须缩放，禁止把 2x PNG 直接交给模型估点。 */
export function screenshotImageNeedsCssResize(
  image: { width: number; height: number },
  viewport: { width: number; height: number }
): boolean {
  return image.width !== viewport.width || image.height !== viewport.height
}

/**
 * 从 CDP Page.getLayoutMetrics 取出 CSS 视口。
 * 优先 cssVisualViewport，避免把设备像素或 View DIP 当成 click/截图空间。
 */
export function parseCssViewportFromLayoutMetrics(
  metrics: unknown
): { width: number; height: number } | undefined {
  if (!isPlainRecord(metrics)) return undefined
  const sources = [
    metrics.cssVisualViewport,
    metrics.cssLayoutViewport,
    metrics.visualViewport,
    metrics.layoutViewport
  ]
  for (const source of sources) {
    if (!isPlainRecord(source)) continue
    const parsed = resolveScreenshotViewportCssSize({
      viewportWidth: typeof source.clientWidth === 'number' ? source.clientWidth : Number.NaN,
      viewportHeight: typeof source.clientHeight === 'number' ? source.clientHeight : Number.NaN
    })
    if (parsed) return parsed
  }
  return undefined
}

export interface HostBrowserChrome {
  url: string
  title: string
  isLoading: boolean
  open: boolean
  /** 当前页面历史是否支持后退 */
  canGoBack?: boolean
  /** 当前页面历史是否支持前进 */
  canGoForward?: boolean
}

export interface HostBrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export type HostBrowserLinkOpenTarget = 'studio' | 'system'
export type HostBrowserScreenshotAnnotation = 'always' | 'ask' | 'never'
export type HostBrowserAgentPermissionMode = 'always' | 'ask'

export interface HostBrowserAgentPermissions {
  browse: HostBrowserAgentPermissionMode
  download: HostBrowserAgentPermissionMode
  upload: HostBrowserAgentPermissionMode
  debug: HostBrowserAgentPermissionMode
}

/** 出厂开放的完整偏好。Cookie 明文不得进入此结构，黑名单只存 origin。 */
export interface HostBrowserSettings {
  enabled: boolean
  linkOpenTarget: HostBrowserLinkOpenTarget
  showFullUrl: boolean
  screenshotAnnotation: HostBrowserScreenshotAnnotation
  downloadAskBefore: boolean
  agentPermissions: HostBrowserAgentPermissions
  fullCdp: boolean
  cautiousMode: boolean
  cookieSyncEnabled: boolean
  chromeConnectEnabled: boolean
  syncBlacklist: string[]
}

export const DEFAULT_HOST_BROWSER_SETTINGS: HostBrowserSettings = {
  enabled: true,
  linkOpenTarget: 'studio',
  showFullUrl: false,
  screenshotAnnotation: 'always',
  downloadAskBefore: false,
  agentPermissions: {
    browse: 'always',
    download: 'always',
    upload: 'always',
    debug: 'always'
  },
  fullCdp: true,
  cautiousMode: false,
  cookieSyncEnabled: true,
  chromeConnectEnabled: true,
  syncBlacklist: []
}

const HOST_BROWSER_MAX_SYNC_BLACKLIST = 64
const LINK_OPEN_TARGETS = new Set<HostBrowserLinkOpenTarget>(['studio', 'system'])
const SCREENSHOT_ANNOTATIONS = new Set<HostBrowserScreenshotAnnotation>(['always', 'ask', 'never'])
const AGENT_PERMISSION_MODES = new Set<HostBrowserAgentPermissionMode>(['always', 'ask'])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * 用户导航只允许 http(s)。
 * 这里复用 origin 解析，额外拒绝过长字符串，并把 URL 收成 href，避免把 javascript: / file: 交给 loadURL。
 */
export function parseHostBrowserNavigateUrl(url: string): string | null {
  if (typeof url !== 'string') return null
  const trimmed = url.trim()
  if (!trimmed || trimmed.includes('\0') || trimmed.length > HOST_BROWSER_MAX_URL_CHARS) return null
  if (!parseBrowserOrigin(trimmed)) return null
  try {
    return new URL(trimmed).href
  } catch {
    return null
  }
}

function parseChromeUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.includes('\0') || url.length > HOST_BROWSER_MAX_URL_CHARS) {
    return null
  }
  if (url === '' || url === 'about:blank') return url
  return parseHostBrowserNavigateUrl(url)
}

function parseChromeTitle(title: unknown): string | null {
  if (typeof title !== 'string' || title.includes('\0')) return null
  return title.length <= HOST_BROWSER_MAX_TITLE_CHARS
    ? title
    : title.slice(0, HOST_BROWSER_MAX_TITLE_CHARS)
}

/**
 * Preload / Renderer 只收可展示 chrome。cookie、HTML、CDP 节点一律丢掉。
 */
export function parseHostBrowserChrome(value: unknown): HostBrowserChrome | null {
  if (!isPlainRecord(value)) return null
  if (value.isLoading !== true && value.isLoading !== false) return null
  if (value.open !== true && value.open !== false) return null
  const url = parseChromeUrl(value.url)
  const title = parseChromeTitle(value.title)
  if (url === null || title === null) return null
  const chrome: HostBrowserChrome = {
    url,
    title,
    isLoading: value.isLoading,
    open: value.open
  }
  if (value.canGoBack === true) chrome.canGoBack = true
  if (value.canGoForward === true) chrome.canGoForward = true
  return chrome
}

/**
 * Renderer 只报整数矩形；主进程再校验一遍，拒绝浮点和异常大值。
 */
export function parseHostBrowserBounds(value: unknown): HostBrowserBounds | null {
  if (!isPlainRecord(value)) return null
  const x = readBound(value.x)
  const y = readBound(value.y)
  const width = readBound(value.width)
  const height = readBound(value.height)
  if (x === null || y === null || width === null || height === null) return null
  if (x < 0 || y < 0 || width < 1 || height < 1) return null
  if (
    x > HOST_BROWSER_MAX_BOUND ||
    y > HOST_BROWSER_MAX_BOUND ||
    width > HOST_BROWSER_MAX_BOUND ||
    height > HOST_BROWSER_MAX_BOUND
  ) {
    return null
  }
  return { x, y, width, height }
}

function readBound(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function cloneHostBrowserSettings(settings: HostBrowserSettings): HostBrowserSettings {
  return {
    ...settings,
    agentPermissions: { ...settings.agentPermissions },
    syncBlacklist: [...settings.syncBlacklist]
  }
}

function parseEnum<T extends string>(value: unknown, allowed: Set<T>): T | null {
  return typeof value === 'string' && allowed.has(value as T) ? (value as T) : null
}

function parseBooleanField(value: unknown): boolean | null {
  return value === true || value === false ? value : null
}

/**
 * 黑名单只收 parseBrowserOrigin 能认出的 http(s) origin。
 * 超过 64 项、含 userinfo / 非网页协议则整包失败，避免半份脏名单进同步。
 */
function parseSyncBlacklist(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > HOST_BROWSER_MAX_SYNC_BLACKLIST) return null
  const origins: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || item.length > HOST_BROWSER_MAX_URL_CHARS) return null
    const origin = parseBrowserOrigin(item)
    if (!origin) return null
    if (seen.has(origin)) continue
    seen.add(origin)
    origins.push(origin)
  }
  return origins
}

function parseAgentPermissions(value: unknown): HostBrowserAgentPermissions | null {
  if (!isPlainRecord(value)) return null
  const browse = parseEnum(value.browse, AGENT_PERMISSION_MODES)
  const download = parseEnum(value.download, AGENT_PERMISSION_MODES)
  const upload = parseEnum(value.upload, AGENT_PERMISSION_MODES)
  const debug = parseEnum(value.debug, AGENT_PERMISSION_MODES)
  if (!browse || !download || !upload || !debug) return null
  return { browse, download, upload, debug }
}

function readOptional<T>(
  record: Record<string, unknown>,
  key: string,
  parse: (value: unknown) => T | null,
  fallback: T
): T | null {
  return key in record ? parse(record[key]) : fallback
}

/**
 * 完整偏好：缺字段用出厂开放默认，未知键丢掉。
 * enabled 非法或黑名单非法则整包失败，禁止把脏配置当成“已开启”。
 */
export function parseHostBrowserSettings(value: unknown): HostBrowserSettings | null {
  if (!isPlainRecord(value)) return null
  const enabled = parseBooleanField(value.enabled)
  if (enabled === null) return null
  const linkOpenTarget = readOptional(
    value,
    'linkOpenTarget',
    (field) => parseEnum(field, LINK_OPEN_TARGETS),
    DEFAULT_HOST_BROWSER_SETTINGS.linkOpenTarget
  )
  const showFullUrl = readOptional(
    value,
    'showFullUrl',
    parseBooleanField,
    DEFAULT_HOST_BROWSER_SETTINGS.showFullUrl
  )
  const screenshotAnnotation = readOptional(
    value,
    'screenshotAnnotation',
    (field) => parseEnum(field, SCREENSHOT_ANNOTATIONS),
    DEFAULT_HOST_BROWSER_SETTINGS.screenshotAnnotation
  )
  const downloadAskBefore = readOptional(
    value,
    'downloadAskBefore',
    parseBooleanField,
    DEFAULT_HOST_BROWSER_SETTINGS.downloadAskBefore
  )
  const agentPermissions = readOptional(
    value,
    'agentPermissions',
    parseAgentPermissions,
    DEFAULT_HOST_BROWSER_SETTINGS.agentPermissions
  )
  const fullCdp = readOptional(
    value,
    'fullCdp',
    parseBooleanField,
    DEFAULT_HOST_BROWSER_SETTINGS.fullCdp
  )
  const cautiousMode = readOptional(
    value,
    'cautiousMode',
    parseBooleanField,
    DEFAULT_HOST_BROWSER_SETTINGS.cautiousMode
  )
  const cookieSyncEnabled = readOptional(
    value,
    'cookieSyncEnabled',
    parseBooleanField,
    DEFAULT_HOST_BROWSER_SETTINGS.cookieSyncEnabled
  )
  const chromeConnectEnabled = readOptional(
    value,
    'chromeConnectEnabled',
    parseBooleanField,
    DEFAULT_HOST_BROWSER_SETTINGS.chromeConnectEnabled
  )
  const syncBlacklist = readOptional(
    value,
    'syncBlacklist',
    parseSyncBlacklist,
    DEFAULT_HOST_BROWSER_SETTINGS.syncBlacklist
  )
  if (
    linkOpenTarget === null ||
    showFullUrl === null ||
    screenshotAnnotation === null ||
    downloadAskBefore === null ||
    agentPermissions === null ||
    fullCdp === null ||
    cautiousMode === null ||
    cookieSyncEnabled === null ||
    chromeConnectEnabled === null ||
    syncBlacklist === null
  ) {
    return null
  }
  return cloneHostBrowserSettings({
    enabled,
    linkOpenTarget,
    showFullUrl,
    screenshotAnnotation,
    downloadAskBefore,
    agentPermissions,
    fullCdp,
    cautiousMode,
    cookieSyncEnabled,
    chromeConnectEnabled,
    syncBlacklist
  })
}

/**
 * 设置页补丁不得含 enabled：总开关走独立 IPC，避免其它字段保存时把能力关掉。
 * 未知键丢掉；出现非法字段则整包失败。
 */
export function parseHostBrowserSettingsPatch(
  value: unknown
): Partial<Omit<HostBrowserSettings, 'enabled'>> | null {
  if (!isPlainRecord(value) || 'enabled' in value) return null
  const patch: Partial<Omit<HostBrowserSettings, 'enabled'>> = {}
  if ('linkOpenTarget' in value) {
    const parsed = parseEnum(value.linkOpenTarget, LINK_OPEN_TARGETS)
    if (!parsed) return null
    patch.linkOpenTarget = parsed
  }
  if ('showFullUrl' in value) {
    const parsed = parseBooleanField(value.showFullUrl)
    if (parsed === null) return null
    patch.showFullUrl = parsed
  }
  if ('screenshotAnnotation' in value) {
    const parsed = parseEnum(value.screenshotAnnotation, SCREENSHOT_ANNOTATIONS)
    if (!parsed) return null
    patch.screenshotAnnotation = parsed
  }
  if ('downloadAskBefore' in value) {
    const parsed = parseBooleanField(value.downloadAskBefore)
    if (parsed === null) return null
    patch.downloadAskBefore = parsed
  }
  if ('agentPermissions' in value) {
    const parsed = parseAgentPermissions(value.agentPermissions)
    if (!parsed) return null
    patch.agentPermissions = parsed
  }
  if ('fullCdp' in value) {
    const parsed = parseBooleanField(value.fullCdp)
    if (parsed === null) return null
    patch.fullCdp = parsed
  }
  if ('cautiousMode' in value) {
    const parsed = parseBooleanField(value.cautiousMode)
    if (parsed === null) return null
    patch.cautiousMode = parsed
  }
  if ('cookieSyncEnabled' in value) {
    const parsed = parseBooleanField(value.cookieSyncEnabled)
    if (parsed === null) return null
    patch.cookieSyncEnabled = parsed
  }
  if ('chromeConnectEnabled' in value) {
    const parsed = parseBooleanField(value.chromeConnectEnabled)
    if (parsed === null) return null
    patch.chromeConnectEnabled = parsed
  }
  if ('syncBlacklist' in value) {
    const parsed = parseSyncBlacklist(value.syncBlacklist)
    if (!parsed) return null
    patch.syncBlacklist = parsed
  }
  return patch
}

/** 走完整 parse 后只返回 enabled，旧 preload 仍能吃 `{ enabled }`，也能吃完整对象。 */
export function parseHostBrowserEnabledState(value: unknown): { enabled: boolean } | null {
  const parsed = parseHostBrowserSettings(value)
  return parsed ? { enabled: parsed.enabled } : null
}

/** 宿主浏览器 MCP 工具名。不在此表的一律拒绝，避免 evaluate / CDP 通用入口混进来。 */
export const HOST_BROWSER_ACTION_NAMES = [
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_tabs_list',
  'browser_tabs_select',
  'browser_tabs_close',
  'browser_tabs_open',
  'browser_snapshot',
  'browser_screenshot',
  'browser_click',
  'browser_click_xy',
  'browser_click_at',
  'browser_type',
  'browser_scroll'
] as const

export type HostBrowserActionName = (typeof HOST_BROWSER_ACTION_NAMES)[number]
export type HostBrowserScrollDirection = 'up' | 'down' | 'left' | 'right'

const HOST_BROWSER_MAX_REF_CHARS = 32
const HOST_BROWSER_MAX_TYPE_CHARS = 4096
const HOST_BROWSER_MAX_TAB_ID_CHARS = 32
const HOST_BROWSER_MAX_SCROLL_AMOUNT = 10_000

export type HostBrowserAction =
  | { name: 'browser_navigate'; url: string }
  | { name: 'browser_back' }
  | { name: 'browser_forward' }
  | { name: 'browser_reload' }
  | { name: 'browser_tabs_list' }
  | { name: 'browser_tabs_select'; tabId: string }
  | { name: 'browser_tabs_close'; tabId: string }
  | { name: 'browser_tabs_open'; url?: string }
  | { name: 'browser_snapshot' }
  | { name: 'browser_screenshot' }
  | { name: 'browser_click'; ref: string }
  | { name: 'browser_click_xy'; x: number; y: number }
  | { name: 'browser_type'; ref: string; text: string; submit?: boolean }
  | { name: 'browser_scroll'; direction: HostBrowserScrollDirection; amount?: number }

const HOST_BROWSER_ACTION_NAME_SET = new Set<string>(HOST_BROWSER_ACTION_NAMES)
const SCROLL_DIRECTIONS = new Set<HostBrowserScrollDirection>(['up', 'down', 'left', 'right'])

/**
 * MCP tools/call 进入主进程后必须再解析一遍。
 * 只读 name + arguments；javascript: / 未知工具名返回 null，由引擎区分错误码。
 */
export function parseHostBrowserAction(value: unknown): HostBrowserAction | null {
  if (!isPlainRecord(value) || typeof value.name !== 'string') return null
  if (!HOST_BROWSER_ACTION_NAME_SET.has(value.name)) return null
  const args = value.arguments === undefined ? {} : value.arguments
  if (!isPlainRecord(args)) return null
  const name = value.name as HostBrowserActionName
  switch (name) {
    case 'browser_navigate': {
      if (typeof args.url !== 'string') return null
      const url = parseHostBrowserNavigateUrl(args.url)
      return url ? { name, url } : null
    }
    case 'browser_back':
    case 'browser_forward':
    case 'browser_reload':
    case 'browser_tabs_list':
    case 'browser_snapshot':
    case 'browser_screenshot':
      return { name }
    case 'browser_tabs_select':
    case 'browser_tabs_close': {
      const tabId = readBoundedToken(args.tabId, HOST_BROWSER_MAX_TAB_ID_CHARS)
      return tabId ? { name, tabId } : null
    }
    case 'browser_tabs_open': {
      if (args.url === undefined) return { name }
      if (typeof args.url !== 'string') return null
      const url = parseHostBrowserNavigateUrl(args.url)
      return url ? { name, url } : null
    }
    case 'browser_click': {
      const ref = readBoundedToken(args.ref, HOST_BROWSER_MAX_REF_CHARS)
      return ref ? { name, ref } : null
    }
    case 'browser_click_xy':
    case 'browser_click_at': {
      // click_at 只是 Grok 常猜的别名；内部统一成 click_xy，避免两套坐标动作。
      const x = readViewportCss(args.x)
      const y = readViewportCss(args.y)
      return x !== null && y !== null ? { name: 'browser_click_xy', x, y } : null
    }
    case 'browser_type': {
      const ref = readBoundedToken(args.ref, HOST_BROWSER_MAX_REF_CHARS)
      if (!ref || typeof args.text !== 'string' || args.text.includes('\0')) return null
      if (args.text.length > HOST_BROWSER_MAX_TYPE_CHARS) return null
      if (args.submit !== undefined && args.submit !== true && args.submit !== false) return null
      return args.submit === true
        ? { name, ref, text: args.text, submit: true }
        : { name, ref, text: args.text }
    }
    case 'browser_scroll': {
      if (
        typeof args.direction !== 'string' ||
        !SCROLL_DIRECTIONS.has(args.direction as HostBrowserScrollDirection)
      ) {
        return null
      }
      if (args.amount === undefined) {
        return { name, direction: args.direction as HostBrowserScrollDirection }
      }
      if (typeof args.amount !== 'number' || !Number.isSafeInteger(args.amount)) return null
      if (args.amount < 1 || args.amount > HOST_BROWSER_MAX_SCROLL_AMOUNT) return null
      return { name, direction: args.direction as HostBrowserScrollDirection, amount: args.amount }
    }
  }
}

/**
 * 视口 CSS 像素。允许小数（getContentQuads / 截图像素估算），拒绝负数和异常大值。
 * 字符串数字只收有限值，避免模型把 "240px" 送进来。
 */
function readViewportCss(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > HOST_BROWSER_MAX_BOUND) return null
    return value
  }
  if (typeof value !== 'string' || value.includes('\0') || value.trim() === '') return null
  if (!/^\d+(\.\d+)?$/.test(value.trim())) return null
  const next = Number(value)
  if (!Number.isFinite(next) || next < 0 || next > HOST_BROWSER_MAX_BOUND) return null
  return next
}

function readBoundedToken(value: unknown, maxChars: number): string | null {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    value.length > maxChars
  ) {
    return null
  }
  return value
}
