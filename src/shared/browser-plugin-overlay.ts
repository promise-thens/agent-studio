/**
 * 浏览器插件进行中的主窗口 HUD。
 *
 * 任务 6 会在本文件补 pointer 投影与 overlay 窗口快照；本任务只定义停止条文案优先级。
 * 不打开 screen/clipboard，不注入系统鼠标。
 */

export const BROWSER_PLUGIN_HUD_COPY = 'Grok 正在使用浏览器插件'

/**
 * 任务 6 拥有完整 overlay 快照；主窗口停止条只读 visible。
 * 写文件 in_progress 不得把 visible 置 true。
 */
export interface BrowserPluginOverlaySnapshot {
  visible: boolean
}

/**
 * 接管文案优先；否则浏览器插件进行中显示本句。写文件进行中返回 null。
 *
 * 边界：takeoverCopy 非空时即使 overlayVisible 也不得改口成浏览器句。
 * 风险：若把写文件 in_progress 误标 overlayVisible，主窗口会谎称正在用浏览器。
 */
export function resolveBrowserPluginHudCopy(input: {
  takeoverCopy: string | null
  overlayVisible: boolean
}): string | null {
  if (input.takeoverCopy) return input.takeoverCopy
  if (input.overlayVisible) return BROWSER_PLUGIN_HUD_COPY
  return null
}
