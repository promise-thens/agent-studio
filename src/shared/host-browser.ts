import { parseBrowserOrigin } from './browser-origin'

/** 地址栏与 IPC 共用的 URL 上限，避免把整页 data URL 送进主进程。 */
export const HOST_BROWSER_MAX_URL_CHARS = 2048
/** 标题只用于 chrome 展示，截断后不得把页面全文带回 Renderer。 */
export const HOST_BROWSER_MAX_TITLE_CHARS = 512
/** Bounds 以 CSS 像素计；超出这个范围视为测量错误而不是超大窗口。 */
export const HOST_BROWSER_MAX_BOUND = 1_000_000

export interface HostBrowserChrome {
  url: string
  title: string
  isLoading: boolean
  open: boolean
}

export interface HostBrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

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
  return {
    url,
    title,
    isLoading: value.isLoading,
    open: value.open
  }
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
