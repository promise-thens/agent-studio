/**
 * 浏览器授权只绑 origin，避免把完整 URL、账号或 query 里的 Secret 写进 grant。
 * 只接受 http(s)；剥路径/query/hash；userinfo 或解析失败返回 null。
 */
export function parseBrowserOrigin(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed || trimmed.includes('\0')) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  return parsed.origin
}
