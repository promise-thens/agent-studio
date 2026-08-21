import type { GrokMemorySummary } from '../../shared/grok-memory'

export interface MemoryProjectGroup {
  projectKey: string
  isCurrent: boolean
  project?: GrokMemorySummary
  sessions: GrokMemorySummary[]
}

const PROJECT_MEMORY_HEADING = /^Project Memory\s+[—–-]\s+/i
const GLOBAL_MEMORY_HEADING = /^Global Memory$/i

/**
 * 列表只展示人能扫一眼的名字。
 * Grok 默认标题常带绝对路径，那串只能进 title 提示，不能撑破侧栏。
 */
export function formatMemoryItemTitle(
  item: Pick<GrokMemorySummary, 'scope' | 'title' | 'projectKey'>
): string {
  const title = item.title.trim()
  if (item.scope === 'global') {
    if (!title || GLOBAL_MEMORY_HEADING.test(title)) return '全局记忆'
    return title
  }
  if (item.scope === 'project') {
    const fallback = item.projectKey ? formatProjectKey(item.projectKey) : '项目记忆'
    if (PROJECT_MEMORY_HEADING.test(title)) {
      const stripped = title.replace(PROJECT_MEMORY_HEADING, '').trim()
      if (!stripped || looksLikeFilePath(stripped)) return fallback
      return stripped
    }
    if (!title || looksLikeFilePath(title)) return fallback
    return title
  }
  if (!title || looksLikeFilePath(title) || isMarkdownFileName(title)) return '未命名会话'
  return title
}

export function formatMemoryKindLabel(scope: GrokMemorySummary['scope']): string {
  if (scope === 'global') return '全局'
  if (scope === 'project') return '项目'
  return '会话'
}

/** 侧栏第二行只放时间；范围改用 kind 标签，避免和标题抢层级。 */
export function formatMemoryItemSubtitle(
  item: Pick<GrokMemorySummary, 'scope' | 'updatedAt' | 'isCurrentProject'>,
  now = Date.now()
): string {
  const when = item.updatedAt ? formatMemoryUpdatedAt(item.updatedAt, now) : ''
  if (when) return when
  if (item.scope === 'global') return '跨项目'
  if (item.scope === 'project') return item.isCurrentProject ? '本项目' : '项目笔记'
  return '会话备忘'
}

/** 目录名里的 hash 对人选文件没有帮助，只留 slug。 */
export function formatProjectKey(projectKey?: string): string {
  if (!projectKey) return '未知项目'
  const slug = projectKey.replace(/-[0-9A-Fa-f]{8}$/, '')
  return slug || projectKey
}

export function formatMemoryUpdatedAt(iso: string, now = Date.now()): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ''
  const delta = Math.max(0, now - time)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < minute) return '刚刚'
  if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`
  if (delta < day) return `${Math.floor(delta / hour)} 小时前`
  if (delta < 7 * day) return `${Math.floor(delta / day)} 天前`
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(
    new Date(time)
  )
}

/**
 * 当前项目置顶。没有当前目录时不强造 hash，只按已有 `<slug>-<hash8>` 分组。
 */
export function groupProjectMemories(memories: GrokMemorySummary[]): MemoryProjectGroup[] {
  const groups = new Map<string, MemoryProjectGroup>()
  for (const item of memories) {
    if (item.scope === 'global' || !item.projectKey) continue
    const group = groups.get(item.projectKey) ?? {
      projectKey: item.projectKey,
      isCurrent: false,
      sessions: []
    }
    if (item.isCurrentProject) group.isCurrent = true
    if (item.scope === 'project') group.project = item
    else group.sessions.push(item)
    groups.set(item.projectKey, group)
  }
  for (const group of groups.values()) {
    group.sessions.sort((left, right) => memoryTime(right.updatedAt) - memoryTime(left.updatedAt))
  }
  return [...groups.values()].sort((left, right) => {
    if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1
    return formatProjectKey(left.projectKey).localeCompare(formatProjectKey(right.projectKey), 'zh')
  })
}

function memoryTime(iso: string | null | undefined): number {
  const time = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(time) ? time : 0
}

export function looksLikeFilePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')
}

function isMarkdownFileName(value: string): boolean {
  return /^[^/\\]+\.md$/i.test(value)
}
