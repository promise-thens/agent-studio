/**
 * 浏览器插件进行中的主窗口 HUD 与 overlay 快照。
 *
 * 消费共享 agent-pointer-overlay；插件 pointer 仍恒 undefined，不打开 screen/clipboard。
 */

import type { AgentToolStatus } from './agent'
import type { DesktopIpcResult } from './ipc-result'
import {
  BROWSER_PLUGIN_HUD_COPY as SHARED_BROWSER_PLUGIN_HUD_COPY,
  createAgentPointerSnapshot,
  resolveAgentPointerHudCopy,
  shouldRenderAgentPointerCursor,
  type AgentPointer,
  type AgentPointerSnapshot,
  type AgentPointerSurface
} from './agent-pointer-overlay'

export type { AgentPointer, AgentPointerSnapshot, AgentPointerSurface }

export const BROWSER_PLUGIN_HUD_COPY = SHARED_BROWSER_PLUGIN_HUD_COPY

export const BROWSER_PLUGIN_OVERLAY_STOP_LABEL = '停止浏览器控制'

/** Overlay 独立 preload 只暴露快照、停止和芯片 hover；禁止注入完整 window.agent。 */
export interface OverlayDesktopApi {
  onSnapshot: (listener: (snapshot: BrowserPluginOverlaySnapshot) => void) => () => void
  cancelTurn: () => Promise<DesktopIpcResult<void>>
  /** 芯片悬停时主进程暂时接收点击；离开后恢复穿透。 */
  setChipHover: (hovered: boolean) => void
}

/** 与共享 AgentPointer 同形；插件路径当前永不写入。 */
export type BrowserPluginOverlayPointer = AgentPointer

/**
 * Overlay / Composer 共用快照。pointer 缺省表示当前冻结键不可映射，DOM 不得画移动光标。
 * 写文件 in_progress 不得把 visible 置 true。
 * kind 保留给现有插件通道；surface 对齐共享 DTO，缺省时按 browser-plugin 理解。
 */
export interface BrowserPluginOverlaySnapshot {
  visible: boolean
  kind?: 'browser'
  surface?: 'browser-plugin'
  taskId?: string
  turnId?: string
  executionId?: string
  pointer?: BrowserPluginOverlayPointer
  persistWhenUnfocused?: boolean
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
  return resolveAgentPointerHudCopy({
    surface: 'browser-plugin',
    overlayVisible: input.overlayVisible,
    // 插件可见即视为进行中；Turn 结束后插件路径会隐藏整扇 overlay
    turnActive: input.overlayVisible,
    takeoverCopy: input.takeoverCopy
  })
}

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
 * 基于共享 snapshot 构造插件通道快照。即使传入 pointer 也不得写入，避免把 viewport-css 画到桌面。
 */
export function createBrowserPluginOverlaySnapshot(input: {
  visible: boolean
  taskId?: string
  turnId?: string
  executionId?: string
  pointer?: BrowserPluginOverlayPointer
}): BrowserPluginOverlaySnapshot {
  void input.pointer
  const shared = createAgentPointerSnapshot({
    visible: input.visible,
    surface: 'browser-plugin',
    persistWhenUnfocused: false,
    taskId: input.taskId,
    turnId: input.turnId,
    executionId: input.executionId,
    pointer: input.pointer
  })
  return toBrowserPluginOverlaySnapshot(shared)
}

function toBrowserPluginOverlaySnapshot(
  shared: AgentPointerSnapshot
): BrowserPluginOverlaySnapshot {
  // 插件通道线格式保持 kind:'browser'，不把 surface/persist 强加进现有消费者
  const snapshot: BrowserPluginOverlaySnapshot = {
    visible: shared.visible,
    kind: 'browser'
  }
  if (shared.taskId) snapshot.taskId = shared.taskId
  if (shared.turnId) snapshot.turnId = shared.turnId
  if (shared.executionId) snapshot.executionId = shared.executionId
  // 插件通道禁止挂 pointer，即使共享层误带也剥离
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
    value.length <= 256
    ? value
    : undefined
}

/**
 * Preload 再校验主进程快照：丢掉 runtime 私有键，并拒绝任何 pointer（当前不可映射）。
 * 兼容仅有 kind:'browser' 的旧载荷；surface 缺省按 browser-plugin。
 */
export function parseBrowserPluginOverlaySnapshot(
  value: unknown
): BrowserPluginOverlaySnapshot | null {
  if (!isPlainRecord(value) || (value.visible !== true && value.visible !== false)) return null
  if (value.kind !== undefined && value.kind !== 'browser') return null
  if (value.surface !== undefined && value.surface !== 'browser-plugin') return null
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
  return shouldRenderAgentPointerCursor({
    visible: snapshot.visible,
    surface: 'browser-plugin',
    persistWhenUnfocused: snapshot.persistWhenUnfocused === true,
    pointer: snapshot.pointer
  })
}
