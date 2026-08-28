import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { extractGrokRuntimeMediaPaths, readGrokSessionMediaFile } from './grok-runtime-media'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

function mediaPrompt(path: string, filename = '1.png', sessionFolder = 'images'): string {
  return JSON.stringify({
    path,
    filename,
    session_folder: sessionFolder,
    message: `Image generated and saved to ${path}.`
  })
}

function toolContent(text: string): Array<{
  type: 'content'
  content: { type: 'text'; text: string }
}> {
  return [
    {
      type: 'content' as const,
      content: { type: 'text' as const, text }
    }
  ]
}

describe('extractGrokRuntimeMediaPaths', () => {
  it('从 image_gen 的 tool content JSON 取出路径和文件名', () => {
    const path = '/tmp/sessions/sess-1/images/1.png'
    expect(extractGrokRuntimeMediaPaths(toolContent(mediaPrompt(path)))).toEqual([
      { absolutePath: path, originalName: '1.png' }
    ])
    expect(extractGrokRuntimeMediaPaths([{ type: 'text', text: mediaPrompt(path) }])).toEqual([
      { absolutePath: path, originalName: '1.png' }
    ])
  })

  it('忽略 Diff 和非媒体文本', () => {
    expect(
      extractGrokRuntimeMediaPaths([
        { type: 'diff', path: '/tmp/sessions/sess-1/images/1.png', oldText: '', newText: 'x' },
        {
          type: 'content',
          content: { type: 'text', text: '普通工具输出' }
        }
      ])
    ).toEqual([])
  })

  it('拒绝穿越、错目录、错文件名和超长正文', () => {
    const long = 'a'.repeat(20_000)
    expect(
      extractGrokRuntimeMediaPaths(
        toolContent(mediaPrompt('/tmp/sessions/sess-1/images/../secret.png'))
      )
    ).toEqual([])
    expect(
      extractGrokRuntimeMediaPaths(toolContent(mediaPrompt('/tmp/sessions/sess-1/videos/1.png')))
    ).toEqual([])
    expect(
      extractGrokRuntimeMediaPaths(
        toolContent(mediaPrompt('/tmp/sessions/sess-1/images/hero.png', 'hero.png'))
      )
    ).toEqual([])
    expect(extractGrokRuntimeMediaPaths(toolContent(long))).toEqual([])
  })
})

describe('readGrokSessionMediaFile', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function mediaRoot(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'grok-media-root-'))
    roots.push(dir)
    return realpath(dir)
  }

  it('只读取媒体根下 images/编号 的普通图片', async () => {
    const root = await mediaRoot()
    const file = join(root, 'sess-1', 'images', '1.png')
    await mkdir(join(root, 'sess-1', 'images'), { recursive: true })
    await writeFile(file, PNG)
    const read = await readGrokSessionMediaFile(
      { absolutePath: file, originalName: '1.png' },
      { mediaRoot: root }
    )
    expect(read).toEqual({
      bytes: PNG,
      mimeType: 'image/png',
      originalName: '1.png'
    })
  })

  it('允许 GROK_HOME/sessions/<cwd>/<session>/images/编号', async () => {
    const root = await mediaRoot()
    const file = join(root, '%2FUsers%2Fproj', 'sess-1', 'images', '1.png')
    await mkdir(join(root, '%2FUsers%2Fproj', 'sess-1', 'images'), { recursive: true })
    await writeFile(file, PNG)
    const read = await readGrokSessionMediaFile(
      { absolutePath: file, originalName: '1.png' },
      { mediaRoot: root }
    )
    expect(read?.mimeType).toBe('image/png')
    expect(read?.originalName).toBe('1.png')
  })

  it('拒绝媒体根下直接放 images/编号，必须带 session 段', async () => {
    const root = await mediaRoot()
    const file = join(root, 'images', '1.png')
    await mkdir(join(root, 'images'), { recursive: true })
    await writeFile(file, PNG)
    await expect(
      readGrokSessionMediaFile({ absolutePath: file, originalName: '1.png' }, { mediaRoot: root })
    ).resolves.toBeNull()
  })

  it('拒绝符号链接、越界路径和伪装扩展名', async () => {
    const root = await mediaRoot()
    const outside = await mkdtemp(join(tmpdir(), 'grok-media-outside-'))
    roots.push(outside)
    const secret = join(outside, 'secret.png')
    await writeFile(secret, PNG)
    await mkdir(join(root, 'sess-1', 'images'), { recursive: true })
    const link = join(root, 'sess-1', 'images', '1.png')
    await symlink(secret, link)
    await writeFile(join(root, 'sess-1', 'images', '2.png'), Buffer.from('not-an-image'))

    await expect(
      readGrokSessionMediaFile({ absolutePath: link, originalName: '1.png' }, { mediaRoot: root })
    ).resolves.toBeNull()
    await expect(
      readGrokSessionMediaFile({ absolutePath: secret, originalName: '1.png' }, { mediaRoot: root })
    ).resolves.toBeNull()
    await expect(
      readGrokSessionMediaFile(
        { absolutePath: join(root, 'sess-1', 'images', '2.png'), originalName: '2.png' },
        { mediaRoot: root }
      )
    ).resolves.toBeNull()
  })
})
