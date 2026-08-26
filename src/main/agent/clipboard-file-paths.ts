/** 解码 Finder XML plist 中最常见的实体；不把文本当 HTML 执行。 */
function decodeXmlText(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/**
 * 解析 macOS Finder 的 NSFilenamesPboardType。
 * 兼容 XML plist、JSON 数组、OpenStep 引号列表和普通换行/NUL 文本。
 */
export function parseClipboardFilePaths(value: string): string[] {
  if (!value.trim()) return []
  const xmlPaths = [...value.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) =>
    decodeXmlText(match[1] ?? '').trim()
  )
  if (xmlPaths.length > 0) return xmlPaths.filter(Boolean)

  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    }
  } catch {
    // Finder 常返回非 JSON plist，继续按安全文本格式解析。
  }

  const quotedPaths = [...value.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) =>
    (match[1] ?? '').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim()
  )
  if (quotedPaths.length > 0) return quotedPaths.filter(Boolean)

  return value
    .split(/[\0\r\n]+/)
    .map((item) => item.trim().replace(/^[(),]+|[(),]+$/g, '').trim())
    .filter(Boolean)
}
