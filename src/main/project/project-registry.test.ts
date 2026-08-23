import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectRegistry } from './project-registry'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-studio-project-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('ProjectRegistry', () => {
  it('真实路径与符号链接复用同一个 Project，移除后可重新激活', async () => {
    const root = await createTemporaryDirectory()
    const userDataPath = await createTemporaryDirectory()
    const projectPath = join(root, 'project')
    const linkPath = join(root, 'project-link')
    await mkdir(projectPath)
    await symlink(projectPath, linkPath)
    let id = 0
    const registry = new ProjectRegistry({
      userDataPath,
      createId: () => `project-${++id}`,
      now: () => `2026-08-12T00:00:0${id}.000Z`
    })
    await registry.initialize()

    const first = await registry.register(projectPath)
    const second = await registry.register(linkPath)
    expect(second.projectId).toBe(first.projectId)

    await registry.remove(first.projectId)
    expect((await registry.getSummary(first.projectId)).status).toBe('removed')
    expect((await registry.register(projectPath)).status).toBe('active')
  })

  it('按 canonical root 找回仍有效的 Project ID，忽略已移除记录', async () => {
    const root = await createTemporaryDirectory()
    const userDataPath = await createTemporaryDirectory()
    const projectPath = join(root, 'project')
    await mkdir(projectPath)
    const registry = new ProjectRegistry({ userDataPath, createId: () => 'project-root-1' })
    await registry.initialize()

    const registered = await registry.register(projectPath)
    expect(registry.findActiveProjectIdByRoot(registered.canonicalRoot)).toBe('project-root-1')
    expect(registry.findActiveProjectIdByRoot('/tmp/not-a-registered-project')).toBeNull()

    await registry.remove(registered.projectId)
    expect(registry.findActiveProjectIdByRoot(registered.canonicalRoot)).toBeNull()
  })

  it('重启后恢复 Project 列表，目录失效时仍保留只读摘要', async () => {
    const root = await createTemporaryDirectory()
    const userDataPath = await createTemporaryDirectory()
    const projectPath = join(root, 'project')
    await mkdir(projectPath)
    const registry = new ProjectRegistry({ userDataPath, createId: () => 'project-1' })
    await registry.initialize()
    await registry.register(projectPath)
    await rm(projectPath, { recursive: true })

    const restarted = new ProjectRegistry({ userDataPath })
    await restarted.initialize()
    expect(await restarted.list()).toMatchObject([
      { projectId: 'project-1', availability: { state: 'unavailable' } }
    ])
  })

  it('损坏 Project 目录移入 quarantine，未知新版本原位保留为只读摘要', async () => {
    const userDataPath = await createTemporaryDirectory()
    const projectsRoot = join(userDataPath, 'history/v1/projects')
    await mkdir(join(projectsRoot, 'corrupt-project'), { recursive: true })
    await writeFile(join(projectsRoot, 'corrupt-project/project.json'), '{broken')
    await mkdir(join(projectsRoot, 'future-project'), { recursive: true })
    await writeFile(
      join(projectsRoot, 'future-project/project.json'),
      JSON.stringify({
        schemaVersion: 2,
        projectId: 'future-project',
        canonicalRoot: '/tmp/future-project',
        displayName: 'Future Project',
        status: 'active',
        registeredAt: '2026-08-12T00:00:00.000Z',
        lastOpenedAt: '2026-08-12T00:00:00.000Z',
        revision: 1
      })
    )

    const registry = new ProjectRegistry({ userDataPath, createId: () => 'quarantine-id' })
    await registry.initialize()

    expect(await registry.list()).toMatchObject([
      {
        projectId: 'future-project',
        availability: { state: 'version-unsupported' }
      }
    ])
    await expect(
      readFile(join(projectsRoot, 'future-project/project.json'), 'utf8')
    ).resolves.toContain('"schemaVersion":2')
    await expect(registry.getSummary('future-project')).rejects.toMatchObject({
      code: 'history-version-unsupported'
    })
    await expect(
      readFile(join(projectsRoot, 'corrupt-project/project.json'), 'utf8')
    ).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})
