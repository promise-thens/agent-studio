import type { FileHandle } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { AtomicJsonWriter, type AtomicJsonFileSystem } from './atomic-json-file'

function createHandle(events: string[], name: string): FileHandle {
  return {
    writeFile: vi.fn(async () => {
      events.push(`${name}:write`)
    }),
    sync: vi.fn(async () => {
      events.push(`${name}:sync`)
    }),
    close: vi.fn(async () => {
      events.push(`${name}:close`)
    })
  } as unknown as FileHandle
}

function createFileSystem(events: string[]): AtomicJsonFileSystem {
  return {
    mkdir: vi.fn(async () => {
      events.push('mkdir')
    }),
    chmod: vi.fn(async (_path, mode) => {
      events.push(`chmod:${mode.toString(8)}`)
    }),
    open: vi.fn(async (path) => {
      events.push(`open:${path}`)
      return createHandle(events, path.endsWith('.tmp') ? 'file' : 'directory')
    }),
    rename: vi.fn(async () => {
      events.push('rename')
    }),
    rm: vi.fn(async () => {
      events.push('rm')
    }),
    readFile: vi.fn(async () => '{}')
  }
}

describe('AtomicJsonWriter', () => {
  it('按 0700/0600 和 fsync 顺序提交同目录临时文件', async () => {
    const events: string[] = []
    const fileSystem = createFileSystem(events)
    const writer = new AtomicJsonWriter({ fileSystem, randomId: () => 'record' })

    await writer.write('/history/task.json', { ok: true })

    expect(fileSystem.mkdir).toHaveBeenCalledWith('/history', { recursive: true, mode: 0o700 })
    expect(fileSystem.open).toHaveBeenCalledWith('/history/.record.tmp', 'wx', 0o600)
    expect(events.indexOf('file:sync')).toBeLessThan(events.indexOf('rename'))
    expect(events.indexOf('rename')).toBeLessThan(events.lastIndexOf('directory:sync'))
    expect(events).toContain('chmod:700')
    expect(events).toContain('chmod:600')
  })

  it('rename 前失败会关闭句柄并清理临时文件', async () => {
    const events: string[] = []
    const fileSystem = createFileSystem(events)
    fileSystem.rename = vi.fn(async () => {
      throw Object.assign(new Error('rename failed'), { code: 'EIO' })
    })
    const writer = new AtomicJsonWriter({ fileSystem, randomId: () => 'failed' })

    await expect(writer.write('/history/task.json', { ok: false })).rejects.toThrow('rename failed')
    expect(events).toContain('file:close')
    expect(fileSystem.rm).toHaveBeenCalledWith('/history/.failed.tmp', { force: true })
  })

  it('同一路径写入串行化，前一次失败不阻断下一次', async () => {
    const events: string[] = []
    const fileSystem = createFileSystem(events)
    let renameCount = 0
    fileSystem.rename = vi.fn(async () => {
      renameCount += 1
      if (renameCount === 1) throw new Error('first failed')
      events.push('rename:second')
    })
    let id = 0
    const writer = new AtomicJsonWriter({ fileSystem, randomId: () => `write-${++id}` })

    const first = writer.write('/history/task.json', { value: 1 })
    const second = writer.write('/history/task.json', { value: 2 })

    await expect(first).rejects.toThrow('first failed')
    await expect(second).resolves.toBeUndefined()
    expect(fileSystem.open).toHaveBeenNthCalledWith(1, '/history/.write-1.tmp', 'wx', 0o600)
    expect(fileSystem.open).toHaveBeenCalledWith('/history/.write-2.tmp', 'wx', 0o600)
  })

  it('只降级明确不支持的目录 fsync，EIO 仍向上抛出', async () => {
    const events: string[] = []
    const unsupportedFs = createFileSystem(events)
    unsupportedFs.open = vi.fn(async (path) => {
      if (path === '/history') {
        throw Object.assign(new Error('unsupported'), { code: 'EINVAL' })
      }
      return createHandle(events, 'file')
    })
    await expect(
      new AtomicJsonWriter({ fileSystem: unsupportedFs, randomId: () => 'ok' }).write(
        '/history/task.json',
        {}
      )
    ).resolves.toBeUndefined()

    const failingFs = createFileSystem([])
    failingFs.open = vi.fn(async (path) => {
      if (path === '/history') throw Object.assign(new Error('disk failed'), { code: 'EIO' })
      return createHandle([], 'file')
    })
    await expect(
      new AtomicJsonWriter({ fileSystem: failingFs, randomId: () => 'fail' }).write(
        '/history/task.json',
        {}
      )
    ).rejects.toThrow('disk failed')
  })
})
