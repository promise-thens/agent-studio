import { describe, expect, it } from 'vitest'
import {
  createAgentPointerSnapshot,
  mapViewportCssToOverlayDip,
  parseAgentPointerSnapshot,
  resolveAgentPointerHudCopy,
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
      shouldRenderAgentPointerCursor({
        visible: true,
        surface: 'host-browser',
        persistWhenUnfocused: false,
        pointer: { x: 1, y: 1 }
      })
    ).toBe(true)
  })
})

describe('createAgentPointerSnapshot / parseAgentPointerSnapshot', () => {
  it('host-browser 可保留有限 pointer；browser-plugin 恒丢弃 pointer', () => {
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
    expect(plugin.pointer).toBeUndefined()
    expect(plugin).not.toHaveProperty('pointer')
    expect(plugin.surface).toBe('browser-plugin')

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
      persistWhenUnfocused: false
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
