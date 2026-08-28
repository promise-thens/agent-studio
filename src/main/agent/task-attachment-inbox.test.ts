import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AtomicJsonWriter } from '../storage/atomic-json-file'
import { TaskAttachmentInbox } from './task-attachment-inbox'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-studio-inbox-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

function createInbox(root: string, ids: string[] = ['att-1', 'att-2', 'att-3']): TaskAttachmentInbox {
  let next = 0
  return new TaskAttachmentInbox({
    resolveTaskDirectory: (taskId) => join(root, taskId),
    createId: () => ids[next++] ?? `att-${next}`,
    now: () => '2026-08-23T00:00:00.000Z',
    probeImagePixels: () => ({ width: 8, height: 8 })
  })
}

describe('TaskAttachmentInbox', () => {
  it('把字节写入 Task inbox 并返回不含路径的描述符', async () => {
    const root = await createTemporaryDirectory()
    const inbox = createInbox(root)
    const descriptor = await inbox.importBytes({
      taskId: 'task-1',
      originalName: 'Shot.PNG',
      bytes: PNG
    })
    expect(descriptor).toMatchObject({
      attachmentId: 'att-1',
      taskId: 'task-1',
      originalName: 'Shot.PNG',
      kind: 'image',
      mimeType: 'image/png',
      source: 'user',
      binding: 'draft',
      availability: 'ready'
    })
    expect(descriptor).not.toHaveProperty('path')
    const listed = await inbox.listDrafts('task-1')
    expect(listed).toHaveLength(1)
    expect((await inbox.readBytes('task-1', 'att-1')).equals(PNG)).toBe(true)
  })

  it('拷贝普通文件、拒绝符号链接，并把 draft 绑定到 Turn', async () => {
    const root = await createTemporaryDirectory()
    const inbox = createInbox(root)
    const file = join(root, 'note.md')
    await writeFile(file, '# hi\n')
    const imported = await inbox.importPath({ taskId: 'task-1', filePath: file })
    expect(imported.kind).toBe('text')

    const link = join(root, 'link.md')
    await symlink(file, link)
    await expect(inbox.importPath({ taskId: 'task-1', filePath: link })).rejects.toMatchObject({
      code: 'not-file'
    })

    const bound = await inbox.bindToTurn('task-1', ['att-1'], 'turn-1')
    expect(bound[0]?.binding).toBe('bound')
    expect(bound[0]?.turnId).toBe('turn-1')
    expect(await inbox.listDrafts('task-1')).toEqual([])
    await inbox.releaseTurnBindings('task-1', ['att-1'], 'turn-1')
    expect(await inbox.listDrafts('task-1')).toMatchObject([
      { attachmentId: 'att-1', binding: 'draft' }
    ])
  })

  it('删除 draft、拦截把 inbox 当拖入源，并拒绝超量图片像素', async () => {
    const root = await createTemporaryDirectory()
    const inbox = new TaskAttachmentInbox({
      resolveTaskDirectory: (taskId) => join(root, taskId),
      createId: () => 'att-1',
      now: () => '2026-08-23T00:00:00.000Z',
      probeImagePixels: () => ({ width: 5000, height: 5000 })
    })
    await expect(
      inbox.importBytes({ taskId: 'task-1', originalName: 'a.png', bytes: PNG })
    ).rejects.toMatchObject({ code: 'too-many-pixels' })

    const okInbox = createInbox(root)
    const saved = await okInbox.importBytes({
      taskId: 'task-1',
      originalName: 'a.png',
      bytes: PNG
    })
    const nested = join(root, 'task-1', 'inbox', saved.attachmentId, saved.storedName)
    await expect(okInbox.importPath({ taskId: 'task-1', filePath: nested })).rejects.toMatchObject({
      code: 'escaped'
    })
    await okInbox.removeDraft('task-1', saved.attachmentId)
    expect(await okInbox.listDrafts('task-1')).toEqual([])
  })

  it('Runtime 图片原子绑定到 Turn，且不占用用户 draft 名额', async () => {
    const root = await createTemporaryDirectory()
    const ids = Array.from({ length: 9 }, (_, index) => `att-${index + 1}`)
    const inbox = createInbox(root, ids)
    for (let index = 0; index < 8; index += 1) {
      await inbox.importBytes({
        taskId: 'task-1',
        originalName: `user-${index}.png`,
        bytes: PNG
      })
    }

    const descriptor = await inbox.importRuntimeBytes({
      taskId: 'task-1',
      turnId: 'turn-runtime',
      originalName: 'runtime-image.png',
      mimeType: 'image/png',
      bytes: PNG
    })

    expect(descriptor).toMatchObject({
      attachmentId: 'att-9',
      source: 'runtime',
      binding: 'bound',
      turnId: 'turn-runtime',
      kind: 'image'
    })
    expect(await inbox.listDrafts('task-1')).toHaveLength(8)
    expect((await inbox.getPreview('task-1', descriptor.attachmentId)).descriptor).toEqual(
      descriptor
    )
    await expect(inbox.getOriginalImage('task-1', descriptor.attachmentId)).resolves.toEqual({
      originalName: 'runtime-image.png',
      mimeType: 'image/png',
      bytes: PNG
    })
  })

  it('Runtime 图片使用独立的每 Turn 数量限制', async () => {
    const root = await createTemporaryDirectory()
    const ids = Array.from({ length: 9 }, (_, index) => `runtime-${index + 1}`)
    const inbox = createInbox(root, ids)
    for (let index = 0; index < 8; index += 1) {
      await inbox.importRuntimeBytes({
        taskId: 'task-1',
        turnId: 'turn-runtime',
        originalName: `runtime-${index}.png`,
        mimeType: 'image/png',
        bytes: PNG
      })
    }

    await expect(
      inbox.importRuntimeBytes({
        taskId: 'task-1',
        turnId: 'turn-runtime',
        originalName: 'runtime-overflow.png',
        mimeType: 'image/png',
        bytes: PNG
      })
    ).rejects.toMatchObject({ code: 'too-many' })
  })

  it('Runtime 元数据写入失败时清理半成品目录', async () => {
    const root = await createTemporaryDirectory()
    const inbox = new TaskAttachmentInbox({
      resolveTaskDirectory: (taskId) => join(root, taskId),
      createId: () => 'runtime-failed',
      probeImagePixels: () => ({ width: 8, height: 8 }),
      writer: new AtomicJsonWriter({
        fileSystem: {
          rename: async () => {
            throw new Error('模拟元数据提交失败')
          }
        }
      })
    })

    await expect(
      inbox.importRuntimeBytes({
        taskId: 'task-1',
        turnId: 'turn-runtime',
        originalName: 'runtime-image.png',
        mimeType: 'image/png',
        bytes: PNG
      })
    ).rejects.toThrow('模拟元数据提交失败')
    const entries = await readdir(join(root, 'task-1', 'inbox')).catch(() => [])
    expect(entries).toEqual([])
  })
})

describe('TaskAttachmentInbox 配额', () => {
  it('单 Task 超过 inbox 总字节时拒绝', async () => {
    const root = await createTemporaryDirectory()
    const inbox = new TaskAttachmentInbox({
      resolveTaskDirectory: (taskId) => join(root, taskId),
      createId: () => 'att-1',
      now: () => '2026-08-23T00:00:00.000Z',
      maxInboxBytesPerTask: 8
    })
    await expect(
      inbox.importBytes({ taskId: 'task-1', originalName: 'a.md', bytes: Buffer.from('# too big') })
    ).rejects.toMatchObject({ code: 'quota' })
  })
})
