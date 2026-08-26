import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, relative, resolve } from 'node:path'
import { isSafeRelativePosixPath, type TaskChangeSetQueryResult } from '../../shared/git-review'
import {
  ATTACHMENT_LIMITS,
  classifyTaskAttachmentBytes,
  isChangeMediaPreviewPath,
  type TaskAttachmentDescriptor
} from '../../shared/task-attachment'
import type { TaskAttachmentPreview } from '../../shared/task-ipc'
import { TaskAttachmentError } from './task-attachment-inbox'

export interface TaskChangeMediaPreviewOptions {
  getChangeSet: (taskId: string) => Promise<TaskChangeSetQueryResult>
  getExecutionRoot: (taskId: string) => string | null
  createImageThumbnail?: (bytes: Buffer) => { bytes: Buffer; mime: string } | null
}

function isInsideDirectory(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && rel !== '..')
}

/**
 * 只为当前 ChangeSet 内的图片/PDF生成预览；绝不接受任意 Renderer 文件读取。
 */
export class TaskChangeMediaPreviewService {
  constructor(private readonly options: TaskChangeMediaPreviewOptions) {}

  async getPreview(taskId: string, path: string): Promise<TaskAttachmentPreview> {
    if (!isSafeRelativePosixPath(path) || !isChangeMediaPreviewPath(path)) {
      throw new TaskAttachmentError('unsupported-type', '该变更不支持媒体预览。')
    }

    const changeSet = await this.options.getChangeSet(taskId)
    if (!changeSet.paths.some((item) => item.path === path)) {
      throw new TaskAttachmentError('not-found', '该路径不在当前变更集中。')
    }

    const executionRoot = this.options.getExecutionRoot(taskId)
    if (!executionRoot) throw new TaskAttachmentError('not-found', 'Task execution root 不可用。')
    const rootRealPath = await fs.realpath(executionRoot).catch(() => null)
    if (!rootRealPath) throw new TaskAttachmentError('not-found', 'Task execution root 不可用。')
    const candidate = resolve(rootRealPath, ...path.split('/'))
    if (!isInsideDirectory(candidate, rootRealPath)) {
      throw new TaskAttachmentError('escaped', '变更路径越出 execution root。')
    }
    const resolvedPath = await fs.realpath(candidate).catch(() => null)
    if (!resolvedPath || !isInsideDirectory(resolvedPath, rootRealPath)) {
      throw new TaskAttachmentError('escaped', '变更文件越出 execution root。')
    }
    const stats = await fs.stat(resolvedPath).catch(() => null)
    if (!stats?.isFile()) throw new TaskAttachmentError('not-file', '变更媒体不是普通文件。')
    if (stats.size > ATTACHMENT_LIMITS.maxBytesPerFile) {
      throw new TaskAttachmentError('too-large', '变更媒体超过预览大小上限。')
    }

    const bytes = await fs.readFile(resolvedPath)
    const originalName = basename(path)
    const classified = classifyTaskAttachmentBytes({ originalName, bytes })
    if (!classified.ok || (classified.kind !== 'image' && classified.kind !== 'pdf')) {
      throw new TaskAttachmentError('mime-mismatch', '变更媒体类型校验失败。')
    }
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    const descriptor: TaskAttachmentDescriptor = {
      attachmentId: `change-${contentHash.slice(0, 24)}`,
      taskId,
      originalName: classified.originalName,
      storedName: classified.originalName,
      kind: classified.kind,
      mimeType: classified.mimeType,
      byteSize: bytes.byteLength,
      contentHash,
      source: 'runtime',
      binding: 'bound',
      createdAt: changeSet.generatedAt,
      availability: 'ready'
    }
    const thumbnail =
      classified.kind === 'image' ? this.options.createImageThumbnail?.(bytes) : null
    return {
      descriptor,
      ...(thumbnail
        ? {
            thumbnailBase64: thumbnail.bytes.toString('base64'),
            thumbnailMime: thumbnail.mime
          }
        : {})
    }
  }
}
