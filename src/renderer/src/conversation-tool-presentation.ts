/** 无动词的长标题超过这个长度才考虑折叠，避免短写入标题被收成「工具」。 */
const RAW_DUMP_MIN_CHARS = 24
/** 不含命令/正则痕迹时，只有极长标题才折叠。 */
const RAW_DUMP_ALWAYS_CHARS = 80

const READ_TITLE_RE = /^(?:读取|读了|读文件[:：]?\s*|Reading\s+|Read\s+|read\s+)/i

type KnownToolKind = 'list' | 'execute' | 'search'

const KNOWN_VERBS: readonly { kind: KnownToolKind; pattern: RegExp; label: string }[] = [
  // 中文后面不能用 \b：汉字不是 JS word char，会导致「列出」「执行」匹配失败。
  { kind: 'list', pattern: /^(?:list\b|列出目录|列目录|列出)[:：]?\s*/i, label: '列目录' },
  {
    kind: 'execute',
    pattern: /^(?:execute\b|bash\b|shell\b|执行命令|执行)[:：]?\s*/i,
    label: '跑了命令'
  },
  { kind: 'search', pattern: /^(?:grep\b|search\b|搜索)[:：]?\s*/i, label: '搜索' }
]

export interface ToolRowPresentation {
  label: string
  detail?: string
}

/**
 * 把 Grok ACP 塞进 title 的整段命令收成短标签。
 * 详情只给 UI 折叠，不进 Markdown，也不改 Timeline 原始 title。
 */
export function presentToolTitle(title: string): ToolRowPresentation {
  const trimmed = title.trim()
  if (!trimmed) return { label: '' }

  const known = matchKnownVerb(trimmed)
  if (known) {
    const payload = unwrapToolPayload(known.rest)
    return payload ? { label: known.label, detail: payload } : { label: known.label }
  }

  if (isReadToolTitle(trimmed)) {
    const target = unwrapToolPayload(trimmed.replace(READ_TITLE_RE, '').trim())
    return { label: target ? `读了 ${target}` : '读了文件' }
  }

  if (shouldCollapseRawTitle(trimmed)) {
    return { label: '工具', detail: trimmed }
  }

  return { label: trimmed }
}

/** 连续同类读取才合并；List/Execute 不得走这条。 */
export function isReadToolTitle(title: string): boolean {
  return READ_TITLE_RE.test(title.trim())
}

/** 主列短标签；长命令走 presentToolTitle.detail，不把整段 bash 摊开。 */
export function formatToolVerbPhrase(title: string): string {
  return presentToolTitle(title).label
}

function matchKnownVerb(
  title: string
): { kind: KnownToolKind; label: string; rest: string } | null {
  for (const spec of KNOWN_VERBS) {
    const match = title.match(spec.pattern)
    if (!match) continue
    return { kind: spec.kind, label: spec.label, rest: title.slice(match[0].length) }
  }
  return null
}

/** 只剥最外层一对反引号；命令内部的 ` 原样保留。 */
function unwrapToolPayload(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('`')) return trimmed
  const inner = trimmed.slice(1)
  return inner.endsWith('`') ? inner.slice(0, -1) : inner
}

function shouldCollapseRawTitle(title: string): boolean {
  if (title.includes('\n')) return true
  if (title.length <= RAW_DUMP_MIN_CHARS) return false
  if (/[|&;`<>]/.test(title) || title.includes('&&')) return true
  return title.length > RAW_DUMP_ALWAYS_CHARS
}
