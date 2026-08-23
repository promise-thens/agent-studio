/** Task inbox 附件的共享类型与纯函数分类；不得导入 Node fs 或 Electron。 */

export const ATTACHMENT_LIMITS = {
  maxPerTurn: 8,
  maxBytesPerFile: 10 * 1024 * 1024,
  maxBytesPerTurn: 20 * 1024 * 1024,
  maxInboxBytesPerTask: 200 * 1024 * 1024,
  maxImagePixels: 20_000_000,
  maxPreviewEdge: 256,
  maxOriginalNameBytes: 255
} as const

export type TaskAttachmentKind = 'image' | 'text' | 'pdf'
export type TaskAttachmentSource = 'user' | 'runtime'
export type TaskAttachmentBinding = 'draft' | 'bound'
export type TaskAttachmentAvailability = 'ready' | 'missing' | 'invalid'

export interface TaskAttachmentDescriptor {
  attachmentId: string
  taskId: string
  originalName: string
  storedName: string
  kind: TaskAttachmentKind
  mimeType: string
  byteSize: number
  contentHash: string
  source: TaskAttachmentSource
  binding: TaskAttachmentBinding
  turnId?: string
  createdAt: string
  availability: TaskAttachmentAvailability
}

export type TaskAttachmentRejectReason =
  | 'empty'
  | 'too-large'
  | 'unsupported-type'
  | 'mime-mismatch'
  | 'binary-text'
  | 'nul'
  | 'invalid-name'

export type ClassifyTaskAttachmentResult =
  | {
      ok: true
      kind: TaskAttachmentKind
      mimeType: string
      originalName: string
    }
  | { ok: false; reason: TaskAttachmentRejectReason }

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

const TEXT_MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.log': 'text/plain',
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
  '.kt': 'text/plain',
  '.c': 'text/plain',
  '.h': 'text/plain',
  '.cpp': 'text/plain',
  '.hpp': 'text/plain',
  '.cs': 'text/plain',
  '.rb': 'text/plain',
  '.php': 'text/plain',
  '.swift': 'text/plain',
  '.sh': 'text/plain',
  '.bash': 'text/plain',
  '.zsh': 'text/plain',
  '.toml': 'text/plain',
  '.yaml': 'text/plain',
  '.yml': 'text/plain',
  '.xml': 'text/plain',
  '.css': 'text/plain',
  '.scss': 'text/plain',
  '.sql': 'text/plain',
  '.graphql': 'text/plain',
  '.proto': 'text/plain',
  '.html': 'text/plain'
}

const REJECTED_EXT = new Set([
  '.svg',
  '.env',
  '.pem',
  '.key',
  '.p12',
  '.exe',
  '.dll',
  '.so',
  '.dylib'
])

export function fileExtensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot).toLowerCase()
}

/** 去掉路径和 NUL，避免把用户文件名当路径用。 */
export function sanitizeAttachmentFileName(originalName: string): string {
  const stripped = originalName.replace(/\0/g, '').trim()
  const base = stripped.split(/[/\\]/).pop()?.trim() ?? ''
  if (!base || base === '.' || base === '..') return 'attachment'
  return base.slice(0, ATTACHMENT_LIMITS.maxOriginalNameBytes)
}

export function isImageAttachmentPath(path: string): boolean {
  return fileExtensionOf(path) in IMAGE_MIME_BY_EXT
}

export function isPdfAttachmentPath(path: string): boolean {
  return fileExtensionOf(path) === '.pdf'
}

export function isChangeMediaPreviewPath(path: string): boolean {
  return isImageAttachmentPath(path) || isPdfAttachmentPath(path)
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false
  return signature.every((value, index) => bytes[index] === value)
}

function detectImageMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) return 'image/gif'
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif'
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

function isPdfMagic(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x25, 0x50, 0x44, 0x46])
}

function containsNul(bytes: Uint8Array): boolean {
  return bytes.includes(0)
}

function isUtf8Text(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * 用扩展名和魔数同时判定附件类型。
 * 冲突或未知类型一律拒绝，避免 SVG/HTML 伪装成图片进入对话。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Preload / IPC 入站描述符；缺字段或绝对路径一律丢掉。 */
export function parseTaskAttachmentDescriptor(value: unknown): TaskAttachmentDescriptor | null {
  if (!isRecord(value)) return null
  if (typeof value.attachmentId !== 'string' || !value.attachmentId.trim()) return null
  if (typeof value.taskId !== 'string' || !value.taskId.trim()) return null
  if (typeof value.originalName !== 'string' || typeof value.storedName !== 'string') return null
  if (value.kind !== 'image' && value.kind !== 'text' && value.kind !== 'pdf') return null
  if (typeof value.mimeType !== 'string' || !Number.isSafeInteger(value.byteSize)) return null
  if (typeof value.contentHash !== 'string' || typeof value.createdAt !== 'string') return null
  if (value.source !== 'user' && value.source !== 'runtime') return null
  if (value.binding !== 'draft' && value.binding !== 'bound') return null
  if (
    value.availability !== 'ready' &&
    value.availability !== 'missing' &&
    value.availability !== 'invalid'
  ) {
    return null
  }
  if ('path' in value || 'filePath' in value) return null
  const descriptor: TaskAttachmentDescriptor = {
    attachmentId: value.attachmentId,
    taskId: value.taskId,
    originalName: value.originalName,
    storedName: value.storedName,
    kind: value.kind,
    mimeType: value.mimeType,
    byteSize: Number(value.byteSize),
    contentHash: value.contentHash,
    source: value.source,
    binding: value.binding,
    createdAt: value.createdAt,
    availability: value.availability
  }
  if (typeof value.turnId === 'string' && value.turnId.trim()) descriptor.turnId = value.turnId
  return descriptor
}

export function classifyTaskAttachmentBytes(input: {
  originalName: string
  bytes: Uint8Array
}): ClassifyTaskAttachmentResult {
  const originalName = sanitizeAttachmentFileName(input.originalName)
  if (originalName === 'attachment' && !input.originalName.trim()) {
    return { ok: false, reason: 'invalid-name' }
  }
  if (input.bytes.byteLength === 0) return { ok: false, reason: 'empty' }
  if (input.bytes.byteLength > ATTACHMENT_LIMITS.maxBytesPerFile) {
    return { ok: false, reason: 'too-large' }
  }

  const ext = fileExtensionOf(originalName)
  if (ext === '.env' || REJECTED_EXT.has(ext) || originalName === '.env') {
    return { ok: false, reason: 'unsupported-type' }
  }

  const imageMime = IMAGE_MIME_BY_EXT[ext]
  if (imageMime) {
    const detected = detectImageMime(input.bytes)
    if (!detected) return { ok: false, reason: 'mime-mismatch' }
    if (detected !== imageMime) return { ok: false, reason: 'mime-mismatch' }
    return { ok: true, kind: 'image', mimeType: imageMime, originalName }
  }

  if (ext === '.pdf') {
    if (!isPdfMagic(input.bytes)) return { ok: false, reason: 'mime-mismatch' }
    return { ok: true, kind: 'pdf', mimeType: 'application/pdf', originalName }
  }

  const textMime = TEXT_MIME_BY_EXT[ext]
  if (textMime) {
    if (containsNul(input.bytes)) return { ok: false, reason: 'nul' }
    if (!isUtf8Text(input.bytes)) return { ok: false, reason: 'binary-text' }
    return { ok: true, kind: 'text', mimeType: textMime, originalName }
  }

  return { ok: false, reason: 'unsupported-type' }
}
