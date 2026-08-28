import { sanitizeExternalHref } from './external-href'
import { parseFileDiffResult, type FileDiffResult } from './git-review'

/** Artifact 读取上限；描述符不含文件正文或绝对路径。 */
export const ARTIFACT_LIMITS = {
  maxBytesPerFile: 8 * 1024 * 1024,
  maxTextBytes: 256 * 1024,
  maxImagePixels: 20_000_000,
  maxTitleBytes: 255,
  maxRelativePathBytes: 4 * 1024,
  maxCacheBytes: 32 * 1024 * 1024,
  maxArtifactsPerTask: 200
} as const

export type ArtifactKind = 'text' | 'markdown' | 'image' | 'diff'
export type ArtifactSource = 'agent-event' | 'git-review' | 'user-select'
export type ArtifactTrustLevel = 'verified' | 'untrusted' | 'unsupported'
export type ArtifactAvailability = 'ready' | 'missing' | 'changed' | 'unavailable' | 'unsupported'

export interface ArtifactFileRef {
  kind: 'file'
  relativePath: string
}

export interface ArtifactDiffRef {
  kind: 'diff'
  path: string
}

export type ArtifactLocation = ArtifactFileRef | ArtifactDiffRef

export interface ArtifactDescriptor {
  artifactId: string
  projectId: string
  taskId: string
  turnId: string
  kind: ArtifactKind
  title: string
  mimeType: string
  source: ArtifactSource
  environmentId: string
  location: ArtifactLocation
  size: number
  contentHash: string
  createdAt: string
  trustLevel: ArtifactTrustLevel
  availability: ArtifactAvailability
  revision: number
}

export type ArtifactRejectReason =
  | 'empty'
  | 'too-large'
  | 'unsupported-type'
  | 'mime-mismatch'
  | 'binary-text'
  | 'nul'
  | 'invalid-path'

export type ClassifyArtifactResult =
  | { ok: true; kind: Exclude<ArtifactKind, 'diff'>; mimeType: string; title: string }
  | { ok: false; reason: ArtifactRejectReason }

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

const MARKDOWN_EXT = new Set(['.md', '.markdown'])

const TEXT_MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.toml': 'text/plain',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.xml': 'text/plain',
  '.css': 'text/css',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.js': 'text/plain',
  '.jsx': 'text/plain',
  '.mjs': 'text/plain',
  '.cjs': 'text/plain',
  '.vue': 'text/plain',
  '.py': 'text/plain',
  '.go': 'text/plain',
  '.rs': 'text/plain',
  '.java': 'text/plain',
  '.c': 'text/plain',
  '.h': 'text/plain',
  '.cpp': 'text/plain',
  '.hpp': 'text/plain',
  '.sh': 'text/plain',
  '.bash': 'text/plain',
  '.zsh': 'text/plain'
}

const REJECTED_EXT = new Set([
  '.svg',
  '.html',
  '.htm',
  '.xhtml',
  '.pdf',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.env',
  '.pem',
  '.key'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function fileExtensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot).toLowerCase()
}

function titleFromRelativePath(relativePath: string): string {
  const base = relativePath.split('/').pop()?.trim() || 'artifact'
  return base.slice(0, ARTIFACT_LIMITS.maxTitleBytes)
}

/** 只接受 posix 相对路径，禁止绝对路径、盘符和父目录穿越。 */
export function sanitizeArtifactRelativePath(value: string): string | null {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null
  const trimmed = value.trim()
  if (trimmed.includes('\\')) return null
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) return null
  const segments = trimmed.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..')) return null
  const posix = segments.join('/')
  if (utf8ByteLength(posix) > ARTIFACT_LIMITS.maxRelativePathBytes) return null
  return posix
}

function parseLocation(value: unknown): ArtifactLocation | null {
  if (!isRecord(value)) return null
  if (value.kind === 'file') {
    if ('path' in value && value.path !== undefined) return null
    if (typeof value.relativePath !== 'string') return null
    const relativePath = sanitizeArtifactRelativePath(value.relativePath)
    if (!relativePath) return null
    return { kind: 'file', relativePath }
  }
  if (value.kind === 'diff') {
    if ('relativePath' in value && value.relativePath !== undefined) return null
    if (typeof value.path !== 'string') return null
    const path = sanitizeArtifactRelativePath(value.path)
    if (!path) return null
    return { kind: 'diff', path }
  }
  return null
}

function isKind(value: unknown): value is ArtifactKind {
  return value === 'text' || value === 'markdown' || value === 'image' || value === 'diff'
}

function isSource(value: unknown): value is ArtifactSource {
  return value === 'agent-event' || value === 'git-review' || value === 'user-select'
}

function isTrust(value: unknown): value is ArtifactTrustLevel {
  return value === 'verified' || value === 'untrusted' || value === 'unsupported'
}

function isAvailability(value: unknown): value is ArtifactAvailability {
  return (
    value === 'ready' ||
    value === 'missing' ||
    value === 'changed' ||
    value === 'unavailable' ||
    value === 'unsupported'
  )
}

/**
 * Preload / IPC 入站描述符。绝对路径、额外 path 字段一律丢掉。
 */
export function parseArtifactDescriptor(value: unknown): ArtifactDescriptor | null {
  if (!isRecord(value)) return null
  if ('path' in value || 'filePath' in value) return null
  if (typeof value.artifactId !== 'string' || !value.artifactId.trim()) return null
  if (typeof value.projectId !== 'string' || !value.projectId.trim()) return null
  if (typeof value.taskId !== 'string' || !value.taskId.trim()) return null
  if (typeof value.turnId !== 'string' || !value.turnId.trim()) return null
  if (
    !isKind(value.kind) ||
    typeof value.title !== 'string' ||
    typeof value.mimeType !== 'string'
  ) {
    return null
  }
  if (!isSource(value.source) || typeof value.environmentId !== 'string') return null
  if (!Number.isSafeInteger(value.size) || Number(value.size) < 0) return null
  if (typeof value.contentHash !== 'string' || typeof value.createdAt !== 'string') return null
  if (!isTrust(value.trustLevel) || !isAvailability(value.availability)) return null
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) return null
  const location = parseLocation(value.location)
  if (!location) return null
  if (value.kind === 'diff' && location.kind !== 'diff') return null
  if (value.kind !== 'diff' && location.kind !== 'file') return null
  return {
    artifactId: value.artifactId,
    projectId: value.projectId,
    taskId: value.taskId,
    turnId: value.turnId,
    kind: value.kind,
    title: value.title,
    mimeType: value.mimeType,
    source: value.source,
    environmentId: value.environmentId,
    location,
    size: Number(value.size),
    contentHash: value.contentHash,
    createdAt: value.createdAt,
    trustLevel: value.trustLevel,
    availability: value.availability,
    revision: Number(value.revision)
  }
}

function startsWith(data: Uint8Array, signature: readonly number[]): boolean {
  if (data.length < signature.length) return false
  return signature.every((value, index) => data[index] === value)
}

function detectImageMime(data: Uint8Array): string | null {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) return 'image/gif'
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif'
  if (
    startsWith(data, [0x52, 0x49, 0x46, 0x46]) &&
    data.length >= 12 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

function containsNul(data: Uint8Array): boolean {
  return data.includes(0)
}

function isUtf8Text(data: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data)
    return true
  } catch {
    return false
  }
}

/**
 * 用扩展名和魔数同时判定 Artifact 文件类型。
 * SVG/HTML 一律拒绝，避免当图片或 Markdown 进入 Viewer。
 */
export function classifyArtifactBytes(input: {
  relativePath: string
  bytes: Uint8Array
}): ClassifyArtifactResult {
  const relativePath = sanitizeArtifactRelativePath(input.relativePath)
  if (!relativePath) return { ok: false, reason: 'invalid-path' }
  const title = titleFromRelativePath(relativePath)
  if (input.bytes.byteLength === 0) return { ok: false, reason: 'empty' }
  if (input.bytes.byteLength > ARTIFACT_LIMITS.maxBytesPerFile) {
    return { ok: false, reason: 'too-large' }
  }

  const ext = fileExtensionOf(relativePath)
  if (REJECTED_EXT.has(ext)) return { ok: false, reason: 'unsupported-type' }

  const imageMime = IMAGE_MIME_BY_EXT[ext]
  if (imageMime) {
    const detected = detectImageMime(input.bytes)
    if (!detected || detected !== imageMime) return { ok: false, reason: 'mime-mismatch' }
    return { ok: true, kind: 'image', mimeType: imageMime, title }
  }

  if (MARKDOWN_EXT.has(ext)) {
    if (containsNul(input.bytes)) return { ok: false, reason: 'nul' }
    if (!isUtf8Text(input.bytes)) return { ok: false, reason: 'binary-text' }
    return { ok: true, kind: 'markdown', mimeType: 'text/markdown', title }
  }

  const textMime = TEXT_MIME_BY_EXT[ext]
  if (textMime) {
    if (containsNul(input.bytes)) return { ok: false, reason: 'nul' }
    if (!isUtf8Text(input.bytes)) return { ok: false, reason: 'binary-text' }
    return { ok: true, kind: 'text', mimeType: textMime, title }
  }

  return { ok: false, reason: 'unsupported-type' }
}

function stripHtml(source: string): string {
  return source
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
}

function rewriteMarkdownLinks(source: string): string {
  return source.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, rawHref: string) => {
    const href = sanitizeExternalHref(rawHref.trim().replace(/^<|>$/g, ''))
    if (!href) return label
    return `[${label}](${href})`
  })
}

/**
 * 主进程把 Markdown 收成可交给 Renderer 的文本：去掉 HTML 与危险协议。
 * Viewer 仍走 AssistantMarkdown，不使用 v-html。
 */
export function sanitizeArtifactMarkdown(source: string): string {
  return rewriteMarkdownLinks(stripHtml(source)).replace(/javascript:/gi, '')
}

export function artifactLocationKey(location: ArtifactLocation): string {
  return location.kind === 'diff' ? `diff:${location.path}` : `file:${location.relativePath}`
}

export function isImageArtifactPath(relativePath: string): boolean {
  return fileExtensionOf(relativePath) in IMAGE_MIME_BY_EXT
}

export function isMarkdownArtifactPath(relativePath: string): boolean {
  return MARKDOWN_EXT.has(fileExtensionOf(relativePath))
}

export function isTextArtifactPath(relativePath: string): boolean {
  const ext = fileExtensionOf(relativePath)
  return MARKDOWN_EXT.has(ext) || ext in TEXT_MIME_BY_EXT
}

export function isFileArtifactPath(relativePath: string): boolean {
  return isImageArtifactPath(relativePath) || isTextArtifactPath(relativePath)
}

/** 自动入库只收 Markdown/短文本/图片，避免把整棵源码树都当成产物。 */
export function isPrimaryFileArtifactPath(relativePath: string): boolean {
  const ext = fileExtensionOf(relativePath)
  return (
    isImageArtifactPath(relativePath) ||
    MARKDOWN_EXT.has(ext) ||
    ext === '.txt' ||
    ext === '.json' ||
    ext === '.csv' ||
    ext === '.log' ||
    ext === '.toml' ||
    ext === '.yaml' ||
    ext === '.yml'
  )
}

export type ArtifactTextContent = {
  kind: 'text'
  text: string
  truncated?: true
  descriptor: ArtifactDescriptor
}

export type ArtifactMarkdownContent = {
  kind: 'markdown'
  markdown: string
  truncated?: true
  descriptor: ArtifactDescriptor
}

export type ArtifactImageContent = {
  kind: 'image'
  mimeType: string
  imageBase64: string
  descriptor: ArtifactDescriptor
}

export type ArtifactDiffContent = {
  kind: 'diff'
  diff: FileDiffResult
  descriptor: ArtifactDescriptor
}

export type ArtifactContent =
  ArtifactTextContent | ArtifactMarkdownContent | ArtifactImageContent | ArtifactDiffContent

/** Preload 入站内容。绝对路径或未知 kind 一律丢掉。 */
export function parseArtifactContent(value: unknown): ArtifactContent | null {
  if (!isRecord(value)) return null
  if ('path' in value || 'filePath' in value) return null
  const descriptor = parseArtifactDescriptor(value.descriptor)
  if (!descriptor) return null
  if (value.kind === 'text' || value.kind === 'markdown') {
    const text = value.kind === 'text' ? value.text : value.markdown
    if (typeof text !== 'string' || text.includes('\0')) return null
    if (value.kind === 'text') {
      const content: ArtifactTextContent = { kind: 'text', text, descriptor }
      if (value.truncated === true) content.truncated = true
      return content
    }
    const content: ArtifactMarkdownContent = { kind: 'markdown', markdown: text, descriptor }
    if (value.truncated === true) content.truncated = true
    return content
  }
  if (value.kind === 'image') {
    if (typeof value.mimeType !== 'string' || typeof value.imageBase64 !== 'string') return null
    if (!value.imageBase64 || value.mimeType === 'image/svg+xml') return null
    return {
      kind: 'image',
      mimeType: value.mimeType,
      imageBase64: value.imageBase64,
      descriptor
    }
  }
  if (value.kind === 'diff') {
    const diff = parseFileDiffResult(value.diff)
    if (!diff) return null
    return { kind: 'diff', diff, descriptor }
  }
  return null
}
