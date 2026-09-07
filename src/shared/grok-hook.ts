/** 与插件库存同级：单文件 JSON 上限，防止把超大 hook 文件打进 IPC。 */
export const MAX_GROK_HOOK_JSON_BYTES = 64 * 1024

/** 列表最多 80 行，避免设置页被钩子清单撑爆。 */
export const MAX_GROK_HOOK_ROWS = 80

/** 事件名超过 128 字符直接跳过，不截断后混入列表。 */
export const MAX_GROK_HOOK_EVENT_NAME_LENGTH = 128

/** matcher 只作有限说明；超长或含绝对路径则丢弃，避免命令/路径漏出。 */
export const MAX_GROK_HOOK_MATCHER_LENGTH = 80

const MAX_HOOK_ID_LENGTH = 512
const MAX_WARNING_LENGTH = 256

export const GROK_HOOK_TARGET_KINDS = ['command', 'http', 'invalid'] as const
export type GrokHookTargetKind = (typeof GROK_HOOK_TARGET_KINDS)[number]

/**
 * Renderer 可展示的钩子摘要。
 * 故意不含 command / url / env / headers / cwd，避免密钥和绝对路径漏到 UI。
 */
export interface GrokHookSummary {
  id: string
  event: string
  enabled: boolean
  targetKind: GrokHookTargetKind
  warning?: string
  /** 仅 http 行：URL.origin，已剥 query / hash / userinfo。 */
  httpOrigin?: string
  matcher?: string
}

export function isGrokHookTargetKind(value: unknown): value is GrokHookTargetKind {
  return typeof value === 'string' && (GROK_HOOK_TARGET_KINDS as readonly string[]).includes(value)
}

/**
 * Preload / IPC 入口：只保留可展示字段。
 * command、url、env、headers、cwd 与未知键一律丢弃；含 query 的 origin 或绝对路径 id 整项剔除。
 */
export function parseGrokHookSummary(value: unknown): GrokHookSummary | null {
  if (!isPlainRecord(value)) return null
  if (!isSafeHookId(value.id)) return null
  if (!isGrokHookTargetKind(value.targetKind)) return null
  if (typeof value.enabled !== 'boolean') return null
  if (!isSafeEventName(value.event, value.targetKind)) return null
  if (value.targetKind === 'invalid' && value.enabled) return null
  if (value.targetKind !== 'invalid' && !value.enabled) return null

  const summary: GrokHookSummary = {
    id: value.id,
    event: value.event,
    enabled: value.enabled,
    targetKind: value.targetKind
  }

  if (value.targetKind === 'http') {
    const origin = parseHttpOrigin(value.httpOrigin)
    if (!origin) return null
    summary.httpOrigin = origin
  }

  if (value.targetKind === 'invalid') {
    const warning = parseWarning(value.warning)
    if (warning) summary.warning = warning
  }

  const matcher = parseSafeMatcher(value.matcher)
  if (matcher) summary.matcher = matcher
  return summary
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * id 只用 hooks 目录内的文件名（加事件与序号），禁止绝对路径和分隔符，
 * 避免 Renderer 拼出 grok-home 路径。
 */
function isSafeHookId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.length > MAX_HOOK_ID_LENGTH || value.includes('\0')) return false
  if (value.includes('/') || value.includes('\\')) return false
  if (value.includes('..')) return false
  if (/^[A-Za-z]:/.test(value)) return false
  return true
}

function isSafeEventName(value: unknown, targetKind: GrokHookTargetKind): value is string {
  if (typeof value !== 'string' || value.includes('\0')) return false
  if (value.includes('/') || value.includes('\\')) return false
  if (value.length > MAX_GROK_HOOK_EVENT_NAME_LENGTH) return false
  if (targetKind === 'invalid') return true
  return value.length > 0
}

/**
 * 只接受 http(s) 的 origin。带路径、query、hash 或 userinfo 的值一律拒绝，
 * 防止把完整 hook URL 当「origin」漏到 Renderer。
 */
function parseHttpOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.includes('\0')) return undefined
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (parsed.username || parsed.password) return undefined
  if (parsed.search || parsed.hash) return undefined
  if (parsed.origin !== value) return undefined
  return parsed.origin
}

function parseWarning(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_WARNING_LENGTH) return undefined
  if (trimmed.includes('\0') || trimmed.includes('/') || trimmed.includes('\\')) return undefined
  return trimmed
}

/**
 * matcher 只留短说明。绝对路径、NUL、超长直接丢弃，不截断，以免露出路径前缀。
 */
export function parseSafeMatcher(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text || text.includes('\0')) return undefined
  if (text.length > MAX_GROK_HOOK_MATCHER_LENGTH) return undefined
  if (/^(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/|\/tmp\/|\/var\/|\/)/i.test(text)) return undefined
  if (text.startsWith('\\')) return undefined
  return text
}
