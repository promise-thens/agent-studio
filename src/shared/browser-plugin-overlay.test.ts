import { describe, expect, it } from 'vitest'
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
  it('写文件进行中不出浏览器 HUD，browser overlay 可见时出停止文案', () => {
    expect(
      resolveBrowserPluginHudCopy({ takeoverCopy: null, overlayVisible: false })
    ).toBeNull()
    expect(
      resolveBrowserPluginHudCopy({ takeoverCopy: null, overlayVisible: true })
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
        overlayVisible: browserSnapshot.visible
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
    expect(
      projectBrowserPluginPointer({ tool_input: { x: 120, y: 80 } }, bounds)
    ).toBeUndefined()
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
})
