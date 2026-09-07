import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactRegistry, ArtifactRegistryError } from '../../artifact/artifact-registry'
import {
  copyBrowserPluginScreenshotFilePath,
  registerBrowserPluginScreenshot as registerBrowserPluginScreenshotCore,
  toolCallHasBrowserPluginScreenshot
} from './browser-plugin-screenshot'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const GIF = Buffer.from('GIF89a0000')
const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2, 3, 4
])

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'agent-studio-browser-shot-')))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('registerBrowserPluginScreenshot', () => {
  let executionRoot: string
  let mediaRoot: string
  let registerBrowserPluginScreenshot: (input: {
    taskId: string
    turnId: string
    absolutePath: string
  }) => ReturnType<typeof registerBrowserPluginScreenshotCore>
  let attached: Array<{ taskId: string; turnId: string; artifactIds: string[] }>

  async function setupRegistry(): Promise<void> {
    executionRoot = await createTemporaryDirectory()
    mediaRoot = await createTemporaryDirectory()
    const taskDirectory = await createTemporaryDirectory()
    attached = []
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
      createId: () => `art-${++id}`,
      now: () => '2026-09-07T00:00:00.000Z',
      probeImagePixels: () => ({ width: 8, height: 8 })
    })
    registerBrowserPluginScreenshot = (input) =>
      registerBrowserPluginScreenshotCore({
        ...input,
        registry,
        executionRoot,
        mediaRoots: [mediaRoot]
      })
  }

  it('允许路径上的 png 注册为 image artifact，绝对路径不进描述符', async () => {
    await setupRegistry()
    await mkdir(join(executionRoot, 'screenshots'), { recursive: true })
    await writeFile(join(executionRoot, 'screenshots', 'page.png'), PNG)

    const descriptor = await registerBrowserPluginScreenshot({
      taskId: 'task-1',
      turnId: 'turn-1',
      absolutePath: join(executionRoot, 'screenshots', 'page.png')
    })
    expect(descriptor?.kind).toBe('image')
    expect(JSON.stringify(descriptor)).not.toContain(executionRoot)
  })

  it('越界路径或非图片不阻断，返回无截图', async () => {
    await setupRegistry()
    await expect(
      registerBrowserPluginScreenshot({
        taskId: 'task-1',
        turnId: 'turn-1',
        absolutePath: '/etc/passwd'
      })
    ).resolves.toBeNull()
  })

  it('execution root 内 jpeg 可注册，标题是脱敏短句且来源为 agent-event', async () => {
    await setupRegistry()
    await mkdir(join(executionRoot, 'screenshots'), { recursive: true })
    await writeFile(join(executionRoot, 'screenshots', 'page.jpg'), JPEG)

    const descriptor = await registerBrowserPluginScreenshot({
      taskId: 'task-1',
      turnId: 'turn-1',
      absolutePath: join(executionRoot, 'screenshots', 'page.jpg')
    })
    expect(descriptor).toMatchObject({
      kind: 'image',
      mimeType: 'image/jpeg',
      title: '屏幕截图',
      source: 'agent-event',
      turnId: 'turn-1'
    })
    expect(JSON.stringify(descriptor)).not.toContain(executionRoot)
    expect(attached).toEqual([{ taskId: 'task-1', turnId: 'turn-1', artifactIds: ['art-1'] }])
  })

  it('session images 目录中的截图复制进 execution root 后再注册', async () => {
    await setupRegistry()
    const sessionFile = join(mediaRoot, 'sess-1', 'images', 'page.png')
    await mkdir(join(mediaRoot, 'sess-1', 'images'), { recursive: true })
    await writeFile(sessionFile, PNG)

    const descriptor = await registerBrowserPluginScreenshot({
      taskId: 'task-1',
      turnId: 'turn-1',
      absolutePath: sessionFile
    })
    expect(descriptor?.kind).toBe('image')
    expect(descriptor?.source).toBe('agent-event')
    expect(descriptor?.title).toBe('屏幕截图')
    expect(descriptor?.location).toMatchObject({ kind: 'file' })
    expect(JSON.stringify(descriptor)).not.toContain(sessionFile)
    expect(JSON.stringify(descriptor)).not.toContain(mediaRoot)
    expect(JSON.stringify(descriptor)).not.toContain(executionRoot)
    if (descriptor?.location.kind === 'file') {
      expect(descriptor.location.relativePath.startsWith('screenshots/')).toBe(true)
    }
  })

  it('svg、空文件、gif、缺失文件和符号链接都返回 null', async () => {
    await setupRegistry()
    await mkdir(join(executionRoot, 'screenshots'), { recursive: true })
    await writeFile(join(executionRoot, 'screenshots', 'icon.svg'), '<svg></svg>')
    await writeFile(join(executionRoot, 'screenshots', 'empty.png'), Buffer.alloc(0))
    await writeFile(join(executionRoot, 'screenshots', 'anim.gif'), GIF)
    await writeFile(join(executionRoot, 'screenshots', 'page.webp'), WEBP)
    const outside = await createTemporaryDirectory()
    await writeFile(join(outside, 'secret.png'), PNG)
    await symlink(join(outside, 'secret.png'), join(executionRoot, 'screenshots', 'link.png'))

    await expect(
      registerBrowserPluginScreenshot({
        taskId: 'task-1',
        turnId: 'turn-1',
        absolutePath: join(executionRoot, 'screenshots', 'icon.svg')
      })
    ).resolves.toBeNull()
    await expect(
      registerBrowserPluginScreenshot({
        taskId: 'task-1',
        turnId: 'turn-1',
        absolutePath: join(executionRoot, 'screenshots', 'empty.png')
      })
    ).resolves.toBeNull()
    await expect(
      registerBrowserPluginScreenshot({
        taskId: 'task-1',
        turnId: 'turn-1',
        absolutePath: join(executionRoot, 'screenshots', 'anim.gif')
      })
    ).resolves.toBeNull()
    await expect(
      registerBrowserPluginScreenshot({
        taskId: 'task-1',
        turnId: 'turn-1',
        absolutePath: join(executionRoot, 'screenshots', 'missing.png')
      })
    ).resolves.toBeNull()
    await expect(
      registerBrowserPluginScreenshot({
        taskId: 'task-1',
        turnId: 'turn-1',
        absolutePath: join(executionRoot, 'screenshots', 'link.png')
      })
    ).resolves.toBeNull()

    const webp = await registerBrowserPluginScreenshot({
      taskId: 'task-1',
      turnId: 'turn-1',
      absolutePath: join(executionRoot, 'screenshots', 'page.webp')
    })
    expect(webp?.mimeType).toBe('image/webp')
  })

  it('session 根下非 images 路径不注册', async () => {
    await setupRegistry()
    const leaked = join(mediaRoot, 'sess-1', 'secret.png')
    await mkdir(join(mediaRoot, 'sess-1'), { recursive: true })
    await writeFile(leaked, PNG)
    await expect(
      registerBrowserPluginScreenshot({
        taskId: 'task-1',
        turnId: 'turn-1',
        absolutePath: leaked
      })
    ).resolves.toBeNull()
  })
})

describe('copyBrowserPluginScreenshotFilePath', () => {
  it('只拷贝 rawInput.filePath 绝对路径，嵌套 tool_input 丢掉', () => {
    expect(
      copyBrowserPluginScreenshotFilePath({ filePath: '/tmp/sessions/sess/images/1.png' })
    ).toBe('/tmp/sessions/sess/images/1.png')
    expect(copyBrowserPluginScreenshotFilePath({ filePath: 'screenshots/page.png' })).toBeNull()
    expect(
      copyBrowserPluginScreenshotFilePath({
        tool_input: { filePath: '/tmp/sessions/sess/images/1.png' }
      })
    ).toBeNull()
    expect(copyBrowserPluginScreenshotFilePath({ filePath: '/tmp/x\0.png' })).toBeNull()
    expect(copyBrowserPluginScreenshotFilePath(null)).toBeNull()
  })
})

describe('toolCallHasBrowserPluginScreenshot', () => {
  it('仅 take_screenshot / browser_screenshot 且带 filePath 才算截图候选', () => {
    expect(
      toolCallHasBrowserPluginScreenshot({
        sessionUpdate: 'tool_call',
        name: 'take_screenshot',
        rawInput: { filePath: '/tmp/sessions/s/images/1.png' }
      })
    ).toBe(true)
    expect(
      toolCallHasBrowserPluginScreenshot({
        sessionUpdate: 'tool_call_update',
        name: 'browser_screenshot',
        rawInput: { filePath: '/tmp/sessions/s/images/1.png' }
      })
    ).toBe(true)
    expect(
      toolCallHasBrowserPluginScreenshot({
        sessionUpdate: 'tool_call',
        name: 'click',
        rawInput: { filePath: '/tmp/sessions/s/images/1.png' }
      })
    ).toBe(false)
    expect(
      toolCallHasBrowserPluginScreenshot({
        sessionUpdate: 'tool_call',
        name: 'take_screenshot',
        rawInput: { url: 'https://example.com' }
      })
    ).toBe(false)
  })
})
