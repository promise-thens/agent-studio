import { nativeImage, WebContentsView, type BaseWindow } from 'electron'
import type { OperationIntent } from '../../shared/agent'
import {
  mapViewportCssToOverlayDip,
  type AgentPointer,
  type AgentPointerBounds
} from '../../shared/agent-pointer-overlay'
import { parseBrowserOrigin } from '../../shared/browser-origin'
import {
  parseCssViewportFromLayoutMetrics,
  parseHostBrowserAction,
  parseHostBrowserBounds,
  parseHostBrowserNavigateUrl,
  resolveScreenshotViewportCssSize,
  type HostBrowserAction,
  type HostBrowserBounds,
  type HostBrowserChrome
} from '../../shared/host-browser'
import { alignScreenshotPngToViewportCss } from './host-browser-screenshot'
import type {
  AuthorizeOperationOptions,
  PermissionAuthorizationResult
} from '../security/permission-broker'
import type { ResolvedOperationIntent } from '../security/permission-policy'
import {
  HostBrowserActionEngine,
  rejectUnparsedHostBrowserAction,
  type HostBrowserActionDriver,
  type HostBrowserActionResult
} from './host-browser-actions'
import { createBrowserPartition, createBrowserWebPreferences } from './host-browser-session'

/** perform 只消费 TaskStore 解析出的身份，禁止 MCP 自报 project / root。 */
export interface HostBrowserPerformContext {
  taskId: string
  turnId: string
  projectId: string
  environmentId: string
  executionRoot: string
  /** 当前 Task 完全访问时 Broker 代批，避免内置浏览器 MCP 仍弹 L3 卡。 */
  takeoverEnabled?: boolean
}

/** 测试可注入的 guest 端口；生产实现包着 WebContentsView，不把 debugger 句柄交出去。 */
export interface HostBrowserGuest {
  readonly projectId: string
  readonly nativeView?: WebContentsView
  loadURL(url: string): void
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  setBounds(bounds: HostBrowserBounds): void
  destroy(): void
  onChromeChanged(listener: () => void): void
  createActionDriver(): HostBrowserActionDriver
  canGoBack?(): boolean
  canGoForward?(): boolean
  goBack?(): Promise<boolean> | boolean
  goForward?(): Promise<boolean> | boolean
  reload?(): void
  stop?(): void
}

/** 窗口与 overlay 几何由组装层注入；Service 只做 viewport → overlay DIP 映射。 */
export interface HostBrowserPointerGeometry {
  contentBounds: AgentPointerBounds
  overlayBounds: AgentPointerBounds
  zoomFactor?: number
}

export interface HostBrowserOverlayPointerNotice {
  pointer: AgentPointer
  taskId: string
  turnId: string
}

export interface HostBrowserServiceDependencies {
  createGuest: (projectId: string) => HostBrowserGuest
  attachGuest: (guest: HostBrowserGuest) => void
  detachGuest: (guest: HostBrowserGuest) => void
  onChromeChange?: (chrome: HostBrowserChrome) => void
  resolvePerformContext?: (taskId: string) => HostBrowserPerformContext | null
  authorizeOperation?: <T>(
    intent: OperationIntent,
    execute: (intent: ResolvedOperationIntent) => T | Promise<T>,
    options?: AuthorizeOperationOptions
  ) => Promise<PermissionAuthorizationResult<T>>
  getPointerGeometry?: () => HostBrowserPointerGeometry | null
  /** 读取主 Renderer 页面缩放，用于把 CSS bounds 转成 WebContentsView 所需的 Native DIP。 */
  getHostRendererZoomFactor?: () => number
  acceptHostBrowserPointer?: (input: HostBrowserOverlayPointerNotice) => void
  clearHostBrowserPointer?: () => void
}

/**
 * 主进程持有的内置浏览器会话。
 * Renderer 只报 bounds 和用户 URL；真正的 WebContents 与 partition 不出主进程。
 */
export class HostBrowserService {
  private guest: HostBrowserGuest | null = null
  private engine: HostBrowserActionEngine | null = null
  private currentProjectId: string | null = null
  private bounds: HostBrowserBounds | null = null
  private wantOpen = false
  private attached = false
  private lastViewportCss: { x: number; y: number; taskId: string; turnId: string } | null = null

  constructor(private readonly dependencies: HostBrowserServiceDependencies) {}

  getChrome(): HostBrowserChrome {
    const url = this.guest?.getURL() ?? ''
    const chrome: HostBrowserChrome = {
      url: url === 'about:blank' ? '' : url,
      title: this.guest?.getTitle() ?? '',
      isLoading: this.guest?.isLoading() ?? false,
      open: this.wantOpen
    }
    if (this.guest?.canGoBack?.()) chrome.canGoBack = true
    if (this.guest?.canGoForward?.()) chrome.canGoForward = true
    return chrome
  }

  /**
   * 用户直接点击内置浏览器后退、前进、刷新或停止。
   */
  userAct(taskId: string, action: 'back' | 'forward' | 'reload' | 'stop'): HostBrowserChrome {
    this.noteActiveTask(taskId)
    if (this.guest) {
      if (action === 'back') void this.guest.goBack?.()
      else if (action === 'forward') void this.guest.goForward?.()
      else if (action === 'reload') this.guest.reload?.()
      else if (action === 'stop') this.guest.stop?.()
    }
    this.emitChrome()
    return this.getChrome()
  }

  /**
   * 用户导航不创建 Runtime OperationIntent。
   * projectId 必须来自 Task 历史，禁止再用占位项目名，否则 cookie 会串到错误 partition。
   */
  userNavigate(taskId: string, projectId: string, url: string): HostBrowserChrome {
    this.noteActiveTask(taskId)
    const href = parseHostBrowserNavigateUrl(url)
    if (!href) throw new Error('只允许 http(s) 网页地址。')
    this.bindProject(projectId)
    this.wantOpen = true
    this.ensureGuest(projectId).loadURL(href)
    this.syncAttachment()
    this.emitChrome()
    return this.getChrome()
  }

  /**
   * Runtime 动作必须先过 Broker。拒绝时不得 loadURL / 点击，避免 Grok 漏报权限也能改页面。
   * 成功 click/type 后才映射 overlay 指针；坐标不进 chrome 推送或日志。
   */
  async perform(taskId: string, raw: unknown): Promise<HostBrowserActionResult> {
    const action = parseHostBrowserAction(raw)
    if (!action) return rejectUnparsedHostBrowserAction(raw)
    const context = this.dependencies.resolvePerformContext?.(taskId) ?? null
    if (!context || context.taskId !== taskId) {
      return { ok: false, code: 'unavailable', message: '当前 Task 不可用。' }
    }
    this.noteActiveTask(taskId)
    const authorize = this.dependencies.authorizeOperation
    if (!authorize) {
      return { ok: false, code: 'unavailable', message: '权限服务尚未初始化。' }
    }
    const origin = originForAction(action, this.guest?.getURL() ?? '')
    const authorized = await authorize(
      createHostBrowserIntent(context, origin),
      async () => {
        this.bindProject(context.projectId)
        const guest = this.ensureGuest(context.projectId)
        const result = await this.requireEngine(guest).execute(action)
        if (result.ok && opensPane(action)) {
          this.wantOpen = true
          this.syncAttachment()
          this.emitChrome()
        }
        return result
      },
      { takeoverEnabled: context.takeoverEnabled === true }
    )
    if (!authorized.ok) {
      return { ok: false, code: 'denied', message: '浏览器操作未获允许。' }
    }
    this.publishHostBrowserPointer(context, authorized.value)
    return authorized.value
  }

  setOpen(taskId: string, projectId: string, open: boolean): HostBrowserChrome {
    this.noteActiveTask(taskId)
    this.bindProject(projectId)
    this.wantOpen = open
    if (open) this.ensureGuest(projectId)
    else this.forgetHostBrowserPointer()
    this.syncAttachment()
    this.emitChrome()
    return this.getChrome()
  }

  updateBounds(bounds: HostBrowserBounds): void {
    const parsed = parseHostBrowserBounds(bounds)
    if (!parsed) return

    // Renderer 上报的是主页面 CSS 坐标；Native WebContentsView 使用窗口 DIP，主页面缩放必须参与换算。
    const rendererZoom = this.dependencies.getHostRendererZoomFactor?.() ?? 1
    const zoomFactor = Number.isFinite(rendererZoom) && rendererZoom > 0 ? rendererZoom : 1
    const scaled = parseHostBrowserBounds({
      x: Math.round(parsed.x * zoomFactor),
      y: Math.round(parsed.y * zoomFactor),
      width: Math.round(parsed.width * zoomFactor),
      height: Math.round(parsed.height * zoomFactor)
    })

    // 缩放后的值若超出 Native bounds 合法范围，回退到未缩放值而不是把视图置成无效矩形。
    this.bounds = scaled ?? parsed
    this.syncAttachment()
    this.remapHostBrowserPointer()
  }

  /**
   * 用上次成功的 viewport CSS 按当前窗口/view 几何重映射。
   * 几何失效或出 view 矩形则清针，不得把旧 DIP 留在桌面。
   */
  remapHostBrowserPointer(): void {
    const stored = this.lastViewportCss
    if (!stored) return
    const pointer = this.mapStoredViewportCss(stored)
    if (!pointer) {
      this.forgetHostBrowserPointer()
      return
    }
    this.dependencies.acceptHostBrowserPointer?.({
      pointer,
      taskId: stored.taskId,
      turnId: stored.turnId
    })
  }

  /**
   * Spec §6：切 Task 必须藏针。旧 CSS 也丢掉，避免随后 move/resize 把旧针画回来。
   */
  noteActiveTask(taskId: string): void {
    if (this.lastViewportCss && this.lastViewportCss.taskId !== taskId) {
      this.forgetHostBrowserPointer()
    }
  }

  /**
   * 失焦/最小化/右栏关闭时丢掉上次 CSS。alwaysOnTop overlay 不能在 remap 时把箭头送回其它 App。
   */
  forgetHostBrowserPointer(): void {
    this.lastViewportCss = null
    this.dependencies.clearHostBrowserPointer?.()
  }

  destroy(): void {
    this.destroyGuest()
    this.bounds = null
    this.wantOpen = false
  }

  private bindProject(projectId: string): void {
    if (this.currentProjectId && this.currentProjectId !== projectId) {
      this.destroyGuest()
    }
    this.currentProjectId = projectId
  }

  private ensureGuest(projectId: string): HostBrowserGuest {
    if (this.guest && this.currentProjectId === projectId) return this.guest
    this.destroyGuest()
    this.currentProjectId = projectId
    const guest = this.dependencies.createGuest(projectId)
    guest.onChromeChanged(() => this.emitChrome())
    this.guest = guest
    this.engine = new HostBrowserActionEngine(guest.createActionDriver())
    return guest
  }

  private requireEngine(guest: HostBrowserGuest): HostBrowserActionEngine {
    if (this.engine && this.guest === guest) return this.engine
    this.engine = new HostBrowserActionEngine(guest.createActionDriver())
    return this.engine
  }

  private destroyGuest(): void {
    if (!this.guest) return
    this.forgetHostBrowserPointer()
    if (this.attached) {
      this.dependencies.detachGuest(this.guest)
      this.attached = false
    }
    this.guest.destroy()
    this.guest = null
    this.engine = null
    this.currentProjectId = null
  }

  /**
   * 成功 click/type 后把 viewport CSS 映射成 overlay DIP。
   * 缺坐标或映射失败则省略，不得发明光标；type 缺四边形时保持闲置针。
   * 坐标只交给 overlay，不得写入 chrome 推送、Timeline 或日志。
   */
  private publishHostBrowserPointer(
    context: HostBrowserPerformContext,
    result: HostBrowserActionResult
  ): void {
    if (!result.ok) return
    const data = result.data
    if (data.kind !== 'clicked' && data.kind !== 'typed') return
    if (typeof data.viewportX !== 'number' || typeof data.viewportY !== 'number') return
    if (!Number.isFinite(data.viewportX) || !Number.isFinite(data.viewportY)) return
    const stored = {
      x: data.viewportX,
      y: data.viewportY,
      taskId: context.taskId,
      turnId: context.turnId
    }
    const pointer = this.mapStoredViewportCss(stored)
    if (!pointer) return
    this.lastViewportCss = stored
    this.dependencies.acceptHostBrowserPointer?.({
      pointer,
      taskId: stored.taskId,
      turnId: stored.turnId
    })
  }

  /** 始终从上次 viewport CSS 映射，不能平移上次 DIP，否则窗口一动针就漂。 */
  private mapStoredViewportCss(stored: { x: number; y: number }): AgentPointer | undefined {
    if (!this.wantOpen || !this.bounds) return undefined
    const geometry = this.dependencies.getPointerGeometry?.() ?? null
    if (!geometry) return undefined
    return mapViewportCssToOverlayDip({
      cssX: stored.x,
      cssY: stored.y,
      zoomFactor: geometry.zoomFactor ?? 1,
      contentBounds: geometry.contentBounds,
      viewBounds: this.bounds,
      overlayBounds: geometry.overlayBounds
    })
  }

  /** 没有 bounds 时不挂视图，避免 WebContentsView 盖住整窗或落到 0×0。 */
  private syncAttachment(): void {
    const guest = this.guest
    if (!guest) return
    if (this.wantOpen && this.bounds) {
      if (!this.attached) {
        this.dependencies.attachGuest(guest)
        this.attached = true
      }
      guest.setBounds(this.bounds)
      return
    }
    if (!this.wantOpen && this.attached) {
      this.dependencies.detachGuest(guest)
      this.attached = false
    }
  }

  private emitChrome(): void {
    this.dependencies.onChromeChange?.(this.getChrome())
  }
}

/**
 * 生产 guest：独立 persist partition，无 preload，顶层导航只允许 http(s)。
 */
export function createElectronHostBrowserGuest(projectId: string): HostBrowserGuest {
  const view = new WebContentsView({
    webPreferences: {
      ...createBrowserWebPreferences(),
      partition: createBrowserPartition(projectId)
    }
  })
  const webContents = view.webContents
  const chromeListeners: Array<() => void> = []

  const notify = (): void => {
    for (const listener of chromeListeners) listener()
  }

  webContents.on('will-navigate', (event, url) => {
    if (url === 'about:blank') return
    if (!parseHostBrowserNavigateUrl(url)) event.preventDefault()
  })
  webContents.on('will-redirect', (event, url) => {
    if (!parseHostBrowserNavigateUrl(url)) event.preventDefault()
  })
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  webContents.session.on('will-download', (event) => {
    event.preventDefault()
  })
  webContents.on('did-navigate', notify)
  webContents.on('did-navigate-in-page', notify)
  webContents.on('page-title-updated', notify)
  webContents.on('did-start-loading', notify)
  webContents.on('did-stop-loading', notify)
  webContents.on('did-fail-load', notify)

  return {
    projectId,
    nativeView: view,
    loadURL(url: string) {
      void webContents.loadURL(url)
    },
    getURL() {
      return webContents.getURL()
    },
    getTitle() {
      return webContents.getTitle()
    },
    isLoading() {
      return webContents.isLoading()
    },
    setBounds(bounds: HostBrowserBounds) {
      view.setBounds(bounds)
    },
    destroy() {
      try {
        if (!webContents.isDestroyed()) {
          if (webContents.debugger.isAttached()) webContents.debugger.detach()
          webContents.close()
        }
      } catch {
        // 窗口已销毁时 close 会抛，忽略即可。
      }
    },
    onChromeChanged(listener: () => void) {
      chromeListeners.push(listener)
    },
    createActionDriver() {
      return createElectronHostBrowserActionDriver(webContents, view)
    },
    canGoBack() {
      return !webContents.isDestroyed() && webContents.navigationHistory.canGoBack()
    },
    canGoForward() {
      return !webContents.isDestroyed() && webContents.navigationHistory.canGoForward()
    },
    async goBack() {
      if (!webContents.isDestroyed() && webContents.navigationHistory.canGoBack()) {
        await webContents.navigationHistory.goBack()
        return true
      }
      return false
    },
    async goForward() {
      if (!webContents.isDestroyed() && webContents.navigationHistory.canGoForward()) {
        await webContents.navigationHistory.goForward()
        return true
      }
      return false
    },
    reload() {
      if (!webContents.isDestroyed()) webContents.reload()
    },
    stop() {
      if (!webContents.isDestroyed()) webContents.stop()
    }
  }
}

/** 生产 driver 只暴露白名单动作；debugger 句柄留在闭包里。 */
function createElectronHostBrowserActionDriver(
  webContents: Electron.WebContents,
  view: WebContentsView
): HostBrowserActionDriver {
  return {
    getURL() {
      return webContents.getURL()
    },
    getTitle() {
      return webContents.getTitle()
    },
    async loadURL(url) {
      await webContents.loadURL(url)
    },
    async goBack() {
      if (!webContents.navigationHistory.canGoBack()) return false
      await webContents.navigationHistory.goBack()
      return true
    },
    async goForward() {
      if (!webContents.navigationHistory.canGoForward()) return false
      await webContents.navigationHistory.goForward()
      return true
    },
    async reload() {
      webContents.reload()
    },
    getViewportCssSize() {
      return readGuestCssViewport(webContents, view)
    },
    async capturePng() {
      const image = await webContents.capturePage()
      const viewport = (await readGuestCssViewport(webContents, view)) ?? undefined
      const png = Buffer.from(image.toPNG())
      // 以 PNG IHDR 为准：getSize() 在 Retina 上常是 DIP，2x 图会被原样交给模型。
      return alignScreenshotPngToViewportCss(png, viewport, (bytes, size) =>
        Buffer.from(
          nativeImage
            .createFromBuffer(bytes, { scaleFactor: 1 })
            .resize({ width: size.width, height: size.height, quality: 'best' })
            .toPNG()
        )
      )
    },
    async sendCdp(method, params) {
      const debuggerSession = webContents.debugger
      if (!debuggerSession.isAttached()) debuggerSession.attach('1.3')
      return debuggerSession.sendCommand(method, params)
    }
  }
}

/**
 * 截图和 click_xy 必须问页面 CSS 视口。View DIP 在有滚动条或 visual viewport 时会对不齐。
 * debugger 失败时才退回 bounds，不能把整条点击打断。
 */
async function readGuestCssViewport(
  webContents: Electron.WebContents,
  view: WebContentsView
): Promise<{ width: number; height: number } | null> {
  const bounds = view.getBounds()
  const fallback = resolveScreenshotViewportCssSize({
    viewportWidth: bounds.width,
    viewportHeight: bounds.height
  })
  try {
    const debuggerSession = webContents.debugger
    if (!debuggerSession.isAttached()) debuggerSession.attach('1.3')
    const metrics = await debuggerSession.sendCommand('Page.getLayoutMetrics')
    const css = parseCssViewportFromLayoutMetrics(metrics)
    if (css) return css
  } catch {
    // 页面未就绪或 debugger 不可用时退回 View 尺寸
  }
  return fallback ?? null
}

/** 把 guest 挂到当前主窗口 contentView；窗口已销毁则丢弃。 */
export function createElectronHostBrowserBindings(
  getWindow: () => BaseWindow | null
): Pick<HostBrowserServiceDependencies, 'createGuest' | 'attachGuest' | 'detachGuest'> {
  const attach = (guest: HostBrowserGuest, add: boolean): void => {
    const window = getWindow()
    const view = guest.nativeView
    // closed 时 JS 包装还在，C++ 窗口/View 已没了；只判断真值会继续 removeChildView 并变成主进程未捕获异常。
    if (!window || window.isDestroyed() || !view) return
    try {
      if (add) window.contentView.addChildView(view)
      else window.contentView.removeChildView(view)
    } catch (error) {
      // isDestroyed 与 contentView 拆毁存在竞态；已销毁不得冒泡，其它错误仍抛出。
      if (window.isDestroyed() || isDestroyedNativeObjectError(error)) return
      throw error
    }
  }
  return {
    createGuest: createElectronHostBrowserGuest,
    attachGuest: (guest) => attach(guest, true),
    detachGuest: (guest) => attach(guest, false)
  }
}

/** Electron 在原生对象已释放后抛 TypeError: Object has been destroyed。 */
function isDestroyedNativeObjectError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('has been destroyed')
}

function originForAction(action: HostBrowserAction, currentUrl: string): string | null {
  if (action.name === 'browser_navigate') return parseBrowserOrigin(action.url)
  if (action.name === 'browser_tabs_open' && action.url) return parseBrowserOrigin(action.url)
  return currentUrl && currentUrl !== 'about:blank' ? parseBrowserOrigin(currentUrl) : null
}

function opensPane(action: HostBrowserAction): boolean {
  return action.name === 'browser_navigate' || action.name === 'browser_tabs_open'
}

function createHostBrowserIntent(
  context: HostBrowserPerformContext,
  origin: string | null
): OperationIntent {
  return {
    initiator: { kind: 'runtime', runtimeId: 'grok' },
    taskId: context.taskId,
    turnId: context.turnId,
    projectId: context.projectId,
    environmentId: context.environmentId,
    executionRoot: context.executionRoot,
    operationType: 'browser',
    targets: origin
      ? [{ kind: 'origin', value: origin }]
      : [{ kind: 'unknown', value: '内置浏览器尚未打开可识别的页面。' }],
    parameterFingerprint: origin ? 'host-browser:origin:v1' : 'host-browser:unknown-origin:v1',
    title: origin ? `使用内置浏览器访问 ${origin}` : '使用内置浏览器',
    impact: origin
      ? `将在内置浏览器中访问 ${origin}。写文件授权不能代替这一步。`
      : '将在内置浏览器中执行页面动作。写文件授权不能代替这一步。',
    minimumRisk: 'L3'
  }
}
