import { sanitizeExternalHref } from '../../shared/external-href'

export type MarkdownInline =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: MarkdownInline[] }
  | { type: 'code'; value: string }
  | { type: 'link'; href: string; children: MarkdownInline[] }

export type MarkdownBlock =
  | { type: 'paragraph'; children: MarkdownInline[] }
  | { type: 'heading'; level: 1 | 2 | 3; children: MarkdownInline[] }
  | { type: 'list'; ordered: boolean; items: MarkdownInline[][] }
  | { type: 'code'; language: string | null; value: string }
  | { type: 'table'; header: MarkdownInline[][]; rows: MarkdownInline[][][] }

interface FenceMatch {
  markerLength: number
  language: string | null
}

/**
 * 把助手回复收成安全 AST：只保留标题、列表、代码、表格和有限行内标记。
 * 不产出 HTML，原始标签与危险链接降级为文本，图片只保留 alt。
 */
export function parseAssistantMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') {
      index += 1
      continue
    }

    const fence = matchFence(line)
    if (fence) {
      const collected = collectFence(lines, index, fence)
      blocks.push({ type: 'code', language: fence.language, value: collected.value })
      index = collected.nextIndex
      continue
    }

    if (isTableStart(lines, index)) {
      const collected = collectTable(lines, index)
      blocks.push(collected.block)
      index = collected.nextIndex
      continue
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3
      blocks.push({
        type: 'heading',
        level,
        children: parseInline(heading[2].trim())
      })
      index += 1
      continue
    }

    if (/^[-*+]\s+\S/.test(line)) {
      const collected = collectList(lines, index, false)
      blocks.push({ type: 'list', ordered: false, items: collected.items })
      index = collected.nextIndex
      continue
    }

    if (/^\d{1,3}\.\s+\S/.test(line)) {
      const collected = collectList(lines, index, true)
      blocks.push({ type: 'list', ordered: true, items: collected.items })
      index = collected.nextIndex
      continue
    }

    const paragraphLines = [line]
    index += 1
    while (index < lines.length && lines[index].trim() !== '' && !isBlockStart(lines, index)) {
      paragraphLines.push(lines[index])
      index += 1
    }
    blocks.push({
      type: 'paragraph',
      children: parseInline(paragraphLines.join('\n'))
    })
  }

  return blocks
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index]
  return (
    matchFence(line) !== null ||
    isTableStart(lines, index) ||
    /^(#{1,3})\s+\S/.test(line) ||
    /^[-*+]\s+\S/.test(line) ||
    /^\d{1,3}\.\s+\S/.test(line)
  )
}

function matchFence(line: string): FenceMatch | null {
  const match = line.match(/^(`{3,})([^`\s]*)\s*$/)
  if (!match) return null
  return {
    markerLength: match[1].length,
    language: match[2] || null
  }
}

function collectFence(
  lines: string[],
  startIndex: number,
  fence: FenceMatch
): { value: string; nextIndex: number } {
  const body: string[] = []
  let index = startIndex + 1
  while (index < lines.length) {
    const closing = lines[index].match(/^(`{3,})\s*$/)
    if (closing && closing[1].length >= fence.markerLength) {
      return { value: body.join('\n'), nextIndex: index + 1 }
    }
    body.push(lines[index])
    index += 1
  }
  return { value: body.join('\n'), nextIndex: index }
}

function collectList(
  lines: string[],
  startIndex: number,
  ordered: boolean
): { items: MarkdownInline[][]; nextIndex: number } {
  const pattern = ordered ? /^\d{1,3}\.\s+(.+)$/ : /^[-*+]\s+(.+)$/
  const items: MarkdownInline[][] = []
  let index = startIndex
  while (index < lines.length) {
    const match = lines[index].match(pattern)
    if (!match) break
    items.push(parseInline(match[1]))
    index += 1
  }
  return { items, nextIndex: index }
}

function isTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false
  const header = splitTableCells(lines[index])
  const separator = splitTableCells(lines[index + 1])
  return (
    header.length > 0 && separator.length > 0 && separator.every((cell) => /^:?-{3,}:?$/.test(cell))
  )
}

function collectTable(
  lines: string[],
  startIndex: number
): { block: Extract<MarkdownBlock, { type: 'table' }>; nextIndex: number } {
  const header = splitTableCells(lines[startIndex]).map(parseInline)
  const rows: MarkdownInline[][][] = []
  let index = startIndex + 2
  while (index < lines.length && lines[index].trim() !== '' && lines[index].includes('|')) {
    rows.push(splitTableCells(lines[index]).map(parseInline))
    index += 1
  }
  return {
    block: { type: 'table', header, rows },
    nextIndex: index
  }
}

/** 按单元格拆表格行，反引号内的竖线不算分隔符。 */
function splitTableCells(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return []
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  let inCode = false
  for (const character of inner) {
    if (character === '`') {
      inCode = !inCode
      current += character
      continue
    }
    if (character === '|' && !inCode) {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  cells.push(current.trim())
  return cells
}

function parseInline(source: string): MarkdownInline[] {
  const nodes: MarkdownInline[] = []
  let index = 0
  let text = ''

  const flushText = (): void => {
    if (!text) return
    nodes.push({ type: 'text', value: text })
    text = ''
  }

  while (index < source.length) {
    if (source.startsWith('![', index)) {
      const image = parseLinkTarget(source, index + 1)
      if (image) {
        flushText()
        if (image.label) nodes.push({ type: 'text', value: image.label })
        index = image.endIndex
        continue
      }
    }

    if (source[index] === '[') {
      const link = parseLinkTarget(source, index)
      if (link) {
        flushText()
        const href = sanitizeExternalHref(link.href)
        const children = parseInline(link.label)
        if (href) nodes.push({ type: 'link', href, children })
        else nodes.push(...children)
        index = link.endIndex
        continue
      }
    }

    if (source[index] === '`') {
      const closeIndex = source.indexOf('`', index + 1)
      if (closeIndex >= 0) {
        flushText()
        nodes.push({ type: 'code', value: source.slice(index + 1, closeIndex) })
        index = closeIndex + 1
        continue
      }
    }

    if (source.startsWith('**', index)) {
      const closeIndex = source.indexOf('**', index + 2)
      if (closeIndex >= 0) {
        flushText()
        nodes.push({
          type: 'strong',
          children: parseInline(source.slice(index + 2, closeIndex))
        })
        index = closeIndex + 2
        continue
      }
    }

    text += source[index]
    index += 1
  }

  flushText()
  return nodes
}

function parseLinkTarget(
  source: string,
  startIndex: number
): { label: string; href: string; endIndex: number } | null {
  if (source[startIndex] !== '[') return null
  const labelEnd = source.indexOf('](', startIndex + 1)
  if (labelEnd < 0) return null
  const hrefStart = labelEnd + 2
  let depth = 1
  let hrefEnd = -1
  for (let index = hrefStart; index < source.length; index += 1) {
    const character = source[index]
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (depth === 0) {
      hrefEnd = index
      break
    }
  }
  if (hrefEnd < 0) return null
  return {
    label: source.slice(startIndex + 1, labelEnd),
    href: source.slice(hrefStart, hrefEnd).trim(),
    endIndex: hrefEnd + 1
  }
}
