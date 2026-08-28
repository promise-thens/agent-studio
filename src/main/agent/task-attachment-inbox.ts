import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, relative } from 'node:path'
import {
  ATTACHMENT_LIMITS,
  classifyTaskAttachmentBytes,
  sanitizeAttachmentFileName,
  type TaskAttachmentBinding,
  type TaskAttachmentDescriptor,
  type TaskAttachmentKind,
  type TaskAttachmentRejectReason,
  type TaskAttachmentSource
} from '../../shared/task-attachment'
import { AtomicJsonWriter } from '../storage/atomic-json-file'

const FILE_MODE = 0o600
const META_MAX_BYTES = 16 * 1024

export type TaskAttachmentErrorCode =
  | TaskAttachmentRejectReason
  | 'too-many-pixels'
  | 'not-found'
  | 'not-draft'
  | 'quota'
  | 'too-many'
  | 'escaped'
  | 'not-file'

/** 附件柜错误对 Renderer 只暴露稳定 code，不夹带绝对路径。 */
export class TaskAttachmentError extends Error {
  constructor(
    readonly code: TaskAttachmentErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'TaskAttachmentError'
  }
}

export type AttachmentImageProbe = (bytes: Buffer) => { width: number; height: number } | null

export interface TaskAttachmentInboxOptions {
  resolveTaskDirectory: (taskId: string) => string
  createId?: () => string
  now?: () => string
  probeImagePixels?: AttachmentImageProbe
  createThumbnail?: (bytes: Buffer) => { bytes: Buffer; mime: string } | null
  maxInboxBytesPerTask?: number
  writer?: AtomicJsonWriter
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isKind(value: unknown): value is TaskAttachmentKind {
  return value === 'image' || value === 'text' || value === 'pdf'
}

function isSource(value: unknown): value is TaskAttachmentSource {
  return value === 'user' || value === 'runtime'
}

function isBinding(value: unknown): value is TaskAttachmentBinding {
  return value === 'draft' || value === 'bound'
}

function parseDescriptor(value: unknown, taskId: string): TaskAttachmentDescriptor | null {
  if (!isRecord(value)) return null
  if (typeof value.attachmentId !== 'string' || !value.attachmentId.trim()) return null
  if (value.taskId !== taskId) return null
  if (typeof value.originalName !== 'string' || typeof value.storedName !== 'string') return null
  if (!isKind(value.kind) || typeof value.mimeType !== 'string') return null
  if (!Number.isSafeInteger(value.byteSize) || Number(value.byteSize) < 1) return null
  if (typeof value.contentHash !== 'string' || typeof value.createdAt !== 'string') return null
  if (!isSource(value.source) || !isBinding(value.binding)) return null
  if (
    value.availability !== 'ready' &&
    value.availability !== 'missing' &&
    value.availability !== 'invalid'
  ) {
    return null
  }
  const descriptor: TaskAttachmentDescriptor = {
    attachmentId: value.attachmentId,
    taskId,
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

function isInsideDirectory(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && rel !== '..')
}

/**
 * Task 私有附件柜。文件只写 App 历史目录，不进用户仓库。
 */
export class TaskAttachmentInbox {
  private readonly resolveTaskDirectory: (taskId: string) => string
  private readonly createId: () => string
  private readonly now: () => string
  private readonly probeImagePixels: AttachmentImageProbe | undefined
  private readonly createThumbnail:
    ((bytes: Buffer) => { bytes: Buffer; mime: string } | null) | undefined
  private readonly maxInboxBytesPerTask: number
  private readonly writer: AtomicJsonWriter

  constructor(options: TaskAttachmentInboxOptions) {
    this.resolveTaskDirectory = options.resolveTaskDirectory
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => new Date().toISOString())
    this.probeImagePixels = options.probeImagePixels
    this.createThumbnail = options.createThumbnail
    this.maxInboxBytesPerTask =
      options.maxInboxBytesPerTask ?? ATTACHMENT_LIMITS.maxInboxBytesPerTask
    this.writer = options.writer ?? new AtomicJsonWriter()
  }

  async importBytes(input: {
    taskId: string
    originalName: string
    bytes: Buffer
    source?: TaskAttachmentSource
  }): Promise<TaskAttachmentDescriptor> {
    return this.persist(input.taskId, input.originalName, input.bytes, input.source ?? 'user')
  }

  /** Runtime 图片直接绑定到当前 Turn，绝不进入 Composer draft。 */
  async importRuntimeBytes(input: {
    taskId: string
    turnId: string
    originalName: string
    mimeType: string
    bytes: Buffer
  }): Promise<TaskAttachmentDescriptor> {
    return this.persist(
      input.taskId,
      input.originalName,
      input.bytes,
      'runtime',
      'bound',
      input.turnId,
      input.mimeType
    )
  }

  async importPath(input: {
    taskId: string
    filePath: string
    source?: TaskAttachmentSource
  }): Promise<TaskAttachmentDescriptor> {
    if (!input.filePath || input.filePath.includes('\0')) {
      throw new TaskAttachmentError('invalid-name', '文件路径无效。')
    }
    const stats = await fs.lstat(input.filePath).catch(() => null)
    if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
      throw new TaskAttachmentError('not-file', '只能导入普通文件。')
    }
    const resolved = await fs.realpath(input.filePath)
    await this.assertNotInboxSource(input.taskId, resolved)
    const bytes = await fs.readFile(resolved)
    const originalName = sanitizeAttachmentFileName(input.filePath)
    return this.persist(input.taskId, originalName, bytes, input.source ?? 'user')
  }

  async listDrafts(taskId: string): Promise<TaskAttachmentDescriptor[]> {
    const all = await this.listAll(taskId)
    return all.filter((item) => item.binding === 'draft' && item.availability === 'ready')
  }

  async listAll(taskId: string): Promise<TaskAttachmentDescriptor[]> {
    const inboxRoot = this.inboxRoot(taskId)
    const entries = await fs.readdir(inboxRoot, { withFileTypes: true }).catch(() => [])
    const items: TaskAttachmentDescriptor[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const descriptor = await this.readMeta(taskId, entry.name)
      if (descriptor) items.push(descriptor)
    }
    return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async getDescriptor(taskId: string, attachmentId: string): Promise<TaskAttachmentDescriptor> {
    const descriptor = await this.readMeta(taskId, attachmentId)
    if (!descriptor) throw new TaskAttachmentError('not-found', '未找到该附件。')
    return descriptor
  }

  async readBytes(taskId: string, attachmentId: string): Promise<Buffer> {
    const descriptor = await this.getDescriptor(taskId, attachmentId)
    const filePath = join(this.attachmentDirectory(taskId, attachmentId), descriptor.storedName)
    const bytes = await fs.readFile(filePath).catch(() => null)
    if (!bytes) throw new TaskAttachmentError('not-found', '未找到该附件内容。')
    return bytes
  }

  async bindToTurn(
    taskId: string,
    attachmentIds: string[],
    turnId: string
  ): Promise<TaskAttachmentDescriptor[]> {
    if (attachmentIds.length > ATTACHMENT_LIMITS.maxPerTurn) {
      throw new TaskAttachmentError('too-many', '本轮附件数量超过上限。')
    }
    const unique = [...new Set(attachmentIds)]
    const drafts: TaskAttachmentDescriptor[] = []
    let total = 0
    for (const attachmentId of unique) {
      const descriptor = await this.getDescriptor(taskId, attachmentId)
      if (descriptor.binding !== 'draft') {
        throw new TaskAttachmentError('not-draft', '只能发送尚未绑定的附件。')
      }
      total += descriptor.byteSize
      if (total > ATTACHMENT_LIMITS.maxBytesPerTurn) {
        throw new TaskAttachmentError('too-large', '本轮附件总大小超过上限。')
      }
      drafts.push(descriptor)
    }

    const bound: TaskAttachmentDescriptor[] = []
    try {
      for (const descriptor of drafts) {
        const next: TaskAttachmentDescriptor = {
          ...descriptor,
          binding: 'bound',
          turnId
        }
        await this.writeMeta(taskId, next)
        bound.push(next)
      }
      return bound
    } catch (error) {
      // 批量绑定中途失败时恢复已经改写的 draft，避免输入框附件半绑定。
      await Promise.all(bound.map((descriptor) => this.writeMeta(taskId, toDraft(descriptor))))
      throw error
    }
  }

  /** admission 未提交时只回滚本轮用户附件；Runtime bound 附件不允许走此入口。 */
  async releaseTurnBindings(taskId: string, attachmentIds: string[], turnId: string): Promise<void> {
    const descriptors: TaskAttachmentDescriptor[] = []
    for (const attachmentId of [...new Set(attachmentIds)]) {
      const descriptor = await this.getDescriptor(taskId, attachmentId)
      if (
        descriptor.source !== 'user' ||
        descriptor.binding !== 'bound' ||
        descriptor.turnId !== turnId
      ) {
        throw new TaskAttachmentError('not-draft', '附件不属于本次待回滚 Turn。')
      }
      descriptors.push(descriptor)
    }
    for (const descriptor of descriptors) {
      await this.writeMeta(taskId, toDraft(descriptor))
    }
  }

  async removeDraft(taskId: string, attachmentId: string): Promise<void> {
    const descriptor = await this.getDescriptor(taskId, attachmentId)
    if (descriptor.binding !== 'draft') {
      throw new TaskAttachmentError('not-draft', '已发送的附件不能从输入框删除。')
    }
    await fs.rm(this.attachmentDirectory(taskId, attachmentId), { recursive: true, force: true })
  }

  async getPreview(
    taskId: string,
    attachmentId: string
  ): Promise<{
    descriptor: TaskAttachmentDescriptor
    thumbnailBytes?: Buffer
    thumbnailMime?: string
  }> {
    const descriptor = await this.getDescriptor(taskId, attachmentId)
    if (descriptor.kind !== 'image') return { descriptor }
    const bytes = await this.readBytes(taskId, attachmentId)
    const thumbnail = this.createThumbnail?.(bytes)
    if (!thumbnail) return { descriptor }
    return {
      descriptor,
      thumbnailBytes: thumbnail.bytes,
      thumbnailMime: thumbnail.mime
    }
  }

  /** 灯箱和大图下载只给原图字节和展示名，不暴露磁盘路径。 */
  async getOriginalImage(
    taskId: string,
    attachmentId: string
  ): Promise<{ originalName: string; mimeType: string; bytes: Buffer }> {
    const descriptor = await this.getDescriptor(taskId, attachmentId)
    if (descriptor.kind !== 'image') {
      throw new TaskAttachmentError('mime-mismatch', '只有图片可以打开原图。')
    }
    const bytes = await this.readBytes(taskId, attachmentId)
    return {
      originalName: descriptor.originalName,
      mimeType: descriptor.mimeType,
      bytes
    }
  }

  private async persist(
    taskId: string,
    originalName: string,
    bytes: Buffer,
    source: TaskAttachmentSource,
    binding: TaskAttachmentBinding = 'draft',
    turnId?: string,
    declaredMimeType?: string
  ): Promise<TaskAttachmentDescriptor> {
    const classified = classifyTaskAttachmentBytes({ originalName, bytes })
    if (!classified.ok) {
      throw new TaskAttachmentError(classified.reason, rejectMessage(classified.reason))
    }
    if (
      source === 'runtime' &&
      (classified.kind !== 'image' || classified.mimeType !== declaredMimeType)
    ) {
      throw new TaskAttachmentError('mime-mismatch', 'Runtime 图片类型校验失败。')
    }
    if (classified.kind === 'image') {
      const pixels = this.probeImagePixels?.(bytes)
      if (!pixels) throw new TaskAttachmentError('mime-mismatch', '无法解码该图片。')
      if (pixels.width * pixels.height > ATTACHMENT_LIMITS.maxImagePixels) {
        throw new TaskAttachmentError('too-many-pixels', '图片像素超过上限。')
      }
    }
    const existing = await this.listAll(taskId)
    const used = existing.reduce((sum, item) => sum + item.byteSize, 0)
    if (used + bytes.byteLength > this.maxInboxBytesPerTask) {
      throw new TaskAttachmentError('quota', '该对话附件柜已满。')
    }
    if (binding === 'draft') {
      if (
        existing.filter((item) => item.binding === 'draft').length >= ATTACHMENT_LIMITS.maxPerTurn
      ) {
        throw new TaskAttachmentError('too-many', '待发送附件数量超过上限。')
      }
    } else {
      const runtimeTurnItems = existing.filter(
        (item) =>
          item.source === 'runtime' && item.binding === 'bound' && item.turnId === turnId
      )
      if (runtimeTurnItems.length >= ATTACHMENT_LIMITS.maxPerTurn) {
        throw new TaskAttachmentError('too-many', '本轮 Runtime 图片数量超过上限。')
      }
      const runtimeTurnBytes = runtimeTurnItems.reduce((sum, item) => sum + item.byteSize, 0)
      if (runtimeTurnBytes + bytes.byteLength > ATTACHMENT_LIMITS.maxBytesPerTurn) {
        throw new TaskAttachmentError('too-large', '本轮 Runtime 图片总大小超过上限。')
      }
    }

    const attachmentId = this.createId()
    const storedName = sanitizeAttachmentFileName(classified.originalName)
    const directory = this.attachmentDirectory(taskId, attachmentId)
    const descriptor: TaskAttachmentDescriptor = {
      attachmentId,
      taskId,
      originalName: classified.originalName,
      storedName,
      kind: classified.kind,
      mimeType: classified.mimeType,
      byteSize: bytes.byteLength,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      source,
      binding,
      ...(turnId ? { turnId } : {}),
      createdAt: this.now(),
      availability: 'ready'
    }
    try {
      await this.writer.ensureDirectory(directory)
      const filePath = join(directory, storedName)
      await fs.writeFile(filePath, bytes, { mode: FILE_MODE })
      await fs.chmod(filePath, FILE_MODE).catch(() => undefined)
      await this.writeMeta(taskId, descriptor)
      return descriptor
    } catch (error) {
      // 文件或元数据任一步失败都清理本次目录，禁止留下不可索引的半成品附件。
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  private async assertNotInboxSource(taskId: string, resolvedPath: string): Promise<void> {
    const inboxRoot = this.inboxRoot(taskId)
    const inboxReal = await fs.realpath(inboxRoot).catch(() => null)
    if (!inboxReal) return
    if (isInsideDirectory(resolvedPath, inboxReal)) {
      throw new TaskAttachmentError('escaped', '不能把附件柜里的文件再导入一次。')
    }
  }

  private inboxRoot(taskId: string): string {
    return join(this.resolveTaskDirectory(taskId), 'inbox')
  }

  private attachmentDirectory(taskId: string, attachmentId: string): string {
    return join(this.inboxRoot(taskId), attachmentId)
  }

  private metaPath(taskId: string, attachmentId: string): string {
    return join(this.attachmentDirectory(taskId, attachmentId), 'meta.json')
  }

  private async writeMeta(taskId: string, descriptor: TaskAttachmentDescriptor): Promise<void> {
    await this.writer.write(this.metaPath(taskId, descriptor.attachmentId), descriptor)
  }

  private async readMeta(
    taskId: string,
    attachmentId: string
  ): Promise<TaskAttachmentDescriptor | null> {
    try {
      const value = await this.writer.read(this.metaPath(taskId, attachmentId), META_MAX_BYTES)
      return parseDescriptor(value, taskId)
    } catch {
      return null
    }
  }
}

/** 将已绑定附件恢复为草稿，同时移除旧 Turn 身份，避免失败重试串入上一轮。 */
function toDraft(descriptor: TaskAttachmentDescriptor): TaskAttachmentDescriptor {
  const draft = { ...descriptor, binding: 'draft' as const }
  delete draft.turnId
  return draft
}

function rejectMessage(reason: TaskAttachmentRejectReason): string {
  if (reason === 'empty') return '不能导入空文件。'
  if (reason === 'too-large') return '文件超过大小上限。'
  if (reason === 'mime-mismatch') return '文件类型与扩展名不一致。'
  if (reason === 'nul' || reason === 'binary-text') return '文本附件必须是 UTF-8。'
  if (reason === 'invalid-name') return '文件名无效。'
  return '不支持该文件类型。'
}
