import { describe, expect, it } from 'vitest'
import { HOST_BROWSER_HUD_COPY } from './agent-pointer-overlay'
import {
  BROWSER_PLUGIN_HUD_COPY,
  createBrowserPluginOverlaySnapshot,
  parseBrowserPluginOverlaySnapshot,
  projectBrowserPluginPointer,
  resolveBrowserPluginHudCopy,
  shouldRenderBrowserPluginCursor,
  type BrowserPluginOverlaySnapshot
} from './browser-plugin-overlay'

describe('resolveBrowserPluginHudCopy', () => {
  it('写文件进行中不出浏览器 HUD，有三元组才出停止文案', () => {
    expect(resolveBrowserPluginHudCopy({ takeoverCopy: null, overlayVisible: false })).toBeNull()
    expect(resolveBrowserPluginHudCopy({ takeoverCopy: null, overlayVisible: true })).toBeNull()
    expect(
      resolveBrowserPluginHudCopy({
        takeoverCopy: null,
        overlayVisible: true,
        turnActive: true
      })
    ).toBe('Grok 正在使用浏览器插件')
    expect(
      resolveBrowserPluginHudCopy({
        takeoverCopy: '完全访问中，不再询问权限',
        overlayVisible: true
      })
    ).toBe('完全访问中，不再询问权限')
  })

  it('只消费快照 visible；写文件快照不得冒充浏览器句', () => {
    const writeFileSnapshot: BrowserPluginOverlaySnapshot = { visible: false }
    const browserSnapshot: BrowserPluginOverlaySnapshot = { visible: true }
    expect(BROWSER_PLUGIN_HUD_COPY).toBe('Grok 正在使用浏览器插件')
    expect(
      resolveBrowserPluginHudCopy({
        takeoverCopy: null,
        overlayVisible: writeFileSnapshot.visible
      })
    ).toBeNull()
    expect(
      resolveBrowserPluginHudCopy({
        takeoverCopy: null,
        overlayVisible: browserSnapshot.visible,
        turnActive: true
      })
    ).toBe(BROWSER_PLUGIN_HUD_COPY)
  })

  it('host-browser idle snapshot visible:true 不得出插件 HUD', () => {
    // 闲置宿主针：有光标、无 executionId；主窗口不得冒充插件句或宿主进行中句
    const idleHost: BrowserPluginOverlaySnapshot = {
      visible: true,
      kind: 'browser',
      surface: 'host-browser',
      persistWhenUnfocused: false,
      pointer: { x: 310, y: 130 },
      taskId: 'task-1',
      turnId: 'turn-1'
    }
    expect(idleHost.visible).toBe(true)
    expect(idleHost.executionId).toBeUndefined()
    expect(
      resolveBrowserPluginHudCopy({
        takeoverCopy: null,
        overlayVisible: idleHost.visible,
        surface: idleHost.surface,
        turnActive: Boolean(idleHost.executionId && idleHost.taskId && idleHost.turnId)
      })
    ).toBeNull()
  })

  it('host-browser 进行中才出内置浏览器句；插件进行中仍用原句', () => {
    expect(
      resolveBrowserPluginHudCopy({
        takeoverCopy: null,
        overlayVisible: true,
        surface: 'host-browser',
        turnActive: true
      })
    ).toBe(HOST_BROWSER_HUD_COPY)
    expect(
      resolveBrowserPluginHudCopy({
        takeoverCopy: null,
        overlayVisible: true,
        surface: 'browser-plugin',
        turnActive: true
      })
    ).toBe(BROWSER_PLUGIN_HUD_COPY)
  })
})

describe('projectBrowserPluginPointer', () => {
  const bounds = { width: 1440, height: 900 }

  it('只拷贝冻结的有限数字坐标，未知键与非数字没有 pointer', () => {
    // 任务 1：ACP x/y、coordinate、position 均为 not-observed，且 click_at 是 viewport-css。
    expect(projectBrowserPluginPointer({ x: 120, y: 80 }, bounds)).toBeUndefined()
    expect(projectBrowserPluginPointer({ coordinate: { x: 120, y: 80 } }, bounds)).toBeUndefined()
    expect(projectBrowserPluginPointer({ position: { x: 120, y: 80 } }, bounds)).toBeUndefined()
    expect(projectBrowserPluginPointer({ x: '120', y: 80 }, bounds)).toBeUndefined()
    expect(projectBrowserPluginPointer({ _meta: { x: 1, y: 1 } }, bounds)).toBeUndefined()
    expect(projectBrowserPluginPointer({ x: Number.NaN, y: 0 }, bounds)).toBeUndefined()
    expect(projectBrowserPluginPointer({ x: 10_000_000, y: 0 }, bounds)).toBeUndefined()
    expect(projectBrowserPluginPointer({ tool_input: { x: 120, y: 80 } }, bounds)).toBeUndefined()
  })
})

describe('createBrowserPluginOverlaySnapshot', () => {
  it('无 pointer 时快照不得带 pointer 字段', () => {
    const snapshot = createBrowserPluginOverlaySnapshot({
      visible: true,
      taskId: 'task-1',
      pointer: undefined
    })
    expect(snapshot.pointer).toBeUndefined()
    expect(snapshot).not.toHaveProperty('pointer')
    expect(snapshot.kind).toBe('browser')
    expect(shouldRenderBrowserPluginCursor(snapshot)).toBe(false)
  })

  it('即使传入有限坐标也不得写入 pointer（共享层消费后仍冻结）', () => {
    const snapshot = createBrowserPluginOverlaySnapshot({
      visible: true,
      pointer: { x: 120, y: 80 }
    })
    expect(snapshot).toEqual({ visible: true, kind: 'browser' })
    expect(shouldRenderBrowserPluginCursor(snapshot)).toBe(false)
  })

  it('解析时丢掉未知键，缺 pointer 不得补造光标', () => {
    expect(
      parseBrowserPluginOverlaySnapshot({
        visible: true,
        kind: 'browser',
        taskId: 'task-1',
        runtimeSessionId: 'secret',
        pointer: { x: 1, y: 2 }
      })
    ).toEqual({
      visible: true,
      kind: 'browser',
      taskId: 'task-1'
    })
    expect(parseBrowserPluginOverlaySnapshot({ visible: false, kind: 'browser' })).toEqual({
      visible: false,
      kind: 'browser'
    })
  })

  it('host-browser 通道保留已映射 DIP，插件路径仍剥离 pointer', () => {
    expect(
      parseBrowserPluginOverlaySnapshot({
        visible: true,
        kind: 'browser',
        surface: 'host-browser',
        persistWhenUnfocused: false,
        pointer: { x: 310, y: 130 },
        taskId: 'task-1'
      })
    ).toEqual({
      visible: true,
      kind: 'browser',
      surface: 'host-browser',
      persistWhenUnfocused: false,
      pointer: { x: 310, y: 130 },
      taskId: 'task-1'
    })
  })
})
