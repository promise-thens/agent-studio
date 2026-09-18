import { describe, expect, it } from 'vitest'
import {
  createAgentPointerSnapshot,
  mapViewportCssToOverlayDip,
  parseAgentPointerSnapshot,
  isAgentPointerTurnActive,
  resolveAgentPointerHudCopy,
  resolveOverlayDisplayBounds,
  shouldRenderAgentPointerCursor,
  HOST_BROWSER_HUD_COPY,
  BROWSER_PLUGIN_HUD_COPY
} from './agent-pointer-overlay'

describe('mapViewportCssToOverlayDip', () => {
  it('把 view 内 CSS 点映射为 overlay 本地 DIP', () => {
    const pointer = mapViewportCssToOverlayDip({
      cssX: 40,
      cssY: 60,
      zoomFactor: 1,
      contentBounds: { x: 100, y: 80, width: 1200, height: 700 },
      viewBounds: { x: 200, y: 40, width: 640, height: 640 },
      overlayBounds: { x: 0, y: 0, width: 1440, height: 900 }
    })
    expect(pointer).toEqual({ x: 340, y: 180 })
  })

  it('点在 view 矩形外则不投影', () => {
    expect(
      mapViewportCssToOverlayDip({
        cssX: 9000,
        cssY: 10,
        zoomFactor: 1,
        contentBounds: { x: 0, y: 0, width: 800, height: 600 },
        viewBounds: { x: 0, y: 0, width: 400, height: 400 },
        overlayBounds: { x: 0, y: 0, width: 800, height: 600 }
      })
    ).toBeUndefined()
  })

  it('按 zoomFactor 把 CSS 换算成 DIP；非有限或 <=0 失败', () => {
    const base = {
      cssX: 80,
      cssY: 40,
      contentBounds: { x: 0, y: 0, width: 800, height: 600 },
      viewBounds: { x: 100, y: 50, width: 400, height: 400 },
      overlayBounds: { x: 0, y: 0, width: 800, height: 600 }
    }
    expect(mapViewportCssToOverlayDip({ ...base, zoomFactor: 2 })).toEqual({ x: 140, y: 70 })
    expect(mapViewportCssToOverlayDip({ ...base, zoomFactor: 0 })).toBeUndefined()
    expect(mapViewportCssToOverlayDip({ ...base, zoomFactor: -1 })).toBeUndefined()
    expect(mapViewportCssToOverlayDip({ ...base, zoomFactor: Number.NaN })).toBeUndefined()
    expect(
      mapViewportCssToOverlayDip({ ...base, zoomFactor: Number.POSITIVE_INFINITY })
    ).toBeUndefined()
  })

  it('主窗在副屏时按副屏 overlay 原点映射，不得沿用主屏 (0,0)', () => {
    const pointer = mapViewportCssToOverlayDip({
      cssX: 40,
      cssY: 60,
      zoomFactor: 1,
      contentBounds: { x: 2000, y: 80, width: 1200, height: 700 },
      viewBounds: { x: 200, y: 40, width: 640, height: 640 },
      overlayBounds: { x: 1920, y: 0, width: 2560, height: 1440 }
    })
    expect(pointer).toEqual({ x: 320, y: 180 })
  })
})

describe('resolveOverlayDisplayBounds', () => {
  const primary = { x: 0, y: 0, width: 1440, height: 900 }
  const secondary = { x: 1920, y: 0, width: 2560, height: 1440 }

  it('主窗大部分落在副屏时覆盖副屏，不得钉死主屏', () => {
    expect(
      resolveOverlayDisplayBounds({
        windowBounds: { x: 2000, y: 80, width: 1200, height: 800 },
        displays: [primary, secondary]
      })
    ).toEqual(secondary)
  })

  it('无交集时选中心更近的那块屏', () => {
    expect(
      resolveOverlayDisplayBounds({
        windowBounds: { x: 4000, y: 10, width: 100, height: 100 },
        displays: [primary, secondary]
      })
    ).toEqual(secondary)
  })

  it('没有有效显示器则不发明矩形', () => {
    expect(
      resolveOverlayDisplayBounds({
        windowBounds: { x: 0, y: 0, width: 800, height: 600 },
        displays: []
      })
    ).toBeUndefined()
  })
})

describe('HUD', () => {
  it('宿主进行中用内置浏览器句；插件用原句；接管优先', () => {
    expect(
      resolveAgentPointerHudCopy({
        surface: 'host-browser',
        overlayVisible: true,
        turnActive: true,
        takeoverCopy: null
      })
    ).toBe('Grok 正在使用内置浏览器')
    expect(HOST_BROWSER_HUD_COPY).toBe('Grok 正在使用内置浏览器')
    expect(
      resolveAgentPointerHudCopy({
        surface: 'browser-plugin',
        overlayVisible: true,
        turnActive: true,
        takeoverCopy: null
      })
    ).toBe(BROWSER_PLUGIN_HUD_COPY)
    expect(
      resolveAgentPointerHudCopy({
        surface: 'host-browser',
        overlayVisible: true,
        turnActive: true,
        takeoverCopy: '完全访问中，不再询问权限'
      })
    ).toBe('完全访问中，不再询问权限')
    expect(
      resolveAgentPointerHudCopy({
        surface: 'host-browser',
        overlayVisible: true,
        turnActive: false,
        takeoverCopy: null
      })
    ).toBeNull()
    expect(
      isAgentPointerTurnActive({
        visible: true,
        surface: 'host-browser',
        taskId: 'task-1',
        turnId: 'turn-1'
      })
    ).toBe(false)
    expect(
      isAgentPointerTurnActive({
        visible: true,
        surface: 'host-browser',
        taskId: 'task-1',
        turnId: 'turn-1',
        executionId: 'execution-1'
      })
    ).toBe(true)
    expect(
      isAgentPointerTurnActive({
        visible: true,
        surface: 'browser-plugin'
      })
    ).toBe(false)
    expect(
      isAgentPointerTurnActive({
        visible: true,
        surface: 'browser-plugin',
        taskId: 'task-1',
        turnId: 'turn-1',
        executionId: 'execution-1'
      })
    ).toBe(true)
    expect(
      resolveAgentPointerHudCopy({
        surface: 'browser-plugin',
        overlayVisible: true,
        turnActive: false,
        takeoverCopy: null
      })
    ).toBeNull()
    expect(
      shouldRenderAgentPointerCursor({
        visible: true,
        surface: 'host-browser',
        persistWhenUnfocused: false,
        pointer: { x: 1, y: 1 }
      })
    ).toBe(true)
    expect(
      shouldRenderAgentPointerCursor({
        visible: true,
        surface: 'browser-plugin',
        persistWhenUnfocused: false,
        pointer: { x: 12, y: 34 }
      })
    ).toBe(true)
    expect(
      shouldRenderAgentPointerCursor({
        visible: true,
        surface: 'browser-plugin',
        persistWhenUnfocused: false
      })
    ).toBe(false)
  })
})

describe('createAgentPointerSnapshot / parseAgentPointerSnapshot', () => {
  it('host-browser 与配套扩展有限 DIP 保留；browser-plugin 无几何仍丢弃', () => {
    const host = createAgentPointerSnapshot({
      visible: true,
      surface: 'host-browser',
      persistWhenUnfocused: false,
      taskId: 'task-1',
      pointer: { x: 12.5, y: 30 }
    })
    expect(host).toEqual({
      visible: true,
      surface: 'host-browser',
      persistWhenUnfocused: false,
      taskId: 'task-1',
      pointer: { x: 12.5, y: 30 }
    })

    const plugin = createAgentPointerSnapshot({
      visible: true,
      surface: 'browser-plugin',
      persistWhenUnfocused: false,
      pointer: { x: 1, y: 2 }
    })
    expect(plugin.pointer).toEqual({ x: 1, y: 2 })
    expect(plugin.surface).toBe('browser-plugin')

    const pluginWithoutGeometry = createAgentPointerSnapshot({
      visible: true,
      surface: 'browser-plugin',
      persistWhenUnfocused: false
    })
    expect(pluginWithoutGeometry.pointer).toBeUndefined()
    expect(pluginWithoutGeometry).not.toHaveProperty('pointer')

    expect(
      parseAgentPointerSnapshot({
        visible: true,
        surface: 'host-browser',
        persistWhenUnfocused: false,
        pointer: { x: 9, y: 8 },
        runtimeSessionId: 'secret'
      })
    ).toEqual({
      visible: true,
      surface: 'host-browser',
      persistWhenUnfocused: false,
      pointer: { x: 9, y: 8 }
    })

    expect(
      parseAgentPointerSnapshot({
        visible: true,
        surface: 'browser-plugin',
        persistWhenUnfocused: false,
        pointer: { x: 9, y: 8 }
      })
    ).toEqual({
      visible: true,
      surface: 'browser-plugin',
      persistWhenUnfocused: false,
      pointer: { x: 9, y: 8 }
    })
  })

  it('非有限 pointer 或不完整坐标不得保留；computer-use 不得经 create 产出', () => {
    expect(
      createAgentPointerSnapshot({
        visible: true,
        surface: 'host-browser',
        persistWhenUnfocused: false,
        pointer: { x: Number.NaN, y: 1 }
      })
    ).not.toHaveProperty('pointer')

    expect(
      parseAgentPointerSnapshot({
        visible: true,
        surface: 'host-browser',
        persistWhenUnfocused: false,
        pointer: { x: 1, y: '2' }
      })
    ).not.toHaveProperty('pointer')

    // computer-use 仅类型联合成员；本波无 producer，create 入参类型也不接受该 surface
    expect(
      parseAgentPointerSnapshot({
        visible: true,
        surface: 'computer-use',
        persistWhenUnfocused: true,
        pointer: { x: 1, y: 1 }
      })
    ).toBeNull()
  })
})
