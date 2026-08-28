import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { artifactLocationKey } from '../../shared/artifact'
import { ArtifactRegistry, ArtifactRegistryError } from './artifact-registry'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-studio-artifact-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function createRegistry(options: { createId?: () => string } = {}): Promise<{
  registry: ArtifactRegistry
  executionRoot: string
  taskDirectory: string
  attached: Array<{ taskId: string; turnId: string; artifactIds: string[] }>
}> {
  const executionRoot = await createTemporaryDirectory()
  const taskDirectory = await createTemporaryDirectory()
  const attached: Array<{ taskId: string; turnId: string; artifactIds: string[] }> = []
  let id = 0
  const registry = new ArtifactRegistry({
    getTaskContext: (taskId) => {
      if (taskId !== 'task-1') throw new ArtifactRegistryError('not-found', '未找到指定 Task。')
      return {
        projectId: 'project-1',
        taskId: 'task-1',
        environmentId: 'local:env-1',
        executionRoot,
        lastTurnId: 'turn-1',
        taskDirectory
      }
    },
    attachTurnArtifactIds: async (taskId, turnId, artifactIds) => {
      attached.push({ taskId, turnId, artifactIds })
    },
    createId: options.createId ?? (() => `art-${++id}`),
    now: () => '2026-08-28T00:00:00.000Z',
    probeImagePixels: () => ({ width: 8, height: 8 })
  })
  return { registry, executionRoot, taskDirectory, attached }
}

describe('ArtifactRegistry', () => {
  it('注册 Local 文本文件后只持久化描述符，不含绝对路径', async () => {
    const { registry, executionRoot, taskDirectory, attached } = await createRegistry()
    await writeFile(join(executionRoot, 'note.md'), '# hello\n', { mode: 0o600 })

    const descriptor = await registry.registerFileCandidate({
      taskId: 'task-1',
      turnId: 'turn-1',
      source: 'git-review',
      relativePath: 'note.md'
    })

    expect(descriptor).toMatchObject({
      artifactId: 'art-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      kind: 'markdown',
      title: 'note.md',
      availability: 'ready',
      trustLevel: 'verified',
      revision: 1,
      location: { kind: 'file', relativePath: 'note.md' }
    })
    expect(JSON.stringify(descriptor)).not.toContain(executionRoot)
    expect(attached).toEqual([{ taskId: 'task-1', turnId: 'turn-1', artifactIds: ['art-1'] }])

    const listed = await registry.list('task-1')
    expect(listed).toHaveLength(1)
    const persisted = JSON.parse(
      await readFile(join(taskDirectory, 'artifacts', 'art-1.json'), 'utf8')
    ) as { location: { relativePath: string } }
    expect(persisted.location.relativePath).toBe('note.md')
    expect(JSON.stringify(persisted)).not.toContain(executionRoot)
  })

  it('拒绝符号链接逃逸、目录、扩展名冲突和越界路径', async () => {
    const { registry, executionRoot } = await createRegistry()
    const outside = await createTemporaryDirectory()
    await writeFile(join(outside, 'secret.txt'), 'secret', { mode: 0o600 })
    await symlink(join(outside, 'secret.txt'), join(executionRoot, 'link.txt'))
    await mkdir(join(executionRoot, 'folder'))
    await writeFile(join(executionRoot, 'fake.png'), '# not an image', { mode: 0o600 })

    await expect(
      registry.registerFileCandidate({
        taskId: 'task-1',
        source: 'git-review',
        relativePath: 'link.txt'
      })
    ).rejects.toMatchObject({ code: 'escaped' })
    await expect(
      registry.registerFileCandidate({
        taskId: 'task-1',
        source: 'git-review',
        relativePath: 'folder'
      })
    ).rejects.toMatchObject({ code: 'not-file' })
    await expect(
      registry.registerFileCandidate({
        taskId: 'task-1',
        source: 'git-review',
        relativePath: '../secret.txt'
      })
    ).rejects.toMatchObject({ code: 'invalid-path' })
    await expect(
      registry.registerFileCandidate({
        taskId: 'task-1',
        source: 'git-review',
        relativePath: 'fake.png'
      })
    ).rejects.toMatchObject({ code: 'mime-mismatch' })
  })

  it('同文件新内容提升 revision 并保留同一 artifactId', async () => {
    const { registry, executionRoot } = await createRegistry()
    const file = join(executionRoot, 'note.md')
    await writeFile(file, '# v1\n', { mode: 0o600 })
    const first = await registry.registerFileCandidate({
      taskId: 'task-1',
      source: 'git-review',
      relativePath: 'note.md'
    })
    await writeFile(file, '# v2\n', { mode: 0o600 })
    const second = await registry.registerFileCandidate({
      taskId: 'task-1',
      source: 'git-review',
      relativePath: 'note.md'
    })
    expect(second.artifactId).toBe(first.artifactId)
    expect(second.revision).toBe(first.revision + 1)
    expect(second.contentHash).not.toBe(first.contentHash)
  })

  it('源文件删除或改写后保留元数据并更新 availability', async () => {
    const { registry, executionRoot } = await createRegistry()
    const file = join(executionRoot, 'note.md')
    await writeFile(file, '# hello\n', { mode: 0o600 })
    await registry.registerFileCandidate({
      taskId: 'task-1',
      source: 'git-review',
      relativePath: 'note.md'
    })
    await rm(file)
    const missing = await registry.list('task-1')
    expect(missing[0]).toMatchObject({ availability: 'missing', title: 'note.md' })

    await writeFile(file, '# changed\n', { mode: 0o600 })
    const changed = await registry.list('task-1')
    expect(changed[0]).toMatchObject({ availability: 'changed' })
    expect(changed[0].revision).toBeGreaterThan(1)
  })

  it('删除 Artifact 元数据不会删除项目文件', async () => {
    const { registry, executionRoot, taskDirectory } = await createRegistry()
    const file = join(executionRoot, 'note.md')
    await writeFile(file, '# keep\n', { mode: 0o600 })
    await registry.registerFileCandidate({
      taskId: 'task-1',
      source: 'git-review',
      relativePath: 'note.md'
    })
    await rm(join(taskDirectory, 'artifacts'), { recursive: true, force: true })
    expect(await readFile(file, 'utf8')).toBe('# keep\n')
    expect(await registry.list('task-1')).toEqual([])
  })

  it('从 change set 同步 Markdown/图片文件和 Diff 引用', async () => {
    const { registry, executionRoot } = await createRegistry()
    await writeFile(join(executionRoot, 'note.md'), '# hi\n', { mode: 0o600 })
    await registry.syncFromChangeSet('task-1', {
      paths: [
        { path: 'note.md', attribution: 'task-added' },
        { path: 'src/app.ts', attribution: 'task-modified' },
        { path: 'legacy.txt', attribution: 'pre-existing' }
      ]
    })
    const listed = await registry.list('task-1')
    expect(
      listed.map((item) => `${item.kind}:${artifactLocationKey(item.location)}`).sort()
    ).toEqual(['diff:diff:note.md', 'diff:diff:src/app.ts', 'markdown:file:note.md'].sort())
  })

  it('Diff 产物只保存相对路径引用，不读文件正文', async () => {
    const { registry, executionRoot } = await createRegistry()
    const descriptor = await registry.registerDiffCandidate({
      taskId: 'task-1',
      source: 'git-review',
      path: 'src/app.ts'
    })
    expect(descriptor).toMatchObject({
      kind: 'diff',
      mimeType: 'text/x-diff',
      location: { kind: 'diff', path: 'src/app.ts' },
      trustLevel: 'verified'
    })
    expect(JSON.stringify(descriptor)).not.toContain(executionRoot)
  })
})
