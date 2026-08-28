import { ATTACHMENT_LIMITS, type TaskAttachmentDescriptor } from '../../shared/task-attachment'
import type { DesktopIpcResult } from '../../shared/ipc-result'
import {
  TASK_INVOKE_CHANNELS,
  type TaskAttachmentImage,
  type TaskAttachmentPreview
} from '../../shared/task-ipc'
import type { DesktopIpcMain } from '../ipc-types'
import {
  DesktopIpcFailure,
  runDesktopIpcOperation,
  type TrustedIpcInvokeEvent
} from '../security/ipc-sender-validation'
import { TaskAttachmentError, type TaskAttachmentInbox } from './task-attachment-inbox'

const MAX_REQUEST_BYTES = 32 * 1024
const MAX_TASK_ID_BYTES = 4 * 1024
const MAX_PATH_BYTES = 16 * 1024

export interface TaskAttachmentIpcDependencies {
  ipcMain: DesktopIpcMain
  assertTrustedSender: (event: TrustedIpcInvokeEvent) => void
  sanitizeError: (error: unknown) => string
  getInbox: () => TaskAttachmentInbox | null
  pickFiles: () => Promise<string[] | null>
  readClipboard: () => Promise<Array<{ originalName: string; bytes: Buffer }>>
  getChangeMediaPreview?: (taskId: string, path: string) => Promise<TaskAttachmentPreview>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readRequest(args: unknown[], allowedFields: readonly string[]): Record<string, unknown> {
  if (args.length !== 1 || !isPlainObject(args[0])) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  let serialized: string
  try {
    serialized = JSON.stringify(args[0])
  } catch {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) {
    throw new DesktopIpcFailure('payload-too-large', '请求内容过大。')
  }
  const allowed = new Set(allowedFields)
  if (Object.keys(args[0]).some((field) => !allowed.has(field))) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  return args[0]
}

function readText(request: Record<string, unknown>, field: string): string {
  const value = request[field]
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_TASK_ID_BYTES && field !== 'path') {
    throw new DesktopIpcFailure('payload-too-large', '请求内容过大。')
  }
  return value
}

function readPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > ATTACHMENT_LIMITS.maxPerTurn) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  return value.map((item) => {
    if (typeof item !== 'string' || !item.trim() || item.includes('\0')) {
      throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    }
    if (Buffer.byteLength(item, 'utf8') > MAX_PATH_BYTES) {
      throw new DesktopIpcFailure('payload-too-large', '请求内容过大。')
    }
    return item
  })
}

function requireInbox(getInbox: () => TaskAttachmentInbox | null): TaskAttachmentInbox {
  const inbox = getInbox()
  if (!inbox) throw new DesktopIpcFailure('runtime-unavailable', '附件柜尚未初始化。')
  return inbox
}

function toPreview(
  descriptor: TaskAttachmentDescriptor,
  thumbnailBytes?: Buffer,
  thumbnailMime?: string
): TaskAttachmentPreview {
  const preview: TaskAttachmentPreview = { descriptor }
  if (thumbnailBytes && thumbnailMime) {
    preview.thumbnailBase64 = thumbnailBytes.toString('base64')
    preview.thumbnailMime = thumbnailMime
  }
  return preview
}

function mapAttachmentError(error: unknown): never {
  if (error instanceof TaskAttachmentError) {
    const code =
      error.code === 'too-large' || error.code === 'quota' ? 'payload-too-large' : 'invalid-input'
    throw new DesktopIpcFailure(code, error.message)
  }
  throw error
}

/** 注册附件柜 IPC：Renderer 只提交 taskId / 路径 / attachmentId。 */
export function registerTaskAttachmentIpcHandlers(
  dependencies: TaskAttachmentIpcDependencies
): void {
  const register = <T>(channel: string, operation: (args: unknown[]) => Promise<T> | T): void => {
    dependencies.ipcMain.handle(channel, (event, ...args): Promise<DesktopIpcResult<T>> =>
      runDesktopIpcOperation(async () => {
        dependencies.assertTrustedSender(event)
        try {
          return await operation(args)
        } catch (error) {
          mapAttachmentError(error)
        }
      }, dependencies.sanitizeError)
    )
  }

  register(TASK_INVOKE_CHANNELS.pickAttachments, async (args) => {
    const request = readRequest(args, ['taskId'])
    const taskId = readText(request, 'taskId')
    const paths = await dependencies.pickFiles()
    if (!paths || paths.length === 0) return []
    const inbox = requireInbox(dependencies.getInbox)
    const imported: TaskAttachmentDescriptor[] = []
    for (const filePath of paths.slice(0, ATTACHMENT_LIMITS.maxPerTurn)) {
      imported.push(await inbox.importPath({ taskId, filePath }))
    }
    return imported
  })

  register(TASK_INVOKE_CHANNELS.importDroppedPaths, async (args) => {
    const request = readRequest(args, ['taskId', 'paths'])
    const taskId = readText(request, 'taskId')
    const inbox = requireInbox(dependencies.getInbox)
    const imported: TaskAttachmentDescriptor[] = []
    for (const filePath of readPaths(request.paths)) {
      imported.push(await inbox.importPath({ taskId, filePath }))
    }
    return imported
  })

  register(TASK_INVOKE_CHANNELS.importClipboard, async (args) => {
    const request = readRequest(args, ['taskId'])
    const taskId = readText(request, 'taskId')
    const items = await dependencies.readClipboard()
    const inbox = requireInbox(dependencies.getInbox)
    const imported: TaskAttachmentDescriptor[] = []
    for (const item of items.slice(0, ATTACHMENT_LIMITS.maxPerTurn)) {
      imported.push(
        await inbox.importBytes({
          taskId,
          originalName: item.originalName,
          bytes: item.bytes
        })
      )
    }
    return imported
  })

  register(TASK_INVOKE_CHANNELS.listDraftAttachments, async (args) => {
    const request = readRequest(args, ['taskId'])
    return requireInbox(dependencies.getInbox).listDrafts(readText(request, 'taskId'))
  })

  register(TASK_INVOKE_CHANNELS.removeAttachment, async (args) => {
    const request = readRequest(args, ['taskId', 'attachmentId'])
    await requireInbox(dependencies.getInbox).removeDraft(
      readText(request, 'taskId'),
      readText(request, 'attachmentId')
    )
    return null
  })

  register(TASK_INVOKE_CHANNELS.getAttachmentPreview, async (args) => {
    const request = readRequest(args, ['taskId', 'attachmentId'])
    const preview = await requireInbox(dependencies.getInbox).getPreview(
      readText(request, 'taskId'),
      readText(request, 'attachmentId')
    )
    return toPreview(preview.descriptor, preview.thumbnailBytes, preview.thumbnailMime)
  })

  register(TASK_INVOKE_CHANNELS.getAttachmentImage, async (args) => {
    const request = readRequest(args, ['taskId', 'attachmentId'])
    const image = await requireInbox(dependencies.getInbox).getOriginalImage(
      readText(request, 'taskId'),
      readText(request, 'attachmentId')
    )
    const payload: TaskAttachmentImage = {
      originalName: image.originalName,
      mimeType: image.mimeType,
      imageBase64: image.bytes.toString('base64')
    }
    return payload
  })

  register(TASK_INVOKE_CHANNELS.getChangeMediaPreview, async (args) => {
    const request = readRequest(args, ['taskId', 'path'])
    const path = request.path
    if (typeof path !== 'string' || !path.trim() || path.includes('\0')) {
      throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    }
    if (!dependencies.getChangeMediaPreview) {
      throw new DesktopIpcFailure('runtime-unavailable', '变更预览尚未初始化。')
    }
    return dependencies.getChangeMediaPreview(readText(request, 'taskId'), path)
  })
}
