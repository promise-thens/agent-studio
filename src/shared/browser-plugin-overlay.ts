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
  isAgentPointerTurnActive,
  parseAgentPointerSnapshot,
  resolveAgentPointerHudCopy,
  shouldRenderAgentPointerCursor,
  type AgentPointer,
  type AgentPointerSnapshot,
  type AgentPointerSurface
} from './agent-pointer-overlay'

export type { AgentPointer, AgentPointerSnapshot, AgentPointerSurface }
export { isAgentPointerTurnActive }

export const BROWSER_PLUGIN_HUD_COPY = SHARED_BROWSER_PLUGIN_HUD_COPY

export const BROWSER_PLUGIN_OVERLAY_STOP_LABEL = '停止浏览器控制'

/**
 * Overlay 独立 preload 只暴露快照、停止和芯片 hover；禁止注入完整 window.agent。
 * 快照用 AgentPointerSnapshot：宿主可带 pointer，插件路径仍无针。
 */
export interface OverlayDesktopApi {
  onSnapshot: (listener: (snapshot: AgentPointerSnapshot) => void) => () => void
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
 * host-browser 才允许带已映射的 overlay DIP；computer-use 本波不得出现在此通道。
 */
export interface BrowserPluginOverlaySnapshot {
  visible: boolean
  kind?: 'browser'
  surface?: 'browser-plugin' | 'host-browser'
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
 * 接管文案优先；否则按 surface + turnActive 出停止句。写文件进行中返回 null。
 *
 * 不得只看 overlayVisible：宿主闲置光标 visible=true 但无 execution 三元组，
 * 主窗口不得冒充「正在使用浏览器插件」或宿主进行中句。
 */
export function resolveBrowserPluginHudCopy(input: {
  takeoverCopy: string | null
  overlayVisible: boolean
  surface?: AgentPointerSurface
  turnActive?: boolean
}): string | null {
  const surface = input.surface === 'host-browser' ? 'host-browser' : 'browser-plugin'
  return resolveAgentPointerHudCopy({
    surface,
    overlayVisible: input.overlayVisible,
    // 未显式传入时：插件仍把 visible 当进行中；宿主闲置光标不得当成进行中
    turnActive:
      input.turnActive ??
      isAgentPointerTurnActive({
        visible: input.overlayVisible,
        surface
      }),
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
  const snapshot: BrowserPluginOverlaySnapshot = {
    visible: shared.visible,
    kind: 'browser'
  }
  if (shared.taskId) snapshot.taskId = shared.taskId
  if (shared.turnId) snapshot.turnId = shared.turnId
  if (shared.executionId) snapshot.executionId = shared.executionId
  // 仅宿主页可把已映射 DIP 写进通道；插件线继续省略 surface/persist/pointer
  if (shared.surface === 'host-browser') {
    snapshot.surface = 'host-browser'
    snapshot.persistWhenUnfocused = false
    if (shared.pointer) snapshot.pointer = shared.pointer
  }
  return snapshot
}

/**
 * 宿主内置页 overlay 快照。persistWhenUnfocused 恒 false，避免 alwaysOnTop 漏到其它 App。
 */
export function createHostBrowserOverlaySnapshot(input: {
  visible: boolean
  taskId?: string
  turnId?: string
  executionId?: string
  pointer?: BrowserPluginOverlayPointer
}): BrowserPluginOverlaySnapshot {
  return toBrowserPluginOverlaySnapshot(
    createAgentPointerSnapshot({
      visible: input.visible,
      surface: 'host-browser',
      persistWhenUnfocused: false,
      taskId: input.taskId,
      turnId: input.turnId,
      executionId: input.executionId,
      pointer: input.pointer
    })
  )
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
 * Preload 再校验主进程快照：丢掉 runtime 私有键。
 * 插件路径拒绝 pointer；宿主 host-browser 可保留有限 DIP；computer-use 拒收。
 */
export function parseBrowserPluginOverlaySnapshot(
  value: unknown
): BrowserPluginOverlaySnapshot | null {
  if (!isPlainRecord(value) || (value.visible !== true && value.visible !== false)) return null
  if (value.kind !== undefined && value.kind !== 'browser') return null
  if (value.surface === 'computer-use') return null
  if (
    value.surface !== undefined &&
    value.surface !== 'browser-plugin' &&
    value.surface !== 'host-browser'
  ) {
    return null
  }
  if (value.surface === 'host-browser') {
    const shared = parseAgentPointerSnapshot({
      visible: value.visible,
      surface: 'host-browser',
      persistWhenUnfocused: false,
      taskId: value.taskId,
      turnId: value.turnId,
      executionId: value.executionId,
      pointer: value.pointer
    })
    return shared ? toBrowserPluginOverlaySnapshot(shared) : null
  }
  return createBrowserPluginOverlaySnapshot({
    visible: value.visible,
    taskId: readOverlayId(value.taskId),
    turnId: readOverlayId(value.turnId),
    executionId: readOverlayId(value.executionId),
    pointer:
      value.pointer && isPlainRecord(value.pointer)
        ? projectBrowserPluginPointer(value.pointer, { width: 0, height: 0 })
        : undefined
  })
}

/** 无 pointer 时不得在 overlay DOM 留下移动光标节点。 */
export function shouldRenderBrowserPluginCursor(snapshot: BrowserPluginOverlaySnapshot): boolean {
  return shouldRenderAgentPointerCursor({
    visible: snapshot.visible,
    surface: snapshot.surface === 'host-browser' ? 'host-browser' : 'browser-plugin',
    persistWhenUnfocused: snapshot.persistWhenUnfocused === true,
    pointer: snapshot.pointer
  })
}
