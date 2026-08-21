import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureSharedGrokMemory } from './grok-shared-memory'
import { GrokMemoryStore } from './grok-memory-store'

describe('GrokMemoryStore', () => {
  const dirs: string[] = []

  afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function createStore(link = true): Promise<{
    store: GrokMemoryStore
    grokHome: string
    userMemoryDir: string
  }> {
    const root = await mkdtemp(join(tmpdir(), 'memory-store-'))
    dirs.push(root)
    const grokHome = join(root, 'grok-home')
    const userMemoryDir = join(root, '.grok', 'memory')
    await mkdir(grokHome, { recursive: true })
    await mkdir(userMemoryDir, { recursive: true })
    if (link) await ensureSharedGrokMemory({ grokHome, userMemoryDir })
    return { store: new GrokMemoryStore(grokHome, userMemoryDir), grokHome, userMemoryDir }
  }

  it('临时 grok-home 放三份文件，list 分组正确且无绝对路径', async () => {
    const { store, grokHome } = await createStore()
    await writeFile(join(grokHome, 'memory', 'MEMORY.md'), '# 全局\nhello', 'utf8')
    await mkdir(join(grokHome, 'memory', 'demo-deadbeef', 'sessions'), { recursive: true })
    await writeFile(join(grokHome, 'memory', 'demo-deadbeef', 'MEMORY.md'), '# 项目', 'utf8')
    await writeFile(
      join(grokHome, 'memory', 'demo-deadbeef', 'sessions', 'one.md'),
      '# 会话',
      'utf8'
    )

    const list = await store.list('demo')
    expect(list.map((item) => item.scope).sort()).toEqual(['global', 'project', 'session'])
    expect(JSON.stringify(list)).not.toMatch(/[A-Za-z]:\\/)
    expect(list.every((item) => !item.memoryId.includes('\\'))).toBe(true)
    expect(list.some((item) => item.isCurrentProject)).toBe(true)
  })

  it('memoryId 含 .. 的 get/save/delete 都被拒绝', async () => {
    const { store } = await createStore()
    await expect(store.get('global/../MEMORY.md')).rejects.toThrow(/标识无效/)
    await expect(store.save('global/../MEMORY.md', 'x')).rejects.toThrow(/标识无效/)
    await expect(store.delete('global/../MEMORY.md')).rejects.toThrow(/标识无效/)
  })

  it('listTrustedRoots 只返回共享记忆目录的 realpath', async () => {
    const { store, userMemoryDir } = await createStore()
    const roots = await store.listTrustedRoots()
    expect(roots).toEqual([await realpath(userMemoryDir)])
  })

  it('junction 到临时 .grok/memory 时 list/get/save 成功，用户侧也能读到', async () => {
    const { store, userMemoryDir } = await createStore()
    await store.save('global/MEMORY.md', 'from-app')
    const got = await store.get('global/MEMORY.md')
    expect(got.markdown).toBe('from-app')
    expect(JSON.stringify(got)).not.toMatch(/[A-Za-z]:\\/)
    expect(await readFile(join(userMemoryDir, 'MEMORY.md'), 'utf8')).toBe('from-app')
  })

  it('save 项目 MEMORY.md 后共享树更新，delete 项目或全局失败，delete 会话成功', async () => {
    const { store, userMemoryDir } = await createStore()
    await store.save('project/demo-deadbeef/MEMORY.md', 'project-body')
    expect(await readFile(join(userMemoryDir, 'demo-deadbeef', 'MEMORY.md'), 'utf8')).toBe(
      'project-body'
    )
    await expect(store.delete('project/demo-deadbeef/MEMORY.md')).rejects.toThrow(/会话摘要/)
    await expect(store.delete('global/MEMORY.md')).rejects.toThrow(/会话摘要/)
    await store.save('session/demo-deadbeef/note.md', 'session-body')
    await store.delete('session/demo-deadbeef/note.md')
    await expect(store.get('session/demo-deadbeef/note.md')).rejects.toThrow()
  })

  it('symlink 指到 grok-home 外且不是共享目标时 save 不得跟上', async () => {
    const { store, grokHome } = await createStore(false)
    const outside = await mkdtemp(join(tmpdir(), 'memory-outside-'))
    dirs.push(outside)
    await writeFile(join(outside, 'stolen.md'), 'secret', 'utf8')
    await mkdir(join(grokHome, 'memory'), { recursive: true })
    try {
      await symlink(join(outside, 'stolen.md'), join(grokHome, 'memory', 'MEMORY.md'))
    } catch (error) {
      if (process.platform === 'win32') return
      throw error
    }
    await expect(store.get('global/MEMORY.md')).rejects.toThrow(/路径无效/)
    await expect(store.save('global/MEMORY.md', 'overwrite')).rejects.toThrow(/路径无效/)
    expect(await readFile(join(outside, 'stolen.md'), 'utf8')).toBe('secret')
  })
})
