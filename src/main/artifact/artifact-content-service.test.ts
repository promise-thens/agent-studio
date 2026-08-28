import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ARTIFACT_LIMITS } from '../../shared/artifact'
import { ArtifactContentService } from './artifact-content-service'
import { ArtifactRegistry, ArtifactRegistryError } from './artifact-registry'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-studio-artifact-content-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3])

async function createService(): Promise<{
  service: ArtifactContentService
  registry: ArtifactRegistry
  executionRoot: string
  getFileDiff: ReturnType<typeof vi.fn>
}> {
  const executionRoot = await createTemporaryDirectory()
  const taskDirectory = await createTemporaryDirectory()
  let id = 0
  const registry = new ArtifactRegistry({
    getTaskContext: () => ({
      projectId: 'project-1',
      taskId: 'task-1',
      environmentId: 'local:env-1',
      executionRoot,
      lastTurnId: 'turn-1',
      taskDirectory
    }),
    createId: () => `art-${++id}`,
    now: () => '2026-08-28T00:00:00.000Z',
    probeImagePixels: () => ({ width: 8, height: 8 })
  })
  const getFileDiff = vi.fn(async (taskId: string, path: string) => ({
    taskId,
    path,
    status: 'ok' as const,
    unifiedDiff: '--- a/app.ts\n+++ b/app.ts\n'
  }))
  const service = new ArtifactContentService({
    registry,
    getFileDiff,
    probeImagePixels: () => ({ width: 8, height: 8 })
  })
  return { service, registry, executionRoot, getFileDiff }
}

describe('ArtifactContentService', () => {
  it('返回有限 UTF-8 文本，超长截断且错误不含绝对路径', async () => {
    const { service, registry, executionRoot } = await createService()
    await writeFile(join(executionRoot, 'note.txt'), 'hello world', { mode: 0o600 })
    const descriptor = await registry.registerFileCandidate({
      taskId: 'task-1',
      source: 'git-review',
      relativePath: 'note.txt'
    })
    const content = await service.getContent('task-1', descriptor.artifactId)
    expect(content).toMatchObject({
      kind: 'text',
      text: 'hello world',
      descriptor: { artifactId: descriptor.artifactId, availability: 'ready' }
    })
    expect(JSON.stringify(content)).not.toContain(executionRoot)
  })

  it('Markdown 净化脚本和危险链接后再返回', async () => {
    const { service, registry, executionRoot } = await createService()
    await writeFile(
      join(executionRoot, 'note.md'),
      '# Hi\n<script>alert(1)</script>\n[x](javascript:alert(1))\n',
      { mode: 0o600 }
    )
    const descriptor = await registry.registerFileCandidate({
      taskId: 'task-1',
      source: 'git-review',
      relativePath: 'note.md'
    })
    const content = await service.getContent('task-1', descriptor.artifactId)
    expect(content.kind).toBe('markdown')
    if (content.kind !== 'markdown') return
    expect(content.markdown).toContain('# Hi')
    expect(content.markdown).not.toContain('<script')
    expect(content.markdown).not.toContain('javascript:')
  })

  it('图片返回受限 base64，不给 file URL 或磁盘路径', async () => {
    const { service, registry, executionRoot } = await createService()
    await writeFile(join(executionRoot, 'shot.png'), PNG, { mode: 0o600 })
    const descriptor = await registry.registerFileCandidate({
      taskId: 'task-1',
      source: 'git-review',
      relativePath: 'shot.png'
    })
    const content = await service.getContent('task-1', descriptor.artifactId)
    expect(content).toMatchObject({
      kind: 'image',
      mimeType: 'image/png'
    })
    if (content.kind !== 'image') return
    expect(content.imageBase64).toBe(PNG.toString('base64'))
    expect(JSON.stringify(content)).not.toContain(executionRoot)
    expect(JSON.stringify(content)).not.toContain('file:')
  })

  it('Diff 产物复用 P0-12 getFileDiff，不自己读 Git', async () => {
    const { service, registry, getFileDiff } = await createService()
    const descriptor = await registry.registerDiffCandidate({
      taskId: 'task-1',
      source: 'git-review',
      path: 'src/app.ts'
    })
    const content = await service.getContent('task-1', descriptor.artifactId)
    expect(getFileDiff).toHaveBeenCalledWith('task-1', 'src/app.ts')
    expect(content).toMatchObject({
      kind: 'diff',
      diff: { taskId: 'task-1', path: 'src/app.ts', status: 'ok' }
    })
  })

  it('源文件变化后不复用旧缓存', async () => {
    const { service, registry, executionRoot } = await createService()
    const file = join(executionRoot, 'note.txt')
    await writeFile(file, 'first', { mode: 0o600 })
    const descriptor = await registry.registerFileCandidate({
      taskId: 'task-1',
      source: 'git-review',
      relativePath: 'note.txt'
    })
    const first = await service.getContent('task-1', descriptor.artifactId)
    await writeFile(file, 'second', { mode: 0o600 })
    const second = await service.getContent('task-1', descriptor.artifactId)
    expect(first).toMatchObject({ kind: 'text', text: 'first' })
    expect(second).toMatchObject({ kind: 'text', text: 'second' })
    if (second.kind !== 'text') return
    expect(second.descriptor.availability).toBe('changed')
  })

  it('未知 artifactId 失败且不泄漏其它路径', async () => {
    const { service, executionRoot } = await createService()
    await expect(service.getContent('task-1', 'missing')).rejects.toBeInstanceOf(
      ArtifactRegistryError
    )
    try {
      await service.getContent('task-1', 'missing')
    } catch (error) {
      expect(String(error)).not.toContain(executionRoot)
    }
  })

  it('超长文本截断', async () => {
    const { service, registry, executionRoot } = await createService()
    const body = 'a'.repeat(ARTIFACT_LIMITS.maxTextBytes + 32)
    await writeFile(join(executionRoot, 'big.txt'), body, { mode: 0o600 })
    const descriptor = await registry.registerFileCandidate({
      taskId: 'task-1',
      source: 'git-review',
      relativePath: 'big.txt'
    })
    const content = await service.getContent('task-1', descriptor.artifactId)
    expect(content.kind).toBe('text')
    if (content.kind !== 'text') return
    expect(content.truncated).toBe(true)
    expect(Buffer.byteLength(content.text, 'utf8')).toBeLessThanOrEqual(
      ARTIFACT_LIMITS.maxTextBytes
    )
  })
})
