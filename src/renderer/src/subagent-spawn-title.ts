/** Grok Build spawn 行：`[subagent:type] 名称 (短id)`。不是协议 parentId。 */

export interface SubagentSpawnTitle {
  agentType: string
  name: string
  shortId?: string
  /** 折叠态原样展示，不编造营销名前缀。 */
  heading: string
}

const SPAWN_TITLE_RE = /^\[subagent:([^\]]+)\]\s*(.*?)\s*$/i
const TRAILING_ID_RE = /^(.*?)\s+\(([A-Za-z0-9_-]+)\)\s*$/

/**
 * 只认结构化 `[subagent:` 前缀。
 * 标题里随便出现 subagent / 子 Agent 不得当成 spawn 行。
 */
export function parseSubagentSpawnTitle(title: string): SubagentSpawnTitle | null {
  const trimmed = title.trim()
  const match = trimmed.match(SPAWN_TITLE_RE)
  if (!match) return null
  const agentType = match[1]?.trim()
  if (!agentType) return null
  const rest = match[2] ?? ''
  const withId = rest.match(TRAILING_ID_RE)
  const name = (withId ? withId[1] : rest).trim()
  const shortId = withId?.[2]
  return {
    agentType,
    name,
    heading: trimmed,
    ...(shortId ? { shortId } : {})
  }
}

export function isSubagentSpawnTitle(title: string): boolean {
  return parseSubagentSpawnTitle(title) != null
}

/** 多个 spawn 同时打开时不抢工具，避免猜树。 */
export const SUBAGENT_AMBIGUOUS_COPY = '并行子任务无法归组工具，它们仍在父对话里。'

/**
 * 只用事件 observedAt 算耗时，不用 Date.now() 编墙钟。
 * 缺时间或不足 1 秒则不展示。
 */
export function formatSubagentDuration(
  firstObservedAt?: string,
  lastObservedAt?: string
): string | undefined {
  if (!firstObservedAt || !lastObservedAt) return undefined
  const started = Date.parse(firstObservedAt)
  const ended = Date.parse(lastObservedAt)
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended <= started) return undefined
  const totalSeconds = Math.floor((ended - started) / 1000)
  if (totalSeconds < 1) return undefined
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds} 秒`
  return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
}
