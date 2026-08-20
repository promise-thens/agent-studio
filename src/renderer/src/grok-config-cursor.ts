/**
 * 轻量扫描光标所在的 [table] 与 key =，不必完整 TOML AST。
 * 用于设置页右侧字段说明，不把文件送出 Renderer。
 */
export function parseTomlCursor(
  text: string,
  cursorOffset: number
): { table: string; key?: string } {
  if (!text) return { table: '' }
  const offset = Math.max(0, Math.min(cursorOffset, text.length))
  const before = text.slice(0, offset)
  const lineStart = before.lastIndexOf('\n') + 1
  const lineEndIndex = text.indexOf('\n', offset)
  const currentLine = text.slice(lineStart, lineEndIndex === -1 ? text.length : lineEndIndex)

  let table = ''
  const headerPattern = /^\s*\[([^\]]+)]\s*(#.*)?$/
  const lines = before.split('\n')
  for (const line of lines) {
    const header = headerPattern.exec(line)
    if (header) table = header[1].trim()
  }

  const headerOnLine = headerPattern.exec(currentLine)
  if (headerOnLine) {
    return { table: headerOnLine[1].trim() }
  }

  const keyMatch = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(currentLine)
  if (keyMatch) {
    return table ? { table, key: keyMatch[1] } : { table: '', key: keyMatch[1] }
  }
  return { table }
}
