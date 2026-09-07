/**
 * 浏览器插件方案 A overlay：透明置顶、click-through，只画停止芯片。
 * 当前冻结键不能映射到屏幕 DIP，因此不得移动系统指针，也不得发明虚拟光标。
 */

import { BrowserWindow, ipcMain, screen, type BrowserWindowConstructorOptions } from 'electron'
import { pathToFileURL } from 'node:url'
import type {
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentToolStatus
} from '../shared/agent'
import type { AgentPermissionCancellation } from '../shared/agent-ipc'
import {
  createBrowserPluginOverlaySnapshot,
  projectBrowserPluginPointer,
  shouldRenderBrowserPluginCursor,
  type BrowserPluginOverlaySnapshot,
  type BrowserPluginToolActivity
} from '../shared/browser-plugin-overlay'
import { TASK_PUSH_CHANNELS, TASK_SEND_CHANNELS } from '../shared/task-ipc'
import type { TaskExecutionDto, TaskExecutionSnapshot } from '../shared/task-execution'
import type { RendererTrustOptions } from './security/ipc-sender-validation'

const ACTIVE_EXECUTION_STATES = new Set<TaskExecutionDto['state']>([
  'queued',
  'running',
  'waiting-permission'
])

const TERMINAL_TOOL_STATES = new Set<AgentToolStatus>(['completed', 'failed', 'cancelled'])

export interface BrowserPluginOverlayWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserPluginOverlayHostOptions {
  isDev: boolean
  rendererUrl?: string
  preloadPath: string
  productionHtmlPath: string
  platform: NodeJS.Platform
  publishToMain: (snapshot: BrowserPluginOverlaySnapshot) => void
}

export function shouldRenderMovingOverlayCursor(snapshot: BrowserPluginOverlaySnapshot): boolean {
  return shouldRenderBrowserPluginCursor(snapshot)
}

/**
 * 芯片悬停时必须关闭 ignore，否则 forward 只转发 mousemove、芯片收不到 click。
 * 离开后再 `ignore: true, forward: true` 把空白区域点回去给下层桌面。
 */
export function resolveBrowserPluginOverlayIgnoreMouseEvents(
  chipHovered: boolean
): { ignore: false } | { ignore: true; forward: true } {
  if (chipHovered) return { ignore: false }
  return { ignore: true, forward: true }
}

/**
 * 构造透明置顶 overlay 窗口选项。click-through 不能写进 constructor，
 * 创建后默认 ignore+forward；芯片 hover 再临时 setIgnoreMouseEvents(false)。
 */
export function createBrowserPluginOverlayWindowOptions(input: {
  bounds: BrowserPluginOverlayWindowBounds
  preloadPath: string
}): BrowserWindowConstructorOptions {
  return {
    x: input.bounds.x,
    y: input.bounds.y,
    width: input.bounds.width,
    height: input.bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    focusable: true,
    show: false,
    webPreferences: {
      preload: input.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  }
}

/**
 * 主进程 overlay 可见性：执行中且存在未决 browser L3 或未完成 browser 工具。
 * 写文件 in_progress 单独出现时保持隐藏。
 */
export class BrowserPluginOverlaySession {
  private execution: TaskExecutionDto | null = null
  private readonly pendingBrowserApprovals = new Set<string>()
  private readonly openBrowserTools = new Map<string, { taskId: string; turnId: string }>()
  private lastRawInput: unknown
  private displayBounds = { width: 1440, height: 900 }

  setDisplayBounds(bounds: { width: number; height: number }): void {
    this.displayBounds = bounds
  }

  acceptExecutionSnapshot(snapshot: TaskExecutionSnapshot): void {
    this.execution = snapshot.execution
    if (!this.execution || !ACTIVE_EXECUTION_STATES.has(this.execution.state)) {
      this.pendingBrowserApprovals.clear()
      this.openBrowserTools.clear()
      this.lastRawInput = undefined
    }
  }

  acceptPermission(request: AgentPermissionRequest): void {
    if (request.operationType !== 'browser') return
    this.pendingBrowserApprovals.add(request.approvalId)
  }

  acceptPermissionCancelled(request: Pick<AgentPermissionCancellation, 'approvalId'>): void {
    this.pendingBrowserApprovals.delete(request.approvalId)
  }

  acceptPermissionResponse(request: {
    approvalId: string
    decision: AgentPermissionDecision
  }): void {
    // pending 只表示未决 L3；allow/deny/cancel 都清掉，避免允许后写文件仍显示浏览器 HUD。
    void request.decision
    this.pendingBrowserApprovals.delete(request.approvalId)
  }

  acceptBrowserTool(activity: BrowserPluginToolActivity): void {
    const key = `${activity.taskId}:${activity.toolCallId}`
    if (activity.status && TERMINAL_TOOL_STATES.has(activity.status)) {
      this.openBrowserTools.delete(key)
      return
    }
    this.openBrowserTools.set(key, { taskId: activity.taskId, turnId: activity.turnId })
    if (activity.rawInput !== undefined) this.lastRawInput = activity.rawInput
  }

  getSnapshot(): BrowserPluginOverlaySnapshot {
    const execution = this.execution
    const executionActive = Boolean(execution && ACTIVE_EXECUTION_STATES.has(execution.state))
    const hasBrowser = this.pendingBrowserApprovals.size > 0 || this.openBrowserTools.size > 0
    const visible = executionActive && hasBrowser
    // 投影恒为 undefined：冻结键不是屏幕 DIP，禁止把 viewport-css 画到桌面。
    const pointer = projectBrowserPluginPointer(this.lastRawInput, this.displayBounds)
    if (!visible || !execution) {
      return createBrowserPluginOverlaySnapshot({ visible: false })
    }
    return createBrowserPluginOverlaySnapshot({
      visible: true,
      taskId: execution.taskId,
      turnId: execution.turnId,
      executionId: execution.executionId,
      pointer
    })
  }
}

/**
 * 组装层只喂事件；窗口创建、置顶、click-through 和隐藏都留在本模块。
 */
export class BrowserPluginOverlayHost {
  readonly session = new BrowserPluginOverlaySession()
  private window: BrowserWindow | null = null
  private chipHovered = false

  constructor(private readonly options: BrowserPluginOverlayHostOptions) {
    ipcMain.on(TASK_SEND_CHANNELS.browserPluginOverlayChipHover, this.onChipHoverIpc)
  }

  acceptExecutionSnapshot(snapshot: TaskExecutionSnapshot): void {
    this.session.acceptExecutionSnapshot(snapshot)
    this.publish()
  }

  acceptPermission(request: AgentPermissionRequest): void {
    this.session.acceptPermission(request)
    this.publish()
  }

  acceptPermissionCancelled(request: AgentPermissionCancellation): void {
    this.session.acceptPermissionCancelled(request)
    this.publish()
  }

  acceptPermissionResponse(request: {
    approvalId: string
    decision: AgentPermissionDecision
  }): void {
    this.session.acceptPermissionResponse(request)
    this.publish()
  }

  acceptBrowserTool(activity: BrowserPluginToolActivity): void {
    this.session.acceptBrowserTool(activity)
    this.publish()
  }

  /**
   * 停止芯片 hover 时让窗口接收 click；离开后恢复整窗穿透。
   */
  setChipHover(hovered: boolean): void {
    this.chipHovered = hovered === true
    this.applyIgnoreMouseEvents()
  }

  getRendererTrustOptions(): RendererTrustOptions | null {
    const window = this.window
    if (!window || window.isDestroyed()) return null
    return {
      getMainWindow: () => window,
      ...(this.options.isDev && this.options.rendererUrl
        ? { developmentUrl: this.options.rendererUrl }
        : {}),
      productionFileUrl: pathToFileURL(this.options.productionHtmlPath).href
    }
  }

  destroy(): void {
    ipcMain.removeListener(TASK_SEND_CHANNELS.browserPluginOverlayChipHover, this.onChipHoverIpc)
    this.chipHovered = false
    const hidden = createBrowserPluginOverlaySnapshot({ visible: false })
    this.options.publishToMain(hidden)
    this.sendToOverlay(hidden)
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
  }

  private publish(): void {
    const snapshot = this.session.getSnapshot()
    this.options.publishToMain(snapshot)
    if (snapshot.visible) this.show(snapshot)
    else this.hide(snapshot)
  }

  private show(snapshot: BrowserPluginOverlaySnapshot): void {
    const bounds = screen.getPrimaryDisplay().bounds
    this.session.setDisplayBounds({ width: bounds.width, height: bounds.height })
    const window = this.ensureWindow(bounds)
    window.setBounds(bounds)
    this.applyIgnoreMouseEvents()
    this.sendToOverlay(snapshot)
    if (!window.isVisible()) window.showInactive()
  }

  private hide(snapshot: BrowserPluginOverlaySnapshot): void {
    this.chipHovered = false
    this.applyIgnoreMouseEvents()
    this.sendToOverlay(snapshot)
    if (this.window && !this.window.isDestroyed() && this.window.isVisible()) {
      this.window.hide()
    }
  }

  private ensureWindow(bounds: BrowserPluginOverlayWindowBounds): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window
    const window = new BrowserWindow(
      createBrowserPluginOverlayWindowOptions({
        bounds,
        preloadPath: this.options.preloadPath
      })
    )
    window.setAlwaysOnTop(true, 'screen-saver')
    if (this.options.platform === 'darwin') {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }
    this.window = window
    this.applyIgnoreMouseEvents()
    window.webContents.once('did-finish-load', () => {
      this.sendToOverlay(this.session.getSnapshot())
    })
    if (this.options.isDev && this.options.rendererUrl) {
      void window.loadURL(`${this.options.rendererUrl.replace(/\/$/, '')}/overlay.html`)
    } else {
      void window.loadFile(this.options.productionHtmlPath)
    }
    window.on('closed', () => {
      if (this.window === window) this.window = null
    })
    return window
  }

  private readonly onChipHoverIpc = (
    event: { sender: Electron.WebContents },
    hovered: unknown
  ): void => {
    if (!this.window || this.window.isDestroyed() || event.sender !== this.window.webContents) {
      return
    }
    this.setChipHover(hovered === true)
  }

  private applyIgnoreMouseEvents(): void {
    const window = this.window
    if (!window || window.isDestroyed()) return
    const next = resolveBrowserPluginOverlayIgnoreMouseEvents(this.chipHovered)
    if (next.ignore) window.setIgnoreMouseEvents(true, { forward: true })
    else window.setIgnoreMouseEvents(false)
  }

  private sendToOverlay(snapshot: BrowserPluginOverlaySnapshot): void {
    const window = this.window
    if (!window || window.isDestroyed()) return
    try {
      window.webContents.send(TASK_PUSH_CHANNELS.browserPluginOverlay, snapshot)
    } catch {
      // 窗口销毁竞态直接丢弃，不得缓存旧 frame。
    }
  }
}
