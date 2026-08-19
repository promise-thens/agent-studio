/**
 * 只允许对话与窗口打开走 http/https，拒绝带账号密码或非网络协议的地址。
 * Renderer 和主进程共用，避免一边放行、一边误开。
 */
export function sanitizeExternalHref(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}
