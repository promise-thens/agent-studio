/**
 * 浏览器插件进行中的主窗口 HUD 与 overlay 快照。
 *
 * 不打开 screen/clipboard，不注入系统鼠标。
 */

import type { AgentToolStatus } from './agent'
import type { DesktopIpcResult } from './ipc-result'

export const BROWSER_PLUGIN_HUD_COPY = 'Grok 正在使用浏览器插件'

export const BROWSER_PLUGIN_OVERLAY_STOP_LABEL = '停止浏览器控制'

/** Overlay 独立 preload 只暴露快照订阅和停止；禁止注入完整 window.agent。 */
export interface OverlayDesktopApi {
  onSnapshot: (listener: (snapshot: BrowserPluginOverlaySnapshot) => void) => () => void
  cancelTurn: () => Promise<DesktopIpcResult<void>>
}

export interface BrowserPluginOverlayPointer {
  x: number
  y: number
}

/**
 * Overlay / Composer 共用快照。pointer 缺省表示当前冻结键不可映射，DOM 不得画移动光标。
 * 写文件 in_progress 不得把 visible 置 true。
 */
export interface BrowserPluginOverlaySnapshot {
  visible: boolean
  kind?: 'browser'
  taskId?: string
  turnId?: string
  executionId?: string
  pointer?: BrowserPluginOverlayPointer
}

/** Adapter 通知 overlay：仅白名单 browser 工具。rawInput 只用于投影，不得原样进 Renderer。 */
export interface BrowserPluginToolActivity {
  taskId: string
  turnId: string
  toolCallId: string
  status?: AgentToolStatus
  rawInput?: unknown
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

const MAX_OVERLAY_ID_BYTES = 256

/**
 * 任务 1 冻结：ACP `rawInput.x/y`、`coordinate`、`position` 与 ToolCall 顶层 x/y 均为 not-observed；
 * chrome-devtools `click_at` 即使出现也是 viewport-css，不能画到 overlay 屏幕 DIP。
 * 未知键、`_meta`、非有限数字、远离当前 display 一律拒绝。禁止用 uid / 截图 / title 发明光标。
 */
export function projectBrowserPluginPointer(
  rawInput: unknown,
  bounds: { width: number; height: number }
): BrowserPluginOverlayPointer | undefined {
  void rawInput
  void bounds
  return undefined
}

/**
 * 构造可序列化 overlay 快照。当前冻结下即使传入 pointer 也不得写入，避免把 viewport-css 画到桌面。
 */
export function createBrowserPluginOverlaySnapshot(input: {
  visible: boolean
  taskId?: string
  turnId?: string
  executionId?: string
  pointer?: BrowserPluginOverlayPointer
}): BrowserPluginOverlaySnapshot {
  const snapshot: BrowserPluginOverlaySnapshot = {
    visible: input.visible,
    kind: 'browser'
  }
  if (input.taskId) snapshot.taskId = input.taskId
  if (input.turnId) snapshot.turnId = input.turnId
  if (input.executionId) snapshot.executionId = input.executionId
  void input.pointer
  return snapshot
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readOverlayId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.trim() !== '' &&
    !value.includes('\0') &&
    value.length <= MAX_OVERLAY_ID_BYTES
    ? value
    : undefined
}

/**
 * Preload 再校验主进程快照：丢掉 runtime 私有键，并拒绝任何 pointer（当前不可映射）。
 */
export function parseBrowserPluginOverlaySnapshot(
  value: unknown
): BrowserPluginOverlaySnapshot | null {
  if (!isPlainRecord(value) || (value.visible !== true && value.visible !== false)) return null
  if (value.kind !== undefined && value.kind !== 'browser') return null
  const snapshot = createBrowserPluginOverlaySnapshot({
    visible: value.visible,
    taskId: readOverlayId(value.taskId),
    turnId: readOverlayId(value.turnId),
    executionId: readOverlayId(value.executionId),
    pointer:
      value.pointer && isPlainRecord(value.pointer)
        ? projectBrowserPluginPointer(value.pointer, { width: 0, height: 0 })
        : undefined
  })
  return snapshot
}

/** 无 pointer 时不得在 overlay DOM 留下移动光标节点。 */
export function shouldRenderBrowserPluginCursor(snapshot: BrowserPluginOverlaySnapshot): boolean {
  return snapshot.visible === true && snapshot.pointer != null
}
