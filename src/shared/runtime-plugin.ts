/** 插件安装作用域。P0-10C 第一波只扫描 App grok-home/plugins，对应 user。 */
export const RUNTIME_PLUGIN_SCOPES = ['user', 'project', 'path'] as const
export type RuntimePluginScope = (typeof RUNTIME_PLUGIN_SCOPES)[number]

export const RUNTIME_PLUGIN_STATUSES = ['enabled', 'disabled', 'invalid'] as const
export type RuntimePluginStatus = (typeof RUNTIME_PLUGIN_STATUSES)[number]

/** 受管 grok-home/plugins 的固定作用域；不扫描项目目录或用户 ~/.grok。 */
export const MANAGED_GROK_PLUGIN_SCOPE: RuntimePluginScope = 'user'

/** 单类名称最多保留 80 项，防止 IPC 与 UI 被清单撑爆。 */
export const MAX_RUNTIME_PLUGIN_NAMES = 80

/** 单名超过 128 字符直接跳过，不截断后混入列表。 */
export const MAX_RUNTIME_PLUGIN_NAME_LENGTH = 128

/** 列表说明只留短句，避免把 SKILL.md 全文打进 IPC。 */
export const MAX_RUNTIME_PLUGIN_DESCRIPTION_LENGTH = 160

const MAX_PLUGIN_ID_LENGTH = 4 * 1024
const MAX_DISPLAY_NAME_LENGTH = 256
const MAX_VERSION_LENGTH = 64
const MAX_INVALID_REASON_LENGTH = 256

export interface RuntimePluginSummary {
  pluginId: string
  displayName: string
  status: RuntimePluginStatus
  scope: RuntimePluginScope
  skillCount: number
  mcpCount: number
  hookCount: number
  version?: string
  description?: string
}

export interface RuntimePluginDetail extends RuntimePluginSummary {
  skillNames: string[]
  mcpNames: string[]
  hookNames: string[]
  /** 只收录 skillNames 里出现过的安全说明，不得带绝对路径。 */
  skillDescriptions?: Record<string, string>
  invalidReason?: string
}

/**
 * 列表用短说明。允许相对路径字样（如 skills/foo.md），拒绝绝对路径和 NUL。
 */
export function parseSafePluginDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text || text.includes('\0')) return undefined
  if (/^(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/|\/tmp\/|\/var\/)/i.test(text)) return undefined
  if (text.length <= MAX_RUNTIME_PLUGIN_DESCRIPTION_LENGTH) return text
  return text.slice(0, MAX_RUNTIME_PLUGIN_DESCRIPTION_LENGTH).trim()
}

/** 从 SKILL.md 取 frontmatter 或首段正文，标题行不当说明。 */
export function parseSkillMarkdownDescription(markdown: string): string | undefined {
  if (typeof markdown !== 'string' || markdown.includes('\0')) return undefined
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (frontmatter) {
    const match = frontmatter[1].match(/^description:\s*['"]?(.+?)['"]?\s*$/m)
    if (match) return parseSafePluginDescription(match[1])
  }
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed === '---' || trimmed.startsWith('#')) continue
    return parseSafePluginDescription(trimmed)
  }
  return undefined
}

export function isRuntimePluginScope(value: unknown): value is RuntimePluginScope {
  return typeof value === 'string' && (RUNTIME_PLUGIN_SCOPES as readonly string[]).includes(value)
}

export function isRuntimePluginStatus(value: unknown): value is RuntimePluginStatus {
  return typeof value === 'string' && (RUNTIME_PLUGIN_STATUSES as readonly string[]).includes(value)
}

/**
 * pluginId 必须是单层目录名：禁止空值、NUL、路径分隔符和 `..`，
 * 避免后续 join/realpath 之前就把扫描指向 grok-home 之外。
 */
export function isRuntimePluginId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.length > MAX_PLUGIN_ID_LENGTH) return false
  if (value === '.' || value.includes('\0')) return false
  if (value.includes('/') || value.includes('\\')) return false
  if (value.includes('..')) return false
  return true
}

/**
 * Preload / IPC 入口：只保留可展示字段。
 * path、manifest、env、command 等一律丢弃，防止密钥或绝对路径漏到 Renderer。
 */
export function parseRuntimePluginSummary(value: unknown): RuntimePluginSummary | null {
  if (!isPlainRecord(value)) return null
  if (!isRuntimePluginId(value.pluginId)) return null
  if (!isSafeDisplayName(value.displayName)) return null
  if (!isRuntimePluginStatus(value.status)) return null
  if (!isRuntimePluginScope(value.scope)) return null

  const skillCount = parseCount(value.skillCount)
  const mcpCount = parseCount(value.mcpCount)
  const hookCount = parseCount(value.hookCount)
  if (skillCount === null || mcpCount === null || hookCount === null) return null

  const summary: RuntimePluginSummary = {
    pluginId: value.pluginId,
    displayName: value.displayName,
    status: value.status,
    scope: value.scope,
    skillCount,
    mcpCount,
    hookCount
  }

  const version = parseVersion(value.version)
  if (version) summary.version = version
  const description = parseSafePluginDescription(value.description)
  if (description) summary.description = description
  return summary
}

/** 详情在摘要之上只保留名称列表；计数以过滤后的名称长度为准。 */
export function parseRuntimePluginDetail(value: unknown): RuntimePluginDetail | null {
  const summary = parseRuntimePluginSummary(value)
  if (!summary || !isPlainRecord(value)) return null
  if (
    !Array.isArray(value.skillNames) ||
    !Array.isArray(value.mcpNames) ||
    !Array.isArray(value.hookNames)
  ) {
    return null
  }

  const skillNames = parseNameList(value.skillNames)
  const mcpNames = parseNameList(value.mcpNames)
  const hookNames = parseNameList(value.hookNames)
  const detail: RuntimePluginDetail = {
    ...summary,
    skillCount: skillNames.length,
    mcpCount: mcpNames.length,
    hookCount: hookNames.length,
    skillNames,
    mcpNames,
    hookNames
  }
  const skillDescriptions = parseSkillDescriptions(value.skillDescriptions, skillNames)
  if (skillDescriptions) detail.skillDescriptions = skillDescriptions

  if (summary.status === 'invalid') {
    const invalidReason = parseInvalidReason(value.invalidReason)
    if (invalidReason) detail.invalidReason = invalidReason
  }

  return detail
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return Math.min(value, MAX_RUNTIME_PLUGIN_NAMES)
}

function isSafeDisplayName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.length > MAX_DISPLAY_NAME_LENGTH || value.includes('\0')) return false
  return true
}

function parseVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_VERSION_LENGTH || trimmed.includes('\0')) return undefined
  return trimmed
}

function parseSkillDescriptions(
  value: unknown,
  skillNames: readonly string[]
): Record<string, string> | undefined {
  if (!isPlainRecord(value)) return undefined
  const allowed = new Set(skillNames)
  const descriptions: Record<string, string> = {}
  for (const [name, raw] of Object.entries(value)) {
    if (!allowed.has(name)) continue
    const description = parseSafePluginDescription(raw)
    if (!description) continue
    descriptions[name] = description
  }
  return Object.keys(descriptions).length > 0 ? descriptions : undefined
}

function parseNameList(value: unknown[]): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    if (item.length === 0 || item.length > MAX_RUNTIME_PLUGIN_NAME_LENGTH) continue
    if (item.includes('\0')) continue
    if (seen.has(item)) continue
    seen.add(item)
    names.push(item)
    if (names.length >= MAX_RUNTIME_PLUGIN_NAMES) break
  }
  return names
}

/** 失败原因只保留短中文；含路径分隔符则丢弃，避免把绝对路径带进 Renderer。 */
function parseInvalidReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_INVALID_REASON_LENGTH) return undefined
  if (trimmed.includes('\0') || trimmed.includes('/') || trimmed.includes('\\')) return undefined
  return trimmed
}
