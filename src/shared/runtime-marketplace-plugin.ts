import {
  isRuntimePluginId,
  MAX_RUNTIME_PLUGIN_NAMES,
  parseSafePluginDescription
} from './runtime-plugin'

/** 货架条目名：与 isRuntimePluginId 叠加的字符集与长度约束。 */
const MARKETPLACE_PLUGIN_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,63}$/

/** 源 id：短标识，禁止冒号以免 scp-like host:path 混入。 */
const MARKETPLACE_SOURCE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

const MAX_DISPLAY_NAME_LENGTH = 256

/**
 * Renderer 可展示的市场货架摘要。
 * 故意不含 path / sha / url，避免绝对路径与 git 凭据形态漏到 UI。
 */
export interface MarketplacePluginSummary {
  name: string
  displayName: string
  description: string
  /** config 里的源 id（如 plugin-marketplace），绝不是 git URL。 */
  sourceName: string
  installed: boolean
  skillCount?: number
  mcpCount?: number
  hookCount?: number
}

/**
 * Preload / IPC 入口：只保留货架可展示字段。
 * path、sha、url 等一律丢弃；非法 name 或 URL 形态的 sourceName 整项跳过。
 */
export function parseMarketplacePluginSummary(value: unknown): MarketplacePluginSummary | null {
  if (!isPlainRecord(value)) return null
  if (!isMarketplacePluginName(value.name)) return null
  if (!isSafeDisplayName(value.displayName)) return null
  if (!isSafeSourceName(value.sourceName)) return null
  if (typeof value.installed !== 'boolean') return null

  const summary: MarketplacePluginSummary = {
    name: value.name,
    displayName: value.displayName,
    description: parseMarketplaceDescription(value.description),
    sourceName: value.sourceName,
    installed: value.installed
  }

  const skillCount = parseOptionalCount(value.skillCount)
  if (skillCount === 'invalid') return null
  if (skillCount !== undefined) summary.skillCount = skillCount

  const mcpCount = parseOptionalCount(value.mcpCount)
  if (mcpCount === 'invalid') return null
  if (mcpCount !== undefined) summary.mcpCount = mcpCount

  const hookCount = parseOptionalCount(value.hookCount)
  if (hookCount === 'invalid') return null
  if (hookCount !== undefined) summary.hookCount = hookCount

  return summary
}

/** name 必须同时通过目录安全检查与货架字符集，避免命令注入或路径穿越。 */
export function isMarketplacePluginName(value: unknown): value is string {
  return isRuntimePluginId(value) && MARKETPLACE_PLUGIN_NAME_PATTERN.test(value)
}

/**
 * sourceName 只接受短源 id（如 plugin-marketplace）。
 * 禁止 : / \ @ 与 URL 形态，避免把 git/scp 远端写成 config name。
 */
function isSafeSourceName(value: unknown): value is string {
  return typeof value === 'string' && MARKETPLACE_SOURCE_NAME_PATTERN.test(value)
}

function isSafeDisplayName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.length > MAX_DISPLAY_NAME_LENGTH || value.includes('\0')) return false
  return true
}

/** 说明缺失或不安全时落为空串，避免绝对路径进入 DTO。 */
function parseMarketplaceDescription(value: unknown): string {
  return parseSafePluginDescription(value) ?? ''
}

/**
 * 可选计数：缺失则省略；出现则必须是非负整数并钳制上限。
 * 非法类型返回 'invalid' 让整项跳过。
 */
function parseOptionalCount(value: unknown): number | undefined | 'invalid' {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return 'invalid'
  return Math.min(value, MAX_RUNTIME_PLUGIN_NAMES)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
