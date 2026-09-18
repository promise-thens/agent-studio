import * as z from 'zod'
import { parseBrowserOrigin } from './browser-origin'
import { parseHostBrowserNavigateUrl } from './host-browser'

/** Chrome Native Messaging 清单 name，与磁盘 json 文件名一致。 */
export const CHROME_NATIVE_HOST_NAME = 'com.agentstudio.browser'
/**
 * 配套扩展公钥（SPKI DER 的 base64）。
 * 扩展 id 必须由它算出；禁止改成接受任意 origin 的 host。
 */
export const CHROME_EXTENSION_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArq8XK8y05uUpU7OVi8av+NfertrV1Y+UHzCFQ99C007Sg3w+qh2Eu/qb1Y0uJf2ewxOfkaoRnJn2wZBo6kjmrIOLk/I5ThBsZ7+OlIEPzo8Qab4ApXf2KsRt9C+S2IGUdBlnwPEra3TGys/JK11kbcfDyssqg6mhR5KsMeYnOL9yw/h3G+efe6t/FqRj8xuOdYy41oxyAkjwDGzLW1hQ+neiG4mlMFUcmrbAUZ/c9zLOpD3eISHVs0fncaayV09KQxM9b1xZXEcFslP79jGwTm7YhkupFaWdpKo518KEr6wWcUF3twkW9r4xEJ1laixmhIYS9ypAkRW08wyqiWACnwIDAQAB'
/** 由 CHROME_EXTENSION_PUBLIC_KEY 算出的固定 unpacked / 签名 id。 */
export const CHROME_EXTENSION_ID = 'odcgomechdmpbooelpdakcenicncehko'

export const CHROME_NATIVE_MAX_FRAME_BYTES = 1_048_576
export const CHROME_NATIVE_MAX_ID_CHARS = 128
export const CHROME_NATIVE_MAX_COMMAND_CHARS = 128
export const CHROME_NATIVE_MAX_COOKIES = 500
export const CHROME_NATIVE_MAX_COOKIE_VALUE_CHARS = 4096

export const CHROME_NATIVE_COMMANDS = [
  'ping',
  'cookies.sync',
  'tabs.snapshot',
  'tabs.open'
] as const
export type ChromeNativeCommand = (typeof CHROME_NATIVE_COMMANDS)[number]

export interface ChromeNativeRequest {
  id: string
  command: ChromeNativeCommand
  payload?: unknown
}

export interface ChromeNativeCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  expirationDate?: number
  sameSite?: 'no_restriction' | 'lax' | 'strict'
}

export interface ChromeNativeError {
  code: string
  message: string
}

export interface ChromeNativeResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: ChromeNativeError
}

export type ChromeNativeParseResult =
  | { ok: true; request: ChromeNativeRequest }
  | { ok: false; id: string | null; error: ChromeNativeError }

export type ChromeNativeFrameLengthResult =
  { ok: true; length: number } | { ok: false; code: 'incomplete' | 'frame-too-large' }

const COMMAND_SET = new Set<string>(CHROME_NATIVE_COMMANDS)

const envelopeSchema = z.object({
  id: z.string().min(1).max(CHROME_NATIVE_MAX_ID_CHARS),
  command: z.string().min(1).max(CHROME_NATIVE_MAX_COMMAND_CHARS),
  payload: z.unknown().optional()
})

const cookieSchema = z.object({
  name: z.string().min(1).max(256),
  value: z.string().max(CHROME_NATIVE_MAX_COOKIE_VALUE_CHARS),
  domain: z.string().min(1).max(253),
  path: z.string().min(1).max(1024),
  secure: z.boolean(),
  httpOnly: z.boolean(),
  expirationDate: z.number().finite().optional(),
  sameSite: z.enum(['no_restriction', 'lax', 'strict']).optional()
})

const cookiesSyncPayloadSchema = z.object({
  cookies: z.array(cookieSchema).max(CHROME_NATIVE_MAX_COOKIES)
})

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isChromeNativeCommand(command: string): command is ChromeNativeCommand {
  return COMMAND_SET.has(command)
}

/**
 * Native Messaging 单帧 4 字节小端长度。超过 1MiB 直接拒绝，避免把 stdin 当无限缓冲。
 */
export function parseChromeNativeFrameLength(header: Uint8Array): ChromeNativeFrameLengthResult {
  if (header.byteLength < 4) return { ok: false, code: 'incomplete' }
  const length =
    (header[0] ?? 0) +
    (header[1] ?? 0) * 256 +
    (header[2] ?? 0) * 65536 +
    (header[3] ?? 0) * 16777216
  if (length > CHROME_NATIVE_MAX_FRAME_BYTES) return { ok: false, code: 'frame-too-large' }
  return { ok: true, length }
}

/**
 * Zod 解析信封。未知 command 只回错误对象，payload 丢掉，避免被当成 shell。
 */
export function parseChromeNativeRequest(value: unknown): ChromeNativeParseResult {
  const parsed = envelopeSchema.safeParse(value)
  if (!parsed.success) {
    const id =
      isPlainRecord(value) &&
      typeof value.id === 'string' &&
      value.id.length > 0 &&
      value.id.length <= CHROME_NATIVE_MAX_ID_CHARS
        ? value.id
        : null
    return {
      ok: false,
      id,
      error: { code: 'invalid-request', message: 'Native Host 请求无效。' }
    }
  }
  if (!isChromeNativeCommand(parsed.data.command)) {
    return {
      ok: false,
      id: parsed.data.id,
      error: { code: 'unknown-command', message: '不支持该命令。' }
    }
  }
  const request: ChromeNativeRequest = {
    id: parsed.data.id,
    command: parsed.data.command
  }
  if (parsed.data.payload !== undefined) request.payload = parsed.data.payload
  return { ok: true, request }
}

/** cookies.sync 载荷：数组上限 500，单 value 上限 4096。失败整包丢掉，不做半份写入。 */
export function parseChromeNativeCookiesSyncPayload(
  payload: unknown
): { cookies: ChromeNativeCookie[] } | null {
  const parsed = cookiesSyncPayloadSchema.safeParse(payload)
  if (!parsed.success) return null
  return { cookies: parsed.data.cookies }
}

/** tabs.open 只收 http(s)，禁止 file / javascript 经 Native Host 开页。 */
export function parseChromeNativeTabsOpenUrl(payload: unknown): string | null {
  if (!isPlainRecord(payload) || typeof payload.url !== 'string') return null
  return parseHostBrowserNavigateUrl(payload.url)
}

export interface ChromeNativeScreenBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ChromeNativeSnapshotNode {
  x: number
  y: number
  width?: number
  height?: number
}

/** 扩展上报的窗 DIP 与 viewport CSS 盒；缺字段表示没有几何，主进程不得发明光标。 */
export interface ChromeNativeTabsSnapshotPayload {
  windowScreenBounds?: ChromeNativeScreenBounds
  dpr?: number
  zoom?: number
  nodes?: ChromeNativeSnapshotNode[]
}

const screenBoundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite()
})

const snapshotNodeSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().optional(),
  height: z.number().finite().optional()
})

const tabsSnapshotPayloadSchema = z.object({
  windowScreenBounds: screenBoundsSchema.optional(),
  dpr: z.number().finite().optional(),
  zoom: z.number().finite().optional(),
  nodes: z.array(snapshotNodeSchema).max(500).optional()
})

/** tabs.snapshot 只收有限数字几何。非法整包丢掉，避免半份坐标画出飞针。 */
export function parseChromeNativeTabsSnapshotPayload(
  payload: unknown
): ChromeNativeTabsSnapshotPayload | null {
  if (payload === undefined) return {}
  const parsed = tabsSnapshotPayloadSchema.safeParse(payload)
  if (!parsed.success) return null
  const result: ChromeNativeTabsSnapshotPayload = {}
  if (parsed.data.windowScreenBounds) result.windowScreenBounds = parsed.data.windowScreenBounds
  if (parsed.data.dpr !== undefined) result.dpr = parsed.data.dpr
  if (parsed.data.zoom !== undefined) result.zoom = parsed.data.zoom
  if (parsed.data.nodes) result.nodes = parsed.data.nodes
  return result
}

function isLegalCookieHost(host: string): boolean {
  if (!host || host.length > 253) return false
  if (host.includes(':') || host.includes('/') || host.includes('\\') || host.includes('\0')) {
    return false
  }
  if (host.startsWith('.') || host.endsWith('.')) return false
  if (host === 'localhost') return true
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((part) => {
      const value = Number(part)
      return Number.isInteger(value) && value >= 0 && value <= 255
    })
  }
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(
    host
  )
}

/**
 * 由 domain+path+secure 合成 cookies.set 所需 url。
 * 非法 domain 返回 null，调用方跳过该条，不得猜测成 Profile 路径。
 */
export function synthesizeChromeNativeCookieUrl(cookie: ChromeNativeCookie): string | null {
  const host = cookie.domain.replace(/^\./, '').toLowerCase()
  if (!isLegalCookieHost(host)) return null
  if (!cookie.path.startsWith('/') || cookie.path.includes('?') || cookie.path.includes('#')) {
    return null
  }
  if (cookie.path.includes('\\') || cookie.path.includes('\0')) return null
  const protocol = cookie.secure ? 'https:' : 'http:'
  try {
    const url = new URL(`${protocol}//${host}${cookie.path}`)
    if (url.hostname !== host) return null
    if (!parseBrowserOrigin(url.href)) return null
    return url.href
  } catch {
    return null
  }
}

/**
 * 黑名单是 origin。domain cookie（前导点）会命中其子域，避免 mail 登录态写进内置页。
 */
export function cookieMatchesBlacklist(
  cookie: ChromeNativeCookie,
  blacklist: readonly string[]
): boolean {
  const cookieHost = cookie.domain.replace(/^\./, '').toLowerCase()
  if (!cookieHost) return true
  const domainCookie = cookie.domain.startsWith('.')
  for (const origin of blacklist) {
    let host: string
    try {
      const parsed = new URL(origin)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
      host = parsed.hostname.toLowerCase()
    } catch {
      continue
    }
    if (host === cookieHost) return true
    if (domainCookie && (host === cookieHost || host.endsWith(`.${cookieHost}`))) return true
  }
  return false
}

/**
 * 日志只记 command / count / origin。禁止把 cookie value 放进结构，调用方 JSON.stringify 才安全。
 */
export function createChromeNativeLogRecord(input: {
  command: string
  cookieCount?: number
  origins?: string[]
  applied?: number
  skipped?: number
  ignored?: boolean
}): Record<string, unknown> {
  const record: Record<string, unknown> = { command: input.command }
  if (typeof input.cookieCount === 'number') record.cookieCount = input.cookieCount
  if (input.origins) record.origins = [...input.origins]
  if (typeof input.applied === 'number') record.applied = input.applied
  if (typeof input.skipped === 'number') record.skipped = input.skipped
  if (input.ignored === true) record.ignored = true
  return record
}

export function chromeExtensionAllowedOrigin(): string {
  return `chrome-extension://${CHROME_EXTENSION_ID}/`
}
