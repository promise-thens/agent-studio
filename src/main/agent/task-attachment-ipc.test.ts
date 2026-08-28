import { describe, expect, it, vi } from 'vitest'
import type { TaskAttachmentDescriptor } from '../../shared/task-attachment'
import { TASK_INVOKE_CHANNELS, type TaskAttachmentPreview } from '../../shared/task-ipc'
import type { DesktopIpcResult } from '../../shared/ipc-result'
import type { DesktopIpcHandler } from '../ipc-types'
import { DesktopIpcFailure, type TrustedIpcInvokeEvent } from '../security/ipc-sender-validation'
import { registerTaskAttachmentIpcHandlers } from './task-attachment-ipc'
import type { TaskAttachmentInbox } from './task-attachment-inbox'

const event = {} as TrustedIpcInvokeEvent

function descriptor(overrides: Partial<TaskAttachmentDescriptor> = {}): TaskAttachmentDescriptor {
  return {
    attachmentId: 'att-1',
    taskId: 'task-1',
    originalName: 'preview.png',
    storedName: 'preview.png',
    kind: 'image',
    mimeType: 'image/png',
    byteSize: 12,
    contentHash: 'a'.repeat(64),
    source: 'user',
    binding: 'draft',
    createdAt: '2026-08-25T00:00:00.000Z',
    availability: 'ready',
    ...overrides
  }
}

function createFixture(): {
  handlers: Map<string, DesktopIpcHandler>
  inbox: {
    importPath: ReturnType<typeof vi.fn>
    importBytes: ReturnType<typeof vi.fn>
    listDrafts: ReturnType<typeof vi.fn>
    removeDraft: ReturnType<typeof vi.fn>
    getPreview: ReturnType<typeof vi.fn>
    getOriginalImage: ReturnType<typeof vi.fn>
  }
  assertTrustedSender: ReturnType<typeof vi.fn>
  getChangeMediaPreview: ReturnType<typeof vi.fn>
  invoke: <T>(channel: string, request: unknown) => Promise<DesktopIpcResult<T>>
} {
  const handlers = new Map<string, DesktopIpcHandler>()
  const inbox = {
    importPath: vi.fn(async () => descriptor()),
    importBytes: vi.fn(async () => descriptor()),
    listDrafts: vi.fn(async () => [descriptor()]),
    removeDraft: vi.fn(async () => undefined),
    getPreview: vi.fn(async () => ({
      descriptor: descriptor(),
      thumbnailBytes: Buffer.from('thumb'),
      thumbnailMime: 'image/jpeg'
    })),
    getOriginalImage: vi.fn(async () => ({
      originalName: 'preview.png',
      mimeType: 'image/png',
      bytes: Buffer.from('png-bytes')
    }))
  }
  const assertTrustedSender = vi.fn()
  const getChangeMediaPreview = vi.fn(
    async (taskId: string, path: string): Promise<TaskAttachmentPreview> => ({
      descriptor: descriptor({ taskId, originalName: path, storedName: path })
    })
  )
  registerTaskAttachmentIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    assertTrustedSender,
    sanitizeError: (error) => (error instanceof Error ? error.message : String(error)),
    getInbox: () => inbox as unknown as TaskAttachmentInbox,
    pickFiles: async () => ['/tmp/a.png'],
    readClipboard: async () => [{ originalName: 'clipboard.png', bytes: Buffer.from('png') }],
    getChangeMediaPreview
  })
  return {
    handlers,
    inbox,
    assertTrustedSender,
    getChangeMediaPreview,
    invoke: async <T>(channel: string, request: unknown) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`缺少 Handler: ${channel}`)
      return (await handler(event, request)) as DesktopIpcResult<T>
    }
  }
}

describe('Task 附件 IPC', () => {
  it('只注册固定附件通道，并在参数读取前校验发送方', async () => {
    const fixture = createFixture()
    expect([...fixture.handlers.keys()]).toEqual([
      TASK_INVOKE_CHANNELS.pickAttachments,
      TASK_INVOKE_CHANNELS.importDroppedPaths,
      TASK_INVOKE_CHANNELS.importClipboard,
      TASK_INVOKE_CHANNELS.listDraftAttachments,
      TASK_INVOKE_CHANNELS.removeAttachment,
      TASK_INVOKE_CHANNELS.getAttachmentPreview,
      TASK_INVOKE_CHANNELS.getAttachmentImage,
      TASK_INVOKE_CHANNELS.getChangeMediaPreview
    ])
    fixture.assertTrustedSender.mockImplementationOnce(() => {
      throw new DesktopIpcFailure('forbidden', '拒绝此 IPC 调用。')
    })
    await expect(
      fixture.invoke(TASK_INVOKE_CHANNELS.importDroppedPaths, {
        taskId: 'task-1',
        paths: ['/tmp/a.png']
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(fixture.inbox.importPath).not.toHaveBeenCalled()
  })

  it('拖放和剪贴板只把主进程已取得的路径或字节交给 inbox', async () => {
    const fixture = createFixture()
    await fixture.invoke(TASK_INVOKE_CHANNELS.importDroppedPaths, {
      taskId: 'task-1',
      paths: ['/tmp/a.png']
    })
    await fixture.invoke(TASK_INVOKE_CHANNELS.importClipboard, { taskId: 'task-1' })
    expect(fixture.inbox.importPath).toHaveBeenCalledWith({
      taskId: 'task-1',
      filePath: '/tmp/a.png'
    })
    expect(fixture.inbox.importBytes).toHaveBeenCalledWith({
      taskId: 'task-1',
      originalName: 'clipboard.png',
      bytes: Buffer.from('png')
    })
  })

  it('附件预览只返回描述符和 base64 缩略图，不返回路径', async () => {
    const fixture = createFixture()
    const result = await fixture.invoke<TaskAttachmentPreview>(
      TASK_INVOKE_CHANNELS.getAttachmentPreview,
      { taskId: 'task-1', attachmentId: 'att-1' }
    )
    expect(result).toMatchObject({
      ok: true,
      value: {
        descriptor: { attachmentId: 'att-1' },
        thumbnailBase64: Buffer.from('thumb').toString('base64'),
        thumbnailMime: 'image/jpeg'
      }
    })
    expect(JSON.stringify(result)).not.toContain('/tmp')
  })

  it('原图查询只返回文件名、MIME 和 base64，不返回路径', async () => {
    const fixture = createFixture()
    const result = await fixture.invoke(TASK_INVOKE_CHANNELS.getAttachmentImage, {
      taskId: 'task-1',
      attachmentId: 'att-1'
    })
    expect(result).toMatchObject({
      ok: true,
      value: {
        originalName: 'preview.png',
        mimeType: 'image/png',
        imageBase64: Buffer.from('png-bytes').toString('base64')
      }
    })
    expect(JSON.stringify(result)).not.toContain('/tmp')
    expect(fixture.inbox.getOriginalImage).toHaveBeenCalledWith('task-1', 'att-1')
  })

  it('变更媒体路径必须通过窄参数校验后才委托安全预览服务', async () => {
    const fixture = createFixture()
    await fixture.invoke(TASK_INVOKE_CHANNELS.getChangeMediaPreview, {
      taskId: 'task-1',
      path: 'out/preview.png'
    })
    expect(fixture.getChangeMediaPreview).toHaveBeenCalledWith('task-1', 'out/preview.png')

    const rejected = await fixture.invoke(TASK_INVOKE_CHANNELS.getChangeMediaPreview, {
      taskId: 'task-1',
      path: 'bad\0.png'
    })
    expect(rejected).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(fixture.getChangeMediaPreview).toHaveBeenCalledTimes(1)
  })
})
