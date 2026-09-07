import { describe, expect, it } from 'vitest'
import {
  BROWSER_PLUGIN_HUD_COPY,
  resolveBrowserPluginHudCopy,
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
