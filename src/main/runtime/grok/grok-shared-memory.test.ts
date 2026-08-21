import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureSharedGrokMemory, isAllowedMemoryCanonical } from './grok-shared-memory'

describe('ensureSharedGrokMemory', () => {
  const dirs: string[] = []

  afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function fixture(): Promise<{ grokHome: string; userMemoryDir: string }> {
    const root = await mkdtemp(join(tmpdir(), 'shared-memory-'))
    dirs.push(root)
    const grokHome = join(root, 'grok-home')
    const userMemoryDir = join(root, '.grok', 'memory')
    await mkdir(grokHome, { recursive: true })
    await mkdir(userMemoryDir, { recursive: true })
    return { grokHome, userMemoryDir }
  }

  it('managed memory 的 realpath 等于用户目录，写入全局和项目都能在用户侧读到', async () => {
    const { grokHome, userMemoryDir } = await fixture()
    const result = await ensureSharedGrokMemory({ grokHome, userMemoryDir })
    expect(['linked', 'already-linked']).toContain(result)

    const { realpath } = await import('node:fs/promises')
    expect((await realpath(join(grokHome, 'memory'))).toLowerCase()).toBe(
      (await realpath(userMemoryDir)).toLowerCase()
    )

    await writeFile(join(grokHome, 'memory', 'MEMORY.md'), 'global-note', 'utf8')
    await mkdir(join(grokHome, 'memory', 'demo-deadbeef'), { recursive: true })
    await writeFile(join(grokHome, 'memory', 'demo-deadbeef', 'MEMORY.md'), 'project-note', 'utf8')

    expect(await readFile(join(userMemoryDir, 'MEMORY.md'), 'utf8')).toBe('global-note')
    expect(await readFile(join(userMemoryDir, 'demo-deadbeef', 'MEMORY.md'), 'utf8')).toBe(
      'project-note'
    )
  })

  it('isAllowedMemoryCanonical 用 realpath 对齐 /var 与 /private/var', async () => {
    const { grokHome, userMemoryDir } = await fixture()
    await ensureSharedGrokMemory({ grokHome, userMemoryDir })
    await writeFile(join(userMemoryDir, 'MEMORY.md'), 'note', 'utf8')
    const canonicalFile = await realpath(join(userMemoryDir, 'MEMORY.md'))
    expect(
      isAllowedMemoryCanonical({
        grokHome,
        userMemoryDir,
        canonical: canonicalFile
      })
    ).toBe(true)
  })

  it('managed memory 里已有非空文件时返回 skipped-existing 且文件还在', async () => {
    const { grokHome, userMemoryDir } = await fixture()
    await mkdir(join(grokHome, 'memory'), { recursive: true })
    await writeFile(join(grokHome, 'memory', 'MEMORY.md'), 'keep-me', 'utf8')
    expect(await ensureSharedGrokMemory({ grokHome, userMemoryDir })).toBe('skipped-existing')
    expect(await readFile(join(grokHome, 'memory', 'MEMORY.md'), 'utf8')).toBe('keep-me')
  })
})
