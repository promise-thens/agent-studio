import type { AgentToolStatus } from '../../shared/agent'

/** 无动词的长标题超过这个长度才考虑折叠，避免短写入标题被收成「工具」。 */
const RAW_DUMP_MIN_CHARS = 24
/** 不含命令/正则痕迹时，只有极长标题才折叠。 */
const RAW_DUMP_ALWAYS_CHARS = 80
/** 搜索模式如果超过此长度，则标题做截断展示，完整搜索表达式收进 detail。 */
const MAX_SEARCH_LABEL_PATTERN_CHARS = 36

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

/**
 * 宿主与通用浏览器操作动作的中文人话化映射表。
 * 覆盖常用点击、截图、页面快照、网页打开、表单输入与滚动。
 */
const BROWSER_ACTION_LABELS: Record<string, string> = {
  click: '点击页面',
  click_xy: '点击页面',
  click_at: '点击页面',
  snapshot: '页面快照',
  screenshot: '页面截图',
  take_screenshot: '页面截图',
  navigate: '打开网页',
  tabs_open: '打开网页',
  open: '打开网页',
  type: '输入文本',
  fill: '输入文本',
  input: '输入文本',
  scroll: '滚动页面',
  scroll_down: '滚动页面',
  scroll_up: '滚动页面',
  select: '选择选项',
  hover: '悬停元素',
  wait: '等待页面',
  close: '关闭页面',
  reload: '刷新页面',
  refresh: '刷新页面'
}

/**
 * 通用 MCP 服务高频标准方法的中文人话化映射表。
 */
const COMMON_MCP_METHOD_LABELS: Record<string, string> = {
  // 文件系统类操作
  read_file: '读取文件',
  readfile: '读取文件',
  write_file: '写入文件',
  writefile: '写入文件',
  create_file: '创建文件',
  delete_file: '删除文件',
  remove_file: '删除文件',
  list_directory: '列出目录',
  list_dir: '列出目录',
  list_files: '列出文件',
  // 搜索与检索类操作
  search: '搜索',
  search_code: '搜索代码',
  find_files: '查找文件',
  grep: '搜索',
  query: '数据查询',
  execute_query: '执行查询',
  // 网络接口类操作
  fetch: '网络请求',
  http_request: '网络请求',
  // 基础命令与协作类操作
  run_command: '跑了命令',
  execute_command: '跑了命令',
  create_issue: '创建 Issue',
  send_message: '发送消息'
}

export interface ToolRowPresentation {
  label: string
  detail?: string
}

export interface ToolRowChrome {
  busy: boolean
  isBackground: boolean
  statusLabel: string
  /** 折叠态可见徽章：有后台时「后台」在状态前；取消后不得再显示「进行中」。 */
  visibleLabels: readonly string[]
}

/**
 * 折叠 ToolRow 的后台徽章与状态文案。
 * 只认 execution=background，禁止用 in_progress 猜后台；取消后「后台」可保留。
 */
export function resolveToolRowChrome(input: {
  status: AgentToolStatus | 'unknown'
  execution?: 'background'
}): ToolRowChrome {
  const busy = input.status === 'in_progress' || input.status === 'pending'
  const isBackground = input.execution === 'background'
  const statusLabel = resolveToolRowStatusLabel(input.status)
  return {
    busy,
    isBackground,
    statusLabel,
    visibleLabels: isBackground ? ['后台', statusLabel] : [statusLabel]
  }
}

function resolveToolRowStatusLabel(status: AgentToolStatus | 'unknown'): string {
  switch (status) {
    case 'pending':
      return '等待中'
    case 'in_progress':
      return '进行中'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    default:
      return '状态未知'
  }
}

/**
 * 把 Grok ACP 塞进 title 的原始机器名称、长命令或搜索模式收成人话短标签。
 * 详情只给 UI 折叠，不进 Markdown，也不改 Timeline 原始 title。
 */
export function presentToolTitle(title: string): ToolRowPresentation {
  const trimmed = title.trim()
  if (!trimmed) return { label: '' }

  // 1. 已知基础前缀动词（List / Execute / grep 等）
  const known = matchKnownVerb(trimmed)
  if (known) {
    const payload = unwrapToolPayload(known.rest)
    return payload ? { label: known.label, detail: payload } : { label: known.label }
  }

  // 2. 文件读取类标题
  if (isReadToolTitle(trimmed)) {
    const target = unwrapToolPayload(trimmed.replace(READ_TITLE_RE, '').trim())
    return { label: target ? `读了 ${target}` : '读了文件' }
  }

  // 3. 浏览器操作工具（识别 agent-studio-browser__*、browser__*、截断 browser__、browser_*）
  const browserPresentation = presentBrowserTool(trimmed)
  if (browserPresentation) {
    return browserPresentation
  }

  // 4. 通用 MCP 工具（识别 server__method 格式，去掉服务名前缀或转为清晰中文动作）
  const mcpPresentation = presentGenericMcpTool(trimmed)
  if (mcpPresentation) {
    return mcpPresentation
  }

  // 5. 纯正则或多关键字搜索（识别类似 foo|bar|baz、资质|attachment|附件）
  const searchPresentation = presentKeywordSearchPattern(trimmed)
  if (searchPresentation) {
    return searchPresentation
  }

  // 6. 无法人话化但包含命令符号或极长的原始内容折叠为「工具」
  if (shouldCollapseRawTitle(trimmed)) {
    return { label: '工具', detail: trimmed }
  }

  // 7. 短文本原样展示
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

/**
 * 匹配已知动词前缀。
 */
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

/**
 * 将浏览器相关操作（如点击、快照、截图、导航、输入等）转换为亲切的中文动作。
 * 兼容 agent-studio-browser__*、browser__*、截断的 browser__ 和独立的 browser_*。
 */
function presentBrowserTool(title: string): ToolRowPresentation | null {
  // 匹配带 agent-studio-browser__ 或 browser__ 前缀的 MCP 调用
  const mcpPrefixMatch = title.match(/^(?:agent-studio-browser__|browser__)(.*)$/i)
  if (mcpPrefixMatch) {
    const remainder = mcpPrefixMatch[1].trim()
    if (!remainder) {
      // 截断的前缀：如只有「browser__」或「agent-studio-browser__」
      return { label: '浏览器操作' }
    }
    const spaceIndex = remainder.search(/[\s:：]/)
    const rawAction = spaceIndex === -1 ? remainder : remainder.slice(0, spaceIndex)
    const rawArgs = spaceIndex === -1 ? '' : remainder.slice(spaceIndex).trim()
    const cleanAction = rawAction.toLowerCase().replace(/^browser_/, '')
    const label = BROWSER_ACTION_LABELS[cleanAction] || '浏览器操作'
    const detail = unwrapToolPayload(rawArgs)
    return detail ? { label, detail } : { label }
  }

  // 匹配独立的 browser_* 动作命令
  const standaloneMatch = title.match(/^(browser_[a-zA-Z0-9_-]+)(?:[:：\s]+([\s\S]*))?$/i)
  if (standaloneMatch) {
    const rawAction = standaloneMatch[1]
    const rawArgs = (standaloneMatch[2] || '').trim()
    const cleanAction = rawAction.toLowerCase().replace(/^browser_/, '')
    const label = BROWSER_ACTION_LABELS[cleanAction] || '浏览器操作'
    const detail = unwrapToolPayload(rawArgs)
    return detail ? { label, detail } : { label }
  }

  return null
}

/**
 * 尝试将类似 server__method 的通用 MCP 工具名称去前缀并人话化。
 */
function presentGenericMcpTool(title: string): ToolRowPresentation | null {
  const mcpMatch = title.match(/^([a-zA-Z0-9_-]+)__([a-zA-Z0-9_-]*)(?:[:：\s]+([\s\S]*))?$/)
  if (!mcpMatch) return null

  const server = mcpMatch[1]
  const method = mcpMatch[2]
  const rawArgs = (mcpMatch[3] || '').trim()

  // 截断的服务名前缀：例如 "custom_server__"
  if (!method) {
    const label = `${server} 工具`
    const detail = unwrapToolPayload(rawArgs)
    return detail ? { label, detail } : { label }
  }

  const cleanMethod = method.toLowerCase()
  const label = COMMON_MCP_METHOD_LABELS[cleanMethod] || method
  const detail = unwrapToolPayload(rawArgs)
  return detail ? { label, detail } : { label }
}

/**
 * 识别类似 foo|bar|baz 或 资质|attachment|附件 的纯多关键字/正则搜索模式。
 * 将其标注为「搜索 "xxx"」，避免直接裸奔或被硬生生收成「工具」。
 */
function presentKeywordSearchPattern(title: string): ToolRowPresentation | null {
  if (!title.includes('|')) return null
  if (title.includes('\n')) return null
  // 排除 shell 重定向、分号、后台操作符与 HTML 标签，保证复杂命令和已有标签测试用例不受干扰
  if (/[<>;`&$]/.test(title)) return null
  if (title.includes('&&') || title.includes('||')) return null

  const segments = title.split('|')
  if (segments.length < 2) return null

  for (const seg of segments) {
    const trimmedSeg = seg.trim()
    if (!trimmedSeg || trimmedSeg.length > 50) return null
  }

  if (title.length > MAX_SEARCH_LABEL_PATTERN_CHARS) {
    return {
      label: `搜索 "${title.slice(0, MAX_SEARCH_LABEL_PATTERN_CHARS)}..."`,
      detail: title
    }
  }

  return { label: `搜索 "${title}"` }
}

/** 只剥最外层一对反引号；命令内部的反引号原样保留。 */
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
