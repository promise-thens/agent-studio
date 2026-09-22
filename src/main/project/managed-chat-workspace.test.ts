import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ManagedChatWorkspace } from './managed-chat-workspace'
import { ProjectRegistry } from './project-registry'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** 真实临时目录验证 cwd 与凭据树隔离及重启复用。 */
async function fixture(): Promise<{ root: string; userDataPath: string; registry: ProjectRegistry }> {
  const root = await mkdtemp(join(tmpdir(), 'managed-chat-'))
  roots.push(root)
  const userDataPath = join(root, 'config')
  await mkdir(userDataPath)
  const registry = new ProjectRegistry({ userDataPath })
  await registry.initialize()
  return { root, userDataPath, registry }
}

describe('托管聊天工作目录', () => {
  it('并发只准备一次，跨重启复用独立托管身份', async () => {
    const { root, userDataPath, registry } = await fixture()
    const workspace = new ManagedChatWorkspace({ root: join(root, 'chat'), userDataPath, registry })
    const first = workspace.prepare()
    expect(workspace.prepare()).toBe(first)
    const project = await first
    expect(project).toMatchObject({ kind: 'managed-chat', displayName: '无项目对话' })
    const restarted = new ProjectRegistry({ userDataPath })
    await restarted.initialize()
    expect(await new ManagedChatWorkspace({ root: join(root, 'chat'), userDataPath, registry: restarted }).prepare()).toMatchObject({ projectId: project.projectId, kind: 'managed-chat' })
  })

  it('拒绝配置树本身、子目录、父目录及指向配置树的 symlink', async () => {
    const { root, userDataPath, registry } = await fixture()
    const link = join(root, 'linked-config')
    await symlink(userDataPath, link)
    for (const cwd of [root, userDataPath, join(userDataPath, 'chat'), link]) {
      await expect(new ManagedChatWorkspace({ root: cwd, userDataPath, registry }).prepare()).rejects.toThrow('无法准备')
    }
    expect(await registry.list()).toEqual([])
  })
})
