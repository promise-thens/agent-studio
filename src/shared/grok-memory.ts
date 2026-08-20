function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export const GROK_MEMORY_SCOPES = ['global', 'project', 'session'] as const
export type GrokMemoryScope = (typeof GROK_MEMORY_SCOPES)[number]

export const GROK_MEMORY_SHARE_STATUSES = ['linked', 'already-linked', 'skipped-existing'] as const
export type GrokMemoryShareStatus = (typeof GROK_MEMORY_SHARE_STATUSES)[number]

/** 记忆正文读写上限：超过则 get 截断且禁止用截断内容覆盖保存。 */
export const GROK_MEMORY_MAX_BYTES = 256 * 1024

const MEMORY_ID_PATTERN =
  /^(global\/MEMORY\.md|project\/[A-Za-z0-9._-]+-[0-9A-Fa-f]{8}\/MEMORY\.md|session\/[A-Za-z0-9._-]+-[0-9A-Fa-f]{8}\/[^/]+\.md)$/

export interface GrokMemorySummary {
  memoryId: string
  scope: GrokMemoryScope
  title: string
  updatedAt: string | null
  /** 项目目录名 `<slug>-<hash8>`，会话也挂在对应项目下。 */
  projectKey?: string
  isCurrentProject?: boolean
}

export interface GrokMemoryDocument {
  memoryId: string
  scope: GrokMemoryScope
  title: string
  markdown: string
  truncated?: true
  projectKey?: string
}

export interface ParsedGrokMemoryId {
  memoryId: string
  scope: GrokMemoryScope
  /** 相对 memory 根的 posix 路径，例如 `MEMORY.md` 或 `demo-deadbeef/sessions/a.md`。 */
  relativePosixPath: string
  projectKey?: string
}

export interface GrokMemoryEnabledState {
  enabled: boolean
  shareStatus: GrokMemoryShareStatus
}

export function isGrokMemoryScope(value: unknown): value is GrokMemoryScope {
  return typeof value === 'string' && (GROK_MEMORY_SCOPES as readonly string[]).includes(value)
}

export function isGrokMemoryShareStatus(value: unknown): value is GrokMemoryShareStatus {
  return (
    typeof value === 'string' && (GROK_MEMORY_SHARE_STATUSES as readonly string[]).includes(value)
  )
}

/**
 * memoryId 只允许三种已知布局，禁止 `..`、绝对路径、反斜杠和 NUL。
 * 主进程再映射到 grok-home/memory；Renderer 不得传绝对路径。
 */
export function isGrokMemoryId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false
  if (value.includes('\0') || value.includes('\\') || value.includes('..')) return false
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  return MEMORY_ID_PATTERN.test(value)
}

export function parseGrokMemoryId(memoryId: unknown): ParsedGrokMemoryId | null {
  if (!isGrokMemoryId(memoryId)) return null
  if (memoryId === 'global/MEMORY.md') {
    return { memoryId, scope: 'global', relativePosixPath: 'MEMORY.md' }
  }
  const projectMatch = /^project\/([^/]+)\/MEMORY\.md$/.exec(memoryId)
  if (projectMatch) {
    return {
      memoryId,
      scope: 'project',
      relativePosixPath: `${projectMatch[1]}/MEMORY.md`,
      projectKey: projectMatch[1]
    }
  }
  const sessionMatch = /^session\/([^/]+)\/([^/]+\.md)$/.exec(memoryId)
  if (sessionMatch) {
    return {
      memoryId,
      scope: 'session',
      relativePosixPath: `${sessionMatch[1]}/sessions/${sessionMatch[2]}`,
      projectKey: sessionMatch[1]
    }
  }
  return null
}

export function grokMemoryTitle(markdown: string, fallback: string): string {
  const heading = /^#\s+(.+)$/m.exec(markdown)
  const title = heading?.[1]?.trim()
  return title || fallback
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Preload 再 parse：丢掉绝对路径等脏字段。 */
export function parseGrokMemorySummary(value: unknown): GrokMemorySummary | null {
  if (!isPlainRecord(value)) return null
  const parsedId = parseGrokMemoryId(value.memoryId)
  if (!parsedId || !isGrokMemoryScope(value.scope) || parsedId.scope !== value.scope) return null
  if (typeof value.title !== 'string' || value.title.length === 0 || value.title.length > 256) {
    return null
  }
  if (value.title.includes('\0')) return null
  if (value.updatedAt !== null && typeof value.updatedAt !== 'string') return null
  if (typeof value.updatedAt === 'string' && value.updatedAt.length > 64) return null
  const summary: GrokMemorySummary = {
    memoryId: parsedId.memoryId,
    scope: parsedId.scope,
    title: value.title,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null
  }
  if (typeof value.projectKey === 'string' && value.projectKey === parsedId.projectKey) {
    summary.projectKey = value.projectKey
  }
  if (value.isCurrentProject === true) summary.isCurrentProject = true
  return summary
}

export function parseGrokMemoryDocument(value: unknown): GrokMemoryDocument | null {
  if (!isPlainRecord(value)) return null
  const parsedId = parseGrokMemoryId(value.memoryId)
  if (!parsedId || !isGrokMemoryScope(value.scope) || parsedId.scope !== value.scope) return null
  if (typeof value.title !== 'string' || value.title.length === 0 || value.title.length > 256) {
    return null
  }
  if (typeof value.markdown !== 'string' || value.markdown.includes('\0')) return null
  if (utf8ByteLength(value.markdown) > GROK_MEMORY_MAX_BYTES) return null
  const document: GrokMemoryDocument = {
    memoryId: parsedId.memoryId,
    scope: parsedId.scope,
    title: value.title,
    markdown: value.markdown
  }
  if (value.truncated === true) document.truncated = true
  if (typeof value.projectKey === 'string' && value.projectKey === parsedId.projectKey) {
    document.projectKey = value.projectKey
  }
  return document
}

export function parseGrokMemoryEnabledState(value: unknown): GrokMemoryEnabledState | null {
  if (!isPlainRecord(value)) return null
  if (typeof value.enabled !== 'boolean') return null
  if (!isGrokMemoryShareStatus(value.shareStatus)) return null
  return { enabled: value.enabled, shareStatus: value.shareStatus }
}

/**
 * 当前 Local Project 与共享树目录的 best-effort 匹配。
 * 不得据此新建第二套 hash 目录：对不上就全部列在「项目」分组。
 */
export function isCurrentProjectMemoryDir(projectKey: string, projectHint?: string): boolean {
  if (!projectHint?.trim()) return false
  const slug = projectKey.replace(/-[0-9A-Fa-f]{8}$/, '').toLowerCase()
  const hint = projectHint
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug || !hint) return false
  return slug === hint || slug.includes(hint) || hint.includes(slug)
}
