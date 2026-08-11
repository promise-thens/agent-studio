import type {
  DesktopIpcError,
  DesktopIpcErrorCode,
  DesktopIpcResult
} from '../../shared/ipc-result'

const MAX_ERROR_MESSAGE_BYTES = 4 * 1024
const URL_PATTERN = /\b(?:https?|file):\/\/[^\s"'<>]+/giu
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\(?:[^\\\s"'<>]+\\)*[^\\\s"'<>]*/gu
const POSIX_PATH_PATTERN = /(^|[\s"'(])\/(?:[^/\s"'<>]+\/)*[^/\s"'<>]+/gu
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/gu

export interface TrustedRendererFrame {
  readonly url: string
  isDestroyed: () => boolean
  send: (channel: string, ...args: unknown[]) => void
}

export interface TrustedRendererWebContents {
  readonly mainFrame: TrustedRendererFrame
  isDestroyed: () => boolean
}

export interface TrustedRendererWindow {
  readonly webContents: TrustedRendererWebContents
  isDestroyed: () => boolean
}

export interface TrustedIpcInvokeEvent {
  readonly sender: TrustedRendererWebContents
  readonly senderFrame: TrustedRendererFrame | null
}

export interface RendererTrustOptions {
  getMainWindow: () => TrustedRendererWindow | null
  developmentUrl?: string
  productionFileUrl: string
}

/** 携带稳定错误码的主进程内部异常，跨 IPC 前必须转换为有限结果。 */
export class DesktopIpcFailure extends Error {
  readonly code: DesktopIpcErrorCode

  constructor(code: DesktopIpcErrorCode, message: string) {
    super(message)
    this.name = 'DesktopIpcFailure'
    this.code = code
  }
}

/** 按 UTF-8 字节安全截断文本，避免切坏中文或 emoji。 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text

  let result = ''
  let usedBytes = 0
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (usedBytes + characterBytes > maxBytes) break
    result += character
    usedBytes += characterBytes
  }
  return result
}

/**
 * 将未知异常压缩为 Renderer 可展示的有限错误。
 * 先调用上层提供的 Secret 脱敏器，再移除 URL、内部路径和控制字符。
 */
export function toDesktopIpcError(
  error: unknown,
  sanitizeError: (error: unknown) => string
): DesktopIpcError {
  if (error instanceof DesktopIpcFailure) {
    return {
      code: error.code,
      message: truncateUtf8(error.message, MAX_ERROR_MESSAGE_BYTES)
    }
  }

  const sanitized = sanitizeError(error)
    .replace(URL_PATTERN, '[REDACTED]')
    .replace(WINDOWS_PATH_PATTERN, '[REDACTED]')
    .replace(POSIX_PATH_PATTERN, '$1[REDACTED]')
    .replace(CONTROL_CHARACTER_PATTERN, ' ')
    .trim()

  return {
    code: 'operation-failed',
    message: truncateUtf8(sanitized || '操作失败，请重试。', MAX_ERROR_MESSAGE_BYTES)
  }
}

export function desktopIpcSuccess<T>(value: T): DesktopIpcResult<T> {
  return { ok: true, value }
}

export function desktopIpcFailure(
  error: unknown,
  sanitizeError: (error: unknown) => string
): DesktopIpcResult<never> {
  return { ok: false, error: toDesktopIpcError(error, sanitizeError) }
}

/** 统一捕获 Agent/App Handler 异常，避免 Electron rejection 泄漏原始信息。 */
export async function runDesktopIpcOperation<T>(
  operation: () => T | Promise<T>,
  sanitizeError: (error: unknown) => string
): Promise<DesktopIpcResult<T>> {
  try {
    return desktopIpcSuccess(await operation())
  } catch (error) {
    return desktopIpcFailure(error, sanitizeError)
  }
}

function isTrustedRendererUrl(actualUrl: string, options: RendererTrustOptions): boolean {
  try {
    const actual = new URL(actualUrl)
    if (options.developmentUrl) {
      return actual.origin === new URL(options.developmentUrl).origin
    }
    return actual.href === new URL(options.productionFileUrl).href
  } catch {
    return false
  }
}

/**
 * 验证 IPC 只来自当前主窗口的主 frame 和预期 Renderer 页面。
 * 该检查必须先于读取请求字段、访问配置、打开 Dialog 或调用 Runtime。
 */
export function assertTrustedIpcSender(
  event: TrustedIpcInvokeEvent,
  options: RendererTrustOptions
): void {
  const window = options.getMainWindow()
  if (!window || window.isDestroyed()) {
    throw new DesktopIpcFailure('forbidden', '拒绝此 IPC 调用。')
  }

  const webContents = window.webContents
  const mainFrame = webContents.mainFrame
  if (
    webContents.isDestroyed() ||
    mainFrame.isDestroyed() ||
    event.sender !== webContents ||
    !event.senderFrame ||
    event.senderFrame !== mainFrame ||
    !isTrustedRendererUrl(mainFrame.url, options)
  ) {
    throw new DesktopIpcFailure('forbidden', '拒绝此 IPC 调用。')
  }
}

/**
 * 只向仍可信的主窗口 main frame 推送业务事件。
 * 窗口销毁、页面导航或发送竞态均安全丢弃，不缓存旧 frame。
 */
export function sendToTrustedRenderer(
  options: RendererTrustOptions,
  channel: string,
  payload: unknown
): boolean {
  const window = options.getMainWindow()
  if (!window || window.isDestroyed()) return false

  const webContents = window.webContents
  const mainFrame = webContents.mainFrame
  if (
    webContents.isDestroyed() ||
    mainFrame.isDestroyed() ||
    !isTrustedRendererUrl(mainFrame.url, options)
  ) {
    return false
  }

  try {
    mainFrame.send(channel, payload)
    return true
  } catch {
    return false
  }
}
