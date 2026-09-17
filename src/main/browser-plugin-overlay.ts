/**
 * 透明置顶 overlay：插件只画停止芯片；宿主内置页可写入已映射的 overlay DIP。
 * 插件冻结键不能映射到屏幕 DIP，不得把 rawInput 画到桌面，也不得移动系统指针。
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
  createHostBrowserOverlaySnapshot,
  projectBrowserPluginPointer,
  shouldRenderBrowserPluginCursor,
  type BrowserPluginOverlaySnapshot,
  type BrowserPluginToolActivity
} from '../shared/browser-plugin-overlay'
import type { AgentPointer } from '../shared/agent-pointer-overlay'
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
  /** 覆盖主窗所在屏；缺省才回退主屏，避免多显示器把光标钉死在主屏。 */
  getOverlayBounds?: () => BrowserPluginOverlayWindowBounds
}

/** 宿主页只提交已映射的 overlay DIP；禁止把 viewport CSS 或插件 rawInput 混进来。 */
export interface HostBrowserOverlayPointerInput {
  pointer: AgentPointer
  taskId?: string
  turnId?: string
  executionId?: string
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
 * 主进程 overlay 可见性：插件路径仍要求执行中且有未决 L3 / 未完成 browser 工具；
 * 宿主路径在已映射 pointer 时也可显示闲置光标。写文件 in_progress 单独不得显示。
 */
export class BrowserPluginOverlaySession {
  private execution: TaskExecutionDto | null = null
  private readonly pendingBrowserApprovals = new Set<string>()
  private readonly openBrowserTools = new Map<string, { taskId: string; turnId: string }>()
  private lastRawInput: unknown
  private displayBounds = { width: 1440, height: 900 }
  private hostPointer: AgentPointer | undefined
  private hostPointerIds: { taskId?: string; turnId?: string; executionId?: string } = {}

  setDisplayBounds(bounds: { width: number; height: number }): void {
    this.displayBounds = bounds
  }

  acceptExecutionSnapshot(snapshot: TaskExecutionSnapshot): void {
    const nextTaskId = snapshot.execution?.taskId
    if (nextTaskId) this.noteActiveTask(nextTaskId)
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

  /**
   * 宿主 click/type 映射成功后写入闲置针。无效坐标省略，不得发明光标。
   */
  acceptHostBrowserPointer(input: HostBrowserOverlayPointerInput): void {
    const snapshot = createHostBrowserOverlaySnapshot({
      visible: true,
      pointer: input.pointer,
      taskId: input.taskId,
      turnId: input.turnId,
      executionId: input.executionId
    })
    if (!snapshot.pointer) return
    this.hostPointer = snapshot.pointer
    this.hostPointerIds = {
      taskId: snapshot.taskId,
      turnId: snapshot.turnId,
      executionId: snapshot.executionId
    }
  }

  /**
   * 主窗失焦/最小化或右栏关闭必须清针：alwaysOnTop overlay 会把箭头留在别的 App 上。
   */
  clearHostBrowserPointer(): void {
    this.hostPointer = undefined
    this.hostPointerIds = {}
  }

  /**
   * Spec §6：切到其它 Task 必须藏针。Turn 结束 execution 变空时不要走这里，闲置针要留着。
   */
  noteActiveTask(taskId: string): void {
    if (!this.hostPointerIds.taskId || this.hostPointerIds.taskId === taskId) return
    this.clearHostBrowserPointer()
  }

  getSnapshot(): BrowserPluginOverlaySnapshot {
    if (this.hostPointer) {
      const execution = this.execution
      const executionActive = Boolean(execution && ACTIVE_EXECUTION_STATES.has(execution.state))
      // Turn 结束后仍留闲置光标，但不带 executionId，overlay 芯片据此关掉
      return createHostBrowserOverlaySnapshot({
        visible: true,
        pointer: this.hostPointer,
        taskId: this.hostPointerIds.taskId ?? execution?.taskId,
        turnId: this.hostPointerIds.turnId ?? execution?.turnId,
        executionId: executionActive
          ? (this.hostPointerIds.executionId ?? execution?.executionId)
          : undefined
      })
    }
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

  acceptHostBrowserPointer(input: HostBrowserOverlayPointerInput): void {
    this.session.acceptHostBrowserPointer(input)
    this.publish()
  }

  /**
   * 组装层在主窗 blur/minimize 时调用。alwaysOnTop 窗在失焦后仍会盖住其它 App，必须立刻摘掉光标。
   */
  clearHostBrowserPointer(): void {
    this.session.clearHostBrowserPointer()
    this.publish()
  }

  noteActiveTask(taskId: string): void {
    this.session.noteActiveTask(taskId)
    this.publish()
  }

  /**
   * 映射必须用 overlay 窗落地后的真实 bounds。
   * macOS 可能把透明窗从 display.bounds 挤进 workArea，不回读就会整块偏下。
   */
  ensurePointerOverlayLayout(): BrowserPluginOverlayWindowBounds {
    const bounds = this.resolveOverlayBounds()
    const window = this.ensureWindow(bounds)
    window.setBounds(bounds)
    const placed = window.getBounds()
    this.session.setDisplayBounds({ width: placed.width, height: placed.height })
    return {
      x: placed.x,
      y: placed.y,
      width: placed.width,
      height: placed.height
    }
  }

  /**
   * 主窗 move/resize/换屏时只搬 overlay 窗，不发明新指针。
   * remap 仍由 HostBrowserService 用同一套 bounds 重算 DIP。
   */
  relayout(): void {
    const window = this.window
    if (!window || window.isDestroyed() || !window.isVisible()) return
    const bounds = this.resolveOverlayBounds()
    this.session.setDisplayBounds({ width: bounds.width, height: bounds.height })
    window.setBounds(bounds)
    if (this.options.platform === 'darwin') {
      window.setAlwaysOnTop(true, 'screen-saver')
    }
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
    this.session.clearHostBrowserPointer()
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
    const bounds = this.resolveOverlayBounds()
    this.session.setDisplayBounds({ width: bounds.width, height: bounds.height })
    const window = this.ensureWindow(bounds)
    window.setBounds(bounds)
    this.applyIgnoreMouseEvents()
    this.sendToOverlay(snapshot)
    if (!window.isVisible()) window.showInactive()
  }

  /** 优先跟主窗所在屏；没有回调时才用主屏，测试和启动早期都能活。 */
  private resolveOverlayBounds(): BrowserPluginOverlayWindowBounds {
    const next = this.options.getOverlayBounds?.()
    if (
      next &&
      Number.isFinite(next.x) &&
      Number.isFinite(next.y) &&
      Number.isFinite(next.width) &&
      Number.isFinite(next.height) &&
      next.width >= 1 &&
      next.height >= 1
    ) {
      return next
    }
    return screen.getPrimaryDisplay().bounds
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
