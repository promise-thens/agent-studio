import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskChangeSetQueryResult } from '../../shared/git-review'
import { TaskChangeMediaPreviewService } from './task-change-media-preview'

const temporaryDirectories: string[] = []
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const PDF = Buffer.from('%PDF-1.7\n')

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-studio-change-media-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

function changeSet(paths: string[]): TaskChangeSetQueryResult {
  return {
    taskId: 'task-1',
    environmentId: 'environment-1',
    baselineStatus: 'captured',
    gitPresence: 'git',
    generatedAt: '2026-08-25T00:00:00.000Z',
    paths: paths.map((path) => ({ path, attribution: 'task-added' as const })),
    revertible: false,
    preExistingCount: 0,
    taskChangedCount: paths.length,
    unknownCount: 0,
    validations: []
  }
}

describe('TaskChangeMediaPreviewService', () => {
  it('只读取当前 ChangeSet 内且仍位于 execution root 的图片', async () => {
    const root = await createTemporaryDirectory()
    await mkdir(join(root, 'out'), { recursive: true })
    await writeFile(join(root, 'out', 'preview.png'), PNG)
    const service = new TaskChangeMediaPreviewService({
      getChangeSet: async () => changeSet(['out/preview.png']),
      getExecutionRoot: () => root,
      createImageThumbnail: () => ({ bytes: Buffer.from('thumb'), mime: 'image/jpeg' })
    })

    await expect(service.getPreview('task-1', 'out/preview.png')).resolves.toMatchObject({
      descriptor: {
        taskId: 'task-1',
        originalName: 'preview.png',
        kind: 'image',
        mimeType: 'image/png',
        source: 'runtime',
        binding: 'bound'
      },
      thumbnailBase64: Buffer.from('thumb').toString('base64'),
      thumbnailMime: 'image/jpeg'
    })
  })

  it('PDF 通过同一安全读取链路，但不伪造页面位图', async () => {
    const root = await createTemporaryDirectory()
    await writeFile(join(root, 'report.pdf'), PDF)
    const service = new TaskChangeMediaPreviewService({
      getChangeSet: async () => changeSet(['report.pdf']),
      getExecutionRoot: () => root
    })

    const preview = await service.getPreview('task-1', 'report.pdf')
    expect(preview.descriptor).toMatchObject({ kind: 'pdf', mimeType: 'application/pdf' })
    expect(preview).not.toHaveProperty('thumbnailBase64')
  })

  it('拒绝不在 ChangeSet 的路径和逃出 execution root 的符号链接', async () => {
    const root = await createTemporaryDirectory()
    const outside = await createTemporaryDirectory()
    await writeFile(join(root, 'hidden.png'), PNG)
    await writeFile(join(outside, 'secret.png'), PNG)
    await symlink(join(outside, 'secret.png'), join(root, 'linked.png'))
    const service = new TaskChangeMediaPreviewService({
      getChangeSet: async () => changeSet(['linked.png']),
      getExecutionRoot: () => root
    })

    await expect(service.getPreview('task-1', 'hidden.png')).rejects.toMatchObject({
      code: 'not-found'
    })
    await expect(service.getPreview('task-1', 'linked.png')).rejects.toMatchObject({
      code: 'escaped'
    })
  })
})
