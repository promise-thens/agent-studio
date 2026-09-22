import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  BROWSER_FOCUS_CHANNELS as channels,
  type BrowserFocusSnapshot
} from '../../shared/browser-focus-overlay'

const mocks = vi.hoisted(() => ({
  windows: [] as unknown[],
  nextLoadUrl: null as null | ((url: string) => Promise<void>)
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    options: unknown
    visible = false
    focused = false
    destroyed = false
    minimized = false
    bounds = { x: -1500, y: 100, width: 1200, height: 800 }
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '', isDestroyed: () => false, send: vi.fn() },
      send: vi.fn(),
      isDestroyed: () => false,
      getZoomFactor: () => 1,
      setWindowOpenHandler: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
    })
    constructor(options: unknown) {
      super()
      this.options = options
      mocks.windows.push(this)
    }
    isDestroyed = vi.fn((): boolean => this.destroyed)
    isVisible = (): boolean => this.visible
    isFocused = (): boolean => this.focused
    isMinimized = (): boolean => this.minimized
    getContentBounds = (): typeof this.bounds => this.bounds
    setBounds = vi.fn()
    showInactive = vi.fn(() => {
      this.visible = true
    })
    hide = vi.fn(() => {
      this.visible = false
    })
    destroy = vi.fn(() => {
      this.destroyed = true
      this.emit('closed')
    })
    loadURL = vi.fn(async (url: string) => {
      const nextLoadUrl = mocks.nextLoadUrl
      mocks.nextLoadUrl = null
      if (nextLoadUrl) return nextLoadUrl(url)
      this.webContents.mainFrame.url = url
    })
  }
  return { BrowserWindow: Window }
})
import { BrowserWindow as MockWindow } from 'electron'
import {
  BrowserFocusOverlay,
  resolveBrowserFocusBounds,
  BROWSER_FOCUS_OVERLAY_HEIGHT
} from './browser-focus-overlay'

type FakeWindow = EventEmitter & {
  visible: boolean
  focused: boolean
  minimized: boolean
  destroyed: boolean
  options: Record<string, unknown>
  webContents: EventEmitter & {
    mainFrame: { url: string; send: ReturnType<typeof vi.fn> }
    send: ReturnType<typeof vi.fn>
  }
  isDestroyed: ReturnType<typeof vi.fn<() => boolean>>
  showInactive: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

const state: BrowserFocusSnapshot = {
  projectionId: 'projection-1',
  taskId: 'task-1',
  revision: 1,
  draftAck: 0,
  visible: true,
  draft: '草稿',
  taskTitle: '当前任务',
  status: '',
  modelLabel: 'actual-model',
  attachmentCount: 0,
  canSend: true,
  textareaDisabled: false,
  execution: null,
  theme: 'dark',
  browserBounds: { x: 220, y: 80, width: 980, height: 720 },
  latestAssistantMessage: null
}
const executionA = { executionId: 'execution-a', taskId: 'task-1', turnId: 'turn-a' }
const executionB = { executionId: 'execution-b', taskId: 'task-1', turnId: 'turn-b' }

function setup(): {
  host: BrowserFocusOverlay
  parent: FakeWindow
  call: (
    channel: string,
    sender: FakeWindow,
    ...args: unknown[]
  ) => Promise<{ ok: boolean; error?: { code: string }; value?: unknown }>
  handlers: Map<string, (...args: unknown[]) => unknown>
} {
  const parent = new MockWindow() as unknown as FakeWindow
  parent.visible = true
  parent.focused = true
  parent.webContents.mainFrame.url = 'file:///app/index.html'
  const host = new BrowserFocusOverlay({
    parent: parent as unknown as BrowserWindow,
    ownerTrust: {
      getMainWindow: () => parent as unknown as BrowserWindow,
      productionFileUrl: 'file:///app/index.html'
    },
    preloadPath: '/app/preload/browser-focus-overlay.js',
    productionHtmlPath: '/app/browser-focus-overlay.html'
  })
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  host.registerIpc({
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel)
    }
  } as unknown as IpcMain)
  return {
    parent,
    host,
    handlers,
    call: async (channel, sender, ...args) =>
      (await handlers.get(channel)?.(
        {
          sender: sender.webContents,
          senderFrame: sender.webContents.mainFrame
        } as unknown as IpcMainInvokeEvent,
        ...args
      )) as { ok: boolean; error?: { code: string }; value?: unknown }
  }
}
const child = (): FakeWindow => mocks.windows[1] as FakeWindow

beforeEach(() => {
  mocks.windows.length = 0
  mocks.nextLoadUrl = null
})

describe('原生覆盖输入窗口', () => {
  it('创建父属可交互沙箱子窗，不改变底层网页几何', async () => {
    const { parent, host, call } = setup()
    expect((await call(channels.publish, parent, state)).ok).toBe(true)
    expect(child().options).toMatchObject({
      parent,
      frame: false,
      transparent: true,
      focusable: true,
      hasShadow: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        preload: '/app/preload/browser-focus-overlay.js'
      }
    })
    expect(child().options).not.toHaveProperty('alwaysOnTop')
    expect(child().setBounds).toHaveBeenLastCalledWith({
      x: -1150,
      y: 448,
      width: 720,
      height: BROWSER_FOCUS_OVERLAY_HEIGHT
    })
    expect(child().showInactive).toHaveBeenCalled()
    host.destroy()
  })
  it('首次发布可见投影时父子均未报告焦点也能显示', async () => {
    const { parent, host, call } = setup()
    parent.focused = false
    expect((await call(channels.publish, parent, state)).ok).toBe(true)
    expect(child().focused).toBe(false)
    expect(child().visible).toBe(true)
    expect(child().showInactive).toHaveBeenCalledTimes(1)
    host.destroy()
  })
  it('拒绝网页、子 frame、错误页面和子窗发布主状态', async () => {
    const { parent, call, handlers, host } = setup()
    await call(channels.publish, parent, state)
    expect((await call(channels.publish, child(), state)).error?.code).toBe('forbidden')
    expect(
      (
        await call(channels.intent, parent, {
          kind: 'send',
          projectionId: 'projection-1',
          revision: 1
        })
      ).error?.code
    ).toBe('forbidden')
    const subframe = (await handlers.get(channels.read)?.({
      sender: child().webContents,
      senderFrame: { url: 'file:///app/browser-focus-overlay.html' }
    })) as { ok: boolean }
    expect(subframe.ok).toBe(false)
    child().webContents.mainFrame.url = 'file:///app/other.html'
    expect((await call(channels.read, child())).error?.code).toBe('forbidden')
    host.destroy()
  })
  it('编辑确认前不能发送，确认后只转发一次相同版本操作', async () => {
    const { parent, call, host } = setup()
    await call(channels.publish, parent, state)
    const base = { projectionId: 'projection-1', revision: 1 }
    expect(
      (
        await call(channels.intent, child(), {
          ...base,
          kind: 'draft',
          sequence: 1,
          text: '新草稿'
        })
      ).ok
    ).toBe(true)
    expect((await call(channels.intent, child(), { ...base, kind: 'send' })).ok).toBe(false)
    await call(channels.publish, parent, { ...state, revision: 2, draftAck: 1, draft: '新草稿' })
    expect((await call(channels.intent, child(), { ...base, revision: 2, kind: 'send' })).ok).toBe(
      true
    )
    expect((await call(channels.intent, child(), { ...base, revision: 2, kind: 'send' })).ok).toBe(
      false
    )
    expect(parent.webContents.mainFrame.send).toHaveBeenCalledWith(channels.ownerIntent, {
      ...base,
      revision: 2,
      kind: 'send'
    })
    host.destroy()
  })
  it('过期投影、非法字段、重复序号、无执行停止均拒绝', async () => {
    const { parent, call, host } = setup()
    await call(channels.publish, parent, state)
    const base = { projectionId: state.projectionId, revision: 1 }
    expect((await call(channels.publish, parent, state)).ok).toBe(false)
    expect((await call(channels.intent, child(), { ...base, kind: 'stop' })).ok).toBe(false)
    expect(
      (await call(channels.intent, child(), { ...base, kind: 'stop', execution: executionA })).ok
    ).toBe(false)
    expect(
      (await call(channels.intent, child(), { ...base, kind: 'draft', sequence: 0, text: '旧值' }))
        .ok
    ).toBe(false)
    expect(
      (await call(channels.intent, child(), { ...base, kind: 'send', taskId: 'forged' })).ok
    ).toBe(false)
    await call(channels.publish, parent, {
      ...state,
      projectionId: 'projection-2',
      taskId: 'task-2'
    })
    expect((await call(channels.intent, child(), { ...base, kind: 'send' })).ok).toBe(false)
    host.destroy()
  })
  it('同一执行的旧版本 Stop 可转发一次，Send 与 Expand 仍要求最新版本', async () => {
    const { parent, call, host } = setup()
    await call(channels.publish, parent, { ...state, execution: executionA })
    const staleStop = {
      kind: 'stop' as const,
      projectionId: state.projectionId,
      revision: 1,
      execution: executionA
    }
    await call(channels.publish, parent, { ...state, revision: 2, execution: executionA })

    expect(
      (
        await call(channels.intent, child(), {
          kind: 'send',
          projectionId: state.projectionId,
          revision: 1
        })
      ).ok
    ).toBe(false)
    expect(
      (
        await call(channels.intent, child(), {
          kind: 'expand',
          projectionId: state.projectionId,
          revision: 1
        })
      ).ok
    ).toBe(false)
    expect((await call(channels.intent, child(), staleStop)).ok).toBe(true)
    expect((await call(channels.intent, child(), staleStop)).ok).toBe(false)
    expect(parent.webContents.mainFrame.send).toHaveBeenCalledTimes(1)
    expect(parent.webContents.mainFrame.send).toHaveBeenCalledWith(channels.ownerIntent, staleStop)
    host.destroy()
  })
  it('执行已变化、任务不匹配或未来版本时拒绝旧 Stop', async () => {
    const { parent, call, host } = setup()
    await call(channels.publish, parent, { ...state, execution: executionA })
    await call(channels.publish, parent, { ...state, revision: 2, execution: executionB })
    const base = { kind: 'stop' as const, projectionId: state.projectionId }

    expect(
      (await call(channels.intent, child(), { ...base, revision: 1, execution: executionA })).ok
    ).toBe(false)
    expect(
      (await call(channels.intent, child(), { ...base, revision: 3, execution: executionB })).ok
    ).toBe(false)
    expect(
      (
        await call(channels.intent, child(), {
          ...base,
          revision: 2,
          execution: { ...executionB, taskId: 'task-forged' }
        })
      ).ok
    ).toBe(false)
    expect(parent.webContents.mainFrame.send).not.toHaveBeenCalled()
    host.destroy()
  })
  it('父子窗口组内切焦不闪烁，离开后隐藏并可由 focus 事件恢复', async () => {
    const { parent, call, host, handlers } = setup()
    await call(channels.publish, parent, state)
    parent.emit('move')
    expect(child().setBounds).toHaveBeenCalledTimes(2)
    parent.focused = false
    child().focused = true
    parent.emit('blur')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(child().visible).toBe(true)
    child().focused = false
    child().emit('focus')
    parent.emit('blur')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(child().visible).toBe(true)
    child().focused = false
    child().emit('blur')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(child().visible).toBe(false)
    parent.emit('focus')
    expect(child().visible).toBe(true)
    parent.emit('closed')
    expect(child().destroyed).toBe(true)
    expect(handlers.size).toBe(0)
    expect(parent.listenerCount('move')).toBe(0)
    host.destroy()
  })
  it('父窗原生对象先销毁时仍完成全部清理，不中断后续 closed 监听', async () => {
    const { parent, call, host, handlers } = setup()
    await call(channels.publish, parent, state)
    const parentWebContents = parent.webContents
    Object.defineProperty(parent, 'webContents', {
      configurable: true,
      get: () => {
        if (parent.destroyed) throw new TypeError('Object has been destroyed')
        return parentWebContents
      }
    })
    const laterClosedListener = vi.fn()
    parent.on('closed', laterClosedListener)
    parent.destroyed = true
    child().destroyed = true

    expect(() => parent.emit('closed')).not.toThrow()
    expect(laterClosedListener).toHaveBeenCalledTimes(1)
    expect(handlers.size).toBe(0)
    expect(parent.listenerCount('move')).toBe(0)
    expect(child().destroy).not.toHaveBeenCalled()
    host.destroy()
  })
  it('单项清理遇到已销毁原生对象时仍撤销 IPC 并销毁子窗', async () => {
    const { parent, call, host, handlers } = setup()
    await call(channels.publish, parent, state)
    vi.spyOn(parent.webContents, 'removeListener').mockImplementationOnce(() => {
      throw new TypeError('Object has been destroyed')
    })

    expect(() => host.destroy()).not.toThrow()
    expect(handlers.size).toBe(0)
    expect(child().destroyed).toBe(true)
  })
  it('同文案的普通 Error 会在完整收尾后继续抛出', async () => {
    const { parent, call, host, handlers } = setup()
    await call(channels.publish, parent, state)
    vi.spyOn(parent.webContents, 'removeListener').mockImplementationOnce(() => {
      throw new Error('Object has been destroyed')
    })

    expect(() => host.destroy()).toThrow('Object has been destroyed')
    expect(handlers.size).toBe(0)
    expect(child().destroyed).toBe(true)
  })
  it('isDestroyed 检查后窗口消失时只吞 Electron 销毁竞态', async () => {
    const { parent, call, host, handlers } = setup()
    await call(channels.publish, parent, state)
    child().isDestroyed.mockReturnValue(false)
    child().destroy.mockImplementationOnce(() => {
      child().destroyed = true
      throw new TypeError('Object has been destroyed')
    })

    expect(() => host.destroy()).not.toThrow()
    expect(child().destroy).toHaveBeenCalledTimes(1)
    expect(handlers.size).toBe(0)
  })
  it('销毁触发子窗 blur 时不再排延迟焦点检查', async () => {
    const { parent, call, host } = setup()
    await call(channels.publish, parent, state)
    const scheduleImmediate = vi.spyOn(globalThis, 'setImmediate')
    child().destroy.mockImplementationOnce(() => {
      child().emit('blur')
      child().destroyed = true
      child().emit('closed')
    })

    try {
      host.destroy()
      expect(scheduleImmediate).not.toHaveBeenCalled()
    } finally {
      scheduleImmediate.mockRestore()
    }
  })
  it('父窗关闭后的延迟加载失败不重复销毁已脱管子窗', async () => {
    const { parent, call, host } = setup()
    let rejectLoad!: (reason?: unknown) => void
    mocks.nextLoadUrl = () =>
      new Promise<void>((_resolve, reject) => {
        rejectLoad = reject
      })
    const response = call(channels.publish, parent, state)
    await vi.waitFor(() => expect(mocks.windows).toHaveLength(2))
    const overlay = child()

    parent.emit('closed')
    expect(overlay.destroy).toHaveBeenCalledTimes(1)
    overlay.isDestroyed.mockReturnValue(false)
    rejectLoad(new Error('load failed'))

    expect((await response).error?.code).toBe('operation-failed')
    expect(overlay.destroy).toHaveBeenCalledTimes(1)
    host.destroy()
  })
  it('旧子窗迟到 closed 不覆盖新子窗的 loaded 状态', async () => {
    const { parent, call, host } = setup()
    expect((await call(channels.publish, parent, state)).ok).toBe(true)
    const previousWindow = child()
    previousWindow.destroyed = true
    previousWindow.emit('closed')

    expect((await call(channels.publish, parent, { ...state, revision: 2 })).ok).toBe(true)
    const currentWindow = mocks.windows[2] as FakeWindow
    expect(currentWindow.visible).toBe(true)
    previousWindow.emit('closed')

    expect((await call(channels.publish, parent, { ...state, revision: 3 })).ok).toBe(true)
    expect(currentWindow.visible).toBe(true)
    host.destroy()
  })
  it('旧加载 finally 不得清空新子窗仍在等待的 loading', async () => {
    const { parent, call, host } = setup()
    let rejectPreviousLoad!: (reason?: unknown) => void
    mocks.nextLoadUrl = () =>
      new Promise<void>((_resolve, reject) => {
        rejectPreviousLoad = reject
      })
    const previousResponse = call(channels.publish, parent, state)
    await vi.waitFor(() => expect(mocks.windows).toHaveLength(2))
    const previousWindow = child()
    previousWindow.destroyed = true
    previousWindow.emit('closed')

    let resolveCurrentLoad!: () => void
    mocks.nextLoadUrl = () =>
      new Promise<void>((resolve) => {
        resolveCurrentLoad = resolve
      })
    const currentResponse = call(channels.publish, parent, { ...state, revision: 2 })
    await vi.waitFor(() => expect(mocks.windows).toHaveLength(3))
    rejectPreviousLoad(new Error('previous load failed'))
    expect((await previousResponse).error?.code).toBe('operation-failed')

    let nextPublishSettled = false
    const nextResponse = call(channels.publish, parent, { ...state, revision: 3 }).then(
      (result) => {
        nextPublishSettled = true
        return result
      }
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(nextPublishSettled).toBe(false)

    resolveCurrentLoad()
    expect((await currentResponse).ok).toBe(true)
    expect((await nextResponse).ok).toBe(true)
    host.destroy()
  })
  it('最小化清除窗口组活跃态，单独 restore 不抢焦', async () => {
    const { parent, call, host } = setup()
    await call(channels.publish, parent, state)
    parent.focused = false
    parent.minimized = true
    parent.emit('minimize')
    expect(child().visible).toBe(false)
    parent.emit('focus')
    expect(child().visible).toBe(false)
    parent.minimized = false
    parent.emit('restore')
    expect(child().visible).toBe(false)
    parent.emit('focus')
    expect(child().visible).toBe(true)
    host.destroy()
  })
  it('投影临时隐藏不清窗口组活跃态，关闭阻塞界面后可原位恢复', async () => {
    const { parent, call, host } = setup()
    await call(channels.publish, parent, state)
    await call(channels.publish, parent, { ...state, revision: 2, visible: false })
    expect(child().visible).toBe(false)
    parent.focused = false
    await call(channels.publish, parent, { ...state, revision: 3 })
    expect(child().visible).toBe(true)
    host.destroy()
  })
  it('主页面刷新撤销旧草稿和操作权限', async () => {
    const { parent, call, host } = setup()
    await call(channels.publish, parent, state)
    parent.webContents.emit('did-start-loading')
    expect(child().visible).toBe(false)
    expect((await call(channels.read, child())).value).toBe(null)
    host.destroy()
  })
})

describe('输入条屏幕 DIP 几何', () => {
  it('悬浮岛采用 440px 扩展高度标准', () => {
    expect(BROWSER_FOCUS_OVERLAY_HEIGHT).toBe(440)
  })
  it('包含 zoom 与负坐标屏幕，不按物理像素重复乘缩放', () => {
    expect(
      resolveBrowserFocusBounds(
        { x: -1200, y: 0, width: 1200, height: 900 },
        { x: 100, y: 40, width: 800, height: 500 },
        1.5
      )
    ).toEqual({ x: -885, y: 358, width: 720, height: 440 })
  })
  it('越界网页夹在主窗内，尺寸太小或非法 zoom 则隐藏', () => {
    const content = { x: 0, y: 0, width: 600, height: 600 }
    expect(
      resolveBrowserFocusBounds(content, { x: 20, y: 20, width: 2000, height: 2000 }, 1)
    ).toEqual({ x: 32, y: 148, width: 556, height: 440 })
    expect(
      resolveBrowserFocusBounds(content, { x: 590, y: 20, width: 100, height: 200 }, 1)
    ).toBeNull()
    expect(resolveBrowserFocusBounds(content, state.browserBounds, NaN)).toBeNull()
  })
})
