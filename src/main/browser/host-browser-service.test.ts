import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { HostBrowserBounds } from '../../shared/host-browser'
import {
  createElectronHostBrowserBindings,
  HostBrowserService,
  type HostBrowserGuest,
  type HostBrowserPointerGeometry
} from './host-browser-service'
import type { HostBrowserActionDriver, HostBrowserActionResult } from './host-browser-actions'

function createFakeGuest(projectId: string): HostBrowserGuest & {
  destroyed: boolean
  bounds: HostBrowserBounds | null
  attachedListeners: Array<() => void>
} {
  let url = 'about:blank'
  let title = ''
  const loading = false
  const guest = {
    projectId,
    destroyed: false,
    bounds: null as HostBrowserBounds | null,
    attachedListeners: [] as Array<() => void>,
    loadURL(next: string) {
      url = next
      title = next
      for (const listener of guest.attachedListeners) listener()
    },
    getURL() {
      return url
    },
    getTitle() {
      return title
    },
    isLoading() {
      return loading
    },
    setBounds(bounds: HostBrowserBounds) {
      guest.bounds = bounds
    },
    destroy() {
      guest.destroyed = true
    },
    onChromeChanged(listener: () => void) {
      guest.attachedListeners.push(listener)
    },
    createActionDriver() {
      return {
        getURL: () => guest.getURL(),
        getTitle: () => guest.getTitle(),
        loadURL: async (next: string) => {
          guest.loadURL(next)
        },
        goBack: async () => false,
        goForward: async () => false,
        reload: async () => undefined,
        capturePng: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        getViewportCssSize: () => ({ width: 640, height: 640 }),
        sendCdp: async () => ({ nodes: [] })
      }
    }
  }
  return guest
}

describe('HostBrowserService', () => {
  it('按 projectId 隔离 guest，切项目时销毁旧视图', () => {
    const created: HostBrowserGuest[] = []
    const service = new HostBrowserService({
      createGuest: (projectId) => {
        const guest = createFakeGuest(projectId)
        created.push(guest)
        return guest
      },
      attachGuest: vi.fn(),
      detachGuest: vi.fn()
    })

    service.userNavigate('task-1', 'project-a', 'https://example.com')
    service.userNavigate('task-2', 'project-b', 'https://example.org')

    expect(created).toHaveLength(2)
    expect(created[0]?.projectId).toBe('project-a')
    expect((created[0] as ReturnType<typeof createFakeGuest>).destroyed).toBe(true)
    expect(created[1]?.projectId).toBe('project-b')
    expect(created[1]?.getURL()).toBe('https://example.org/')
  })

  it('同一项目复用 guest，javascript: 不得 loadURL', () => {
    const created: HostBrowserGuest[] = []
    const service = new HostBrowserService({
      createGuest: (projectId) => {
        const guest = createFakeGuest(projectId)
        created.push(guest)
        return guest
      },
      attachGuest: vi.fn(),
      detachGuest: vi.fn()
    })

    service.userNavigate('task-1', 'project-a', 'https://example.com/docs')
    service.userNavigate('task-1', 'project-a', 'https://example.com/about')
    expect(created).toHaveLength(1)
    expect(() => service.userNavigate('task-1', 'project-a', 'javascript:alert(1)')).toThrow(
      /只允许 http/
    )
    expect(created[0]?.getURL()).toBe('https://example.com/about')
  })

  it('关闭右栏只 detach，不销毁；有 bounds 后才挂到窗口', () => {
    const attachGuest = vi.fn()
    const detachGuest = vi.fn()
    const guest = createFakeGuest('project-a')
    const service = new HostBrowserService({
      createGuest: () => guest,
      attachGuest,
      detachGuest
    })

    service.userNavigate('task-1', 'project-a', 'https://example.com')
    expect(attachGuest).not.toHaveBeenCalled()
    expect(service.getChrome().open).toBe(true)

    service.updateBounds({ x: 100, y: 40, width: 480, height: 720 })
    expect(attachGuest).toHaveBeenCalledTimes(1)
    expect(guest.bounds).toEqual({ x: 100, y: 40, width: 480, height: 720 })

    const chrome = service.setOpen('task-1', 'project-a', false)
    expect(chrome.open).toBe(false)
    expect(detachGuest).toHaveBeenCalledTimes(1)
    expect(guest.destroyed).toBe(false)
  })

  it('perform 先过 Broker：拒绝时不得 loadURL', async () => {
    const guest = createFakeGuest('project-a')
    const service = new HostBrowserService({
      createGuest: () => guest,
      attachGuest: vi.fn(),
      detachGuest: vi.fn(),
      resolvePerformContext: () => ({
        taskId: 'task-1',
        turnId: 'turn-1',
        projectId: 'project-a',
        environmentId: 'env-a',
        executionRoot: process.cwd()
      }),
      authorizeOperation: async () => ({ ok: false, reason: 'user-denied' })
    })

    const result = await service.perform('task-1', {
      name: 'browser_navigate',
      arguments: { url: 'https://example.com' }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('denied')
    expect(guest.getURL()).toBe('about:blank')
  })

  it('perform 允许后才导航，并且打开右栏', async () => {
    const guest = createFakeGuest('project-a')
    const service = new HostBrowserService({
      createGuest: () => guest,
      attachGuest: vi.fn(),
      detachGuest: vi.fn(),
      resolvePerformContext: () => ({
        taskId: 'task-1',
        turnId: 'turn-1',
        projectId: 'project-a',
        environmentId: 'env-a',
        executionRoot: process.cwd()
      }),
      authorizeOperation: async (_intent, execute) => ({
        ok: true,
        value: await execute(_intent as never),
        reason: 'user-allowed',
        scope: 'once'
      })
    })

    const result = await service.perform('task-1', {
      name: 'browser_navigate',
      arguments: { url: 'https://example.com/docs' }
    })
    expect(result.ok).toBe(true)
    expect(guest.getURL()).toBe('https://example.com/docs')
    expect(service.getChrome().open).toBe(true)
  })

  it('授权意图按 origin 绑定，fingerprint 不含动作名以便 task grant 复用 click', async () => {
    const guest = createFakeGuest('project-a')
    const intents: Array<{ targets: unknown; fingerprint: string; type: string }> = []
    const service = new HostBrowserService({
      createGuest: () => guest,
      attachGuest: vi.fn(),
      detachGuest: vi.fn(),
      resolvePerformContext: () => ({
        taskId: 'task-1',
        turnId: 'turn-1',
        projectId: 'project-a',
        environmentId: 'env-a',
        executionRoot: process.cwd()
      }),
      authorizeOperation: async (intent, execute) => {
        intents.push({
          targets: intent.targets,
          fingerprint: intent.parameterFingerprint,
          type: intent.operationType
        })
        return {
          ok: true,
          value: await execute(intent as never),
          reason: 'user-allowed',
          scope: 'task'
        }
      }
    })

    await service.perform('task-1', {
      name: 'browser_navigate',
      arguments: { url: 'https://example.com/docs' }
    })
    await service.perform('task-1', { name: 'browser_snapshot' })

    expect(intents).toHaveLength(2)
    expect(intents[0]).toEqual({
      type: 'browser',
      fingerprint: 'host-browser:origin:v1',
      targets: [{ kind: 'origin', value: 'https://example.com' }]
    })
    expect(intents[1]).toEqual({
      type: 'browser',
      fingerprint: 'host-browser:origin:v1',
      targets: [{ kind: 'origin', value: 'https://example.com' }]
    })
  })

  it('完全访问时把 takeoverEnabled 交给 Broker，不得再弹内置浏览器 L3 卡', async () => {
    const guest = createFakeGuest('project-a')
    const optionsSeen: Array<{ takeoverEnabled?: boolean } | undefined> = []
    const service = new HostBrowserService({
      createGuest: () => guest,
      attachGuest: vi.fn(),
      detachGuest: vi.fn(),
      resolvePerformContext: () => ({
        taskId: 'task-1',
        turnId: 'turn-1',
        projectId: 'project-a',
        environmentId: 'env-a',
        executionRoot: process.cwd(),
        takeoverEnabled: true
      }),
      authorizeOperation: async (_intent, execute, options) => {
        optionsSeen.push(options)
        return {
          ok: true,
          value: await execute(_intent as never),
          reason: 'auto-allowed',
          scope: 'once'
        }
      }
    })

    const result = await service.perform('task-1', {
      name: 'browser_navigate',
      arguments: { url: 'https://www.baidu.com/' }
    })
    expect(result.ok).toBe(true)
    expect(optionsSeen).toEqual([{ takeoverEnabled: true }])
  })
})

/** 与 mapViewportCssToOverlayDip 夹具一致：css(10,10)+zoom1 → overlay(310,130)。 */
const POINTER_CONTENT_BOUNDS = { x: 100, y: 80, width: 1200, height: 700 }
const POINTER_VIEW_BOUNDS = { x: 200, y: 40, width: 640, height: 640 }
const POINTER_OVERLAY_BOUNDS = { x: 0, y: 0, width: 1440, height: 900 }

function createClickableGuest(
  projectId: string,
  emptyQuads: { current: boolean } = { current: false }
): HostBrowserGuest & ReturnType<typeof createFakeGuest> {
  const guest = createFakeGuest(projectId)
  const baseCreate = guest.createActionDriver.bind(guest)
  guest.createActionDriver = (): HostBrowserActionDriver => {
    const driver = baseCreate()
    return {
      ...driver,
      async sendCdp(method: string) {
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: '1',
                ignored: false,
                role: { type: 'role', value: 'button' },
                name: { type: 'computedString', value: 'Search' },
                backendDOMNodeId: 11
              }
            ]
          }
        }
        if (method === 'DOM.getContentQuads') {
          return emptyQuads.current ? { quads: [] } : { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] }
        }
        return {}
      }
    }
  }
  return guest
}

function createPointerService(options?: {
  geometry?: {
    contentBounds: HostBrowserBounds
    overlayBounds: HostBrowserBounds
    zoomFactor?: number
  } | null
  viewBounds?: HostBrowserBounds
  emptyQuads?: { current: boolean }
}): {
  service: HostBrowserService
  guest: ReturnType<typeof createClickableGuest>
  acceptHostBrowserPointer: ReturnType<typeof vi.fn>
  clearHostBrowserPointer: ReturnType<typeof vi.fn>
  emptyQuads: { current: boolean }
  geometryBox: { current: HostBrowserPointerGeometry | null }
} {
  const acceptHostBrowserPointer = vi.fn()
  const clearHostBrowserPointer = vi.fn()
  const emptyQuads = options?.emptyQuads ?? { current: false }
  const geometryBox: { current: HostBrowserPointerGeometry | null } = {
    current:
      options && 'geometry' in options
        ? (options.geometry ?? null)
        : {
            contentBounds: POINTER_CONTENT_BOUNDS,
            overlayBounds: POINTER_OVERLAY_BOUNDS,
            zoomFactor: 1
          }
  }
  const guest = createClickableGuest('project-a', emptyQuads)
  const service = new HostBrowserService({
    createGuest: () => guest,
    attachGuest: vi.fn(),
    detachGuest: vi.fn(),
    resolvePerformContext: () => ({
      taskId: 'task-1',
      turnId: 'turn-1',
      projectId: 'project-a',
      environmentId: 'env-a',
      executionRoot: process.cwd()
    }),
    authorizeOperation: async (_intent, execute) => ({
      ok: true,
      value: await execute(_intent as never),
      reason: 'user-allowed',
      scope: 'once'
    }),
    getPointerGeometry: () => geometryBox.current,
    acceptHostBrowserPointer,
    clearHostBrowserPointer
  })
  service.setOpen('task-1', 'project-a', true)
  if (options?.viewBounds !== undefined || !options || !('viewBounds' in options)) {
    service.updateBounds(options?.viewBounds ?? POINTER_VIEW_BOUNDS)
  }
  return {
    service,
    guest,
    acceptHostBrowserPointer,
    clearHostBrowserPointer,
    emptyQuads,
    geometryBox
  }
}

async function snapshotThenClick(service: HostBrowserService): Promise<HostBrowserActionResult> {
  await service.perform('task-1', {
    name: 'browser_navigate',
    arguments: { url: 'https://example.com' }
  })
  await service.perform('task-1', { name: 'browser_snapshot' })
  return service.perform('task-1', { name: 'browser_click', arguments: { ref: 'e1' } })
}

describe('HostBrowserService overlay 指针', () => {
  it('成功 click 后把 viewport CSS 映射为 overlay DIP', async () => {
    const { service, acceptHostBrowserPointer, clearHostBrowserPointer } = createPointerService()
    const result = await snapshotThenClick(service)
    expect(result.ok).toBe(true)
    if (!result.ok || result.data.kind !== 'clicked') throw new Error('需要 clicked')
    expect(result.data.viewportX).toBe(10)
    expect(result.data.viewportY).toBe(10)
    expect(acceptHostBrowserPointer).toHaveBeenCalledTimes(1)
    expect(acceptHostBrowserPointer).toHaveBeenCalledWith({
      pointer: { x: 310, y: 130 },
      taskId: 'task-1',
      turnId: 'turn-1'
    })
    expect(clearHostBrowserPointer).not.toHaveBeenCalled()
    expect(JSON.stringify(acceptHostBrowserPointer.mock.calls)).not.toContain('viewportX')
  })

  it('成功 click_xy 后同样把 viewport CSS 映射为 overlay DIP', async () => {
    const { service, acceptHostBrowserPointer, clearHostBrowserPointer } = createPointerService()
    await service.perform('task-1', {
      name: 'browser_navigate',
      arguments: { url: 'https://example.com' }
    })
    const result = await service.perform('task-1', {
      name: 'browser_click_xy',
      arguments: { x: 10, y: 10 }
    })
    expect(result.ok).toBe(true)
    if (!result.ok || result.data.kind !== 'clicked') throw new Error('需要 clicked')
    expect(result.data.viewportX).toBe(10)
    expect(result.data.viewportY).toBe(10)
    expect(acceptHostBrowserPointer).toHaveBeenCalledWith({
      pointer: { x: 310, y: 130 },
      taskId: 'task-1',
      turnId: 'turn-1'
    })
    expect(clearHostBrowserPointer).not.toHaveBeenCalled()
  })

  it('type 缺少 viewport 点时不画也不清闲置指针', async () => {
    const emptyQuads = { current: false }
    const { service, acceptHostBrowserPointer, clearHostBrowserPointer } = createPointerService({
      emptyQuads
    })
    await snapshotThenClick(service)
    expect(acceptHostBrowserPointer).toHaveBeenCalledTimes(1)
    emptyQuads.current = true
    const typed = await service.perform('task-1', {
      name: 'browser_type',
      arguments: { ref: 'e1', text: 'hello' }
    })
    expect(typed.ok).toBe(true)
    if (!typed.ok || typed.data.kind !== 'typed') throw new Error('需要 typed')
    expect(typed.data.viewportX).toBeUndefined()
    expect(acceptHostBrowserPointer).toHaveBeenCalledTimes(1)
    expect(clearHostBrowserPointer).not.toHaveBeenCalled()
  })

  it('映射失败或点在 view 外则省略 pointer，不得发明光标', async () => {
    const { service, acceptHostBrowserPointer } = createPointerService({
      viewBounds: { x: 0, y: 0, width: 5, height: 5 }
    })
    await snapshotThenClick(service)
    expect(acceptHostBrowserPointer).not.toHaveBeenCalled()
  })

  it('关闭右栏或销毁 guest 时清针', async () => {
    const { service, clearHostBrowserPointer } = createPointerService()
    await snapshotThenClick(service)
    service.setOpen('task-1', 'project-a', false)
    expect(clearHostBrowserPointer).toHaveBeenCalledTimes(1)
    service.destroy()
    expect(clearHostBrowserPointer).toHaveBeenCalledTimes(2)
  })

  it('纯 navigate 不移动光标', async () => {
    const { service, acceptHostBrowserPointer } = createPointerService()
    await service.perform('task-1', {
      name: 'browser_navigate',
      arguments: { url: 'https://example.com' }
    })
    expect(acceptHostBrowserPointer).not.toHaveBeenCalled()
  })

  it('同一 CSS 点在 contentBounds 平移后重映射为新 DIP', async () => {
    const { service, acceptHostBrowserPointer, geometryBox } = createPointerService()
    await snapshotThenClick(service)
    expect(acceptHostBrowserPointer).toHaveBeenLastCalledWith({
      pointer: { x: 310, y: 130 },
      taskId: 'task-1',
      turnId: 'turn-1'
    })
    geometryBox.current = {
      contentBounds: { x: 150, y: 100, width: 1200, height: 700 },
      overlayBounds: POINTER_OVERLAY_BOUNDS,
      zoomFactor: 1
    }
    service.remapHostBrowserPointer()
    expect(acceptHostBrowserPointer).toHaveBeenLastCalledWith({
      pointer: { x: 360, y: 150 },
      taskId: 'task-1',
      turnId: 'turn-1'
    })
  })

  it('几何变化后点落在 view 外则清针，不得留下旧 DIP', async () => {
    const { service, acceptHostBrowserPointer, clearHostBrowserPointer } = createPointerService()
    await snapshotThenClick(service)
    expect(acceptHostBrowserPointer).toHaveBeenCalledTimes(1)
    service.updateBounds({ x: 0, y: 0, width: 5, height: 5 })
    expect(clearHostBrowserPointer).toHaveBeenCalled()
    acceptHostBrowserPointer.mockClear()
    service.remapHostBrowserPointer()
    expect(acceptHostBrowserPointer).not.toHaveBeenCalled()
  })

  it('切换 Task 后清针，remap 不得把旧针画回来', async () => {
    const { service, acceptHostBrowserPointer, clearHostBrowserPointer } = createPointerService()
    await snapshotThenClick(service)
    service.noteActiveTask('task-2')
    expect(clearHostBrowserPointer).toHaveBeenCalled()
    acceptHostBrowserPointer.mockClear()
    service.remapHostBrowserPointer()
    expect(acceptHostBrowserPointer).not.toHaveBeenCalled()
  })
})

describe('createElectronHostBrowserBindings', () => {
  it('窗口已销毁时 detach 不得碰 contentView', () => {
    const removeChildView = vi.fn(() => {
      throw new TypeError('Object has been destroyed')
    })
    const window = {
      isDestroyed: () => true,
      contentView: {
        addChildView: vi.fn(),
        removeChildView
      }
    }
    const bindings = createElectronHostBrowserBindings(() => window as never)
    const guest = Object.assign(createFakeGuest('project-a'), { nativeView: { id: 'view-a' } })
    expect(() => bindings.detachGuest(guest)).not.toThrow()
    expect(removeChildView).not.toHaveBeenCalled()
  })

  it('主窗 closed 后销毁已挂载 guest 不得抛 Object has been destroyed', () => {
    let destroyed = false
    const addChildView = vi.fn()
    const removeChildView = vi.fn(() => {
      if (destroyed) throw new TypeError('Object has been destroyed')
    })
    const window = {
      isDestroyed: () => destroyed,
      contentView: { addChildView, removeChildView }
    }
    const bindings = createElectronHostBrowserBindings(() => window as never)
    const guest = Object.assign(createFakeGuest('project-a'), { nativeView: { id: 'view-a' } })
    const service = new HostBrowserService({
      createGuest: () => guest,
      attachGuest: bindings.attachGuest,
      detachGuest: bindings.detachGuest
    })

    service.userNavigate('task-1', 'project-a', 'https://example.com')
    service.updateBounds({ x: 100, y: 40, width: 480, height: 720 })
    expect(addChildView).toHaveBeenCalledTimes(1)

    destroyed = true
    expect(() => service.destroy()).not.toThrow()
    expect(guest.destroyed).toBe(true)
    expect(removeChildView).not.toHaveBeenCalled()
  })

  it('removeChildView 在销毁竞态下抛错时 detach 必须吞掉', () => {
    const removeChildView = vi.fn(() => {
      throw new TypeError('Object has been destroyed')
    })
    const window = {
      isDestroyed: () => false,
      contentView: {
        addChildView: vi.fn(),
        removeChildView
      }
    }
    const bindings = createElectronHostBrowserBindings(() => window as never)
    const guest = Object.assign(createFakeGuest('project-a'), { nativeView: { id: 'view-a' } })
    expect(() => bindings.detachGuest(guest)).not.toThrow()
    expect(removeChildView).toHaveBeenCalledTimes(1)
  })

  it('detach 遇到其它错误仍要抛出', () => {
    const removeChildView = vi.fn(() => {
      throw new Error('contentView missing')
    })
    const window = {
      isDestroyed: () => false,
      contentView: {
        addChildView: vi.fn(),
        removeChildView
      }
    }
    const bindings = createElectronHostBrowserBindings(() => window as never)
    const guest = Object.assign(createFakeGuest('project-a'), { nativeView: { id: 'view-a' } })
    expect(() => bindings.detachGuest(guest)).toThrow('contentView missing')
  })
})

describe('截图像素对齐纪律', () => {
  it('capturePng 按 PNG IHDR 缩放，不得用 NativeImage.getSize 当像素', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'host-browser-service.ts'),
      'utf8'
    )
    expect(source).toContain("from './host-browser-screenshot'")
    expect(source).toContain('alignScreenshotPngToViewportCss')
    expect(source).toContain('scaleFactor: 1')
    expect(source).toContain('Page.getLayoutMetrics')
    expect(source).toContain('parseCssViewportFromLayoutMetrics')
    expect(source).not.toContain('image.getSize()')
  })
})
