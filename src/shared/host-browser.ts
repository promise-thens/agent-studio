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
