import { WebContentsView, type BaseWindow } from 'electron'
import type { OperationIntent } from '../../shared/agent'
import {
  mapViewportCssToOverlayDip,
  type AgentPointer,
  type AgentPointerBounds
} from '../../shared/agent-pointer-overlay'
import { parseBrowserOrigin } from '../../shared/browser-origin'
import {
  parseHostBrowserAction,
  parseHostBrowserBounds,
  parseHostBrowserNavigateUrl,
  type HostBrowserAction,
  type HostBrowserBounds,
  type HostBrowserChrome
} from '../../shared/host-browser'
import type { PermissionAuthorizationResult } from '../security/permission-broker'
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
    execute: (intent: ResolvedOperationIntent) => T | Promise<T>
  ) => Promise<PermissionAuthorizationResult<T>>
  getPointerGeometry?: () => HostBrowserPointerGeometry | null
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

  constructor(private readonly dependencies: HostBrowserServiceDependencies) {}

  getChrome(): HostBrowserChrome {
    const url = this.guest?.getURL() ?? ''
    return {
      url: url === 'about:blank' ? '' : url,
      title: this.guest?.getTitle() ?? '',
      isLoading: this.guest?.isLoading() ?? false,
      open: this.wantOpen
    }
  }

  /**
   * 用户导航不创建 Runtime OperationIntent。
   * projectId 必须来自 Task 历史，禁止再用占位项目名，否则 cookie 会串到错误 partition。
   */
  userNavigate(taskId: string, projectId: string, url: string): HostBrowserChrome {
    void taskId
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
    const authorize = this.dependencies.authorizeOperation
    if (!authorize) {
      return { ok: false, code: 'unavailable', message: '权限服务尚未初始化。' }
    }
    const origin = originForAction(action, this.guest?.getURL() ?? '')
    const authorized = await authorize(createHostBrowserIntent(context, origin), async () => {
      this.bindProject(context.projectId)
      const guest = this.ensureGuest(context.projectId)
      const result = await this.requireEngine(guest).execute(action)
      if (result.ok && opensPane(action)) {
        this.wantOpen = true
        this.syncAttachment()
        this.emitChrome()
      }
      return result
    })
    if (!authorized.ok) {
      return { ok: false, code: 'denied', message: '浏览器操作未获允许。' }
    }
    this.publishHostBrowserPointer(context, authorized.value)
    return authorized.value
  }

  setOpen(taskId: string, projectId: string, open: boolean): HostBrowserChrome {
    void taskId
    this.bindProject(projectId)
    this.wantOpen = open
    if (open) this.ensureGuest(projectId)
    else this.dependencies.clearHostBrowserPointer?.()
    this.syncAttachment()
    this.emitChrome()
    return this.getChrome()
  }

  updateBounds(bounds: HostBrowserBounds): void {
    const parsed = parseHostBrowserBounds(bounds)
    if (!parsed) return
    this.bounds = parsed
    this.syncAttachment()
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
    this.dependencies.clearHostBrowserPointer?.()
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
    if (!this.wantOpen || !this.bounds) return
    const geometry = this.dependencies.getPointerGeometry?.() ?? null
    if (!geometry) return
    const pointer = mapViewportCssToOverlayDip({
      cssX: data.viewportX,
      cssY: data.viewportY,
      zoomFactor: geometry.zoomFactor ?? 1,
      contentBounds: geometry.contentBounds,
      viewBounds: this.bounds,
      overlayBounds: geometry.overlayBounds
    })
    if (!pointer) return
    this.dependencies.acceptHostBrowserPointer?.({
      pointer,
      taskId: context.taskId,
      turnId: context.turnId
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
      return createElectronHostBrowserActionDriver(webContents)
    }
  }
}

/** 生产 driver 只暴露白名单动作；debugger 句柄留在闭包里。 */
function createElectronHostBrowserActionDriver(
  webContents: Electron.WebContents
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
    async capturePng() {
      const image = await webContents.capturePage()
      return Buffer.from(image.toPNG())
    },
    async sendCdp(method, params) {
      const debuggerSession = webContents.debugger
      if (!debuggerSession.isAttached()) debuggerSession.attach('1.3')
      return debuggerSession.sendCommand(method, params)
    }
  }
}

/** 把 guest 挂到当前主窗口 contentView；窗口已销毁则丢弃。 */
export function createElectronHostBrowserBindings(
  getWindow: () => BaseWindow | null
): Pick<HostBrowserServiceDependencies, 'createGuest' | 'attachGuest' | 'detachGuest'> {
  const attach = (guest: HostBrowserGuest, add: boolean): void => {
    const window = getWindow()
    const view = guest.nativeView
    if (!window || !view) return
    if (add) window.contentView.addChildView(view)
    else window.contentView.removeChildView(view)
  }
  return {
    createGuest: createElectronHostBrowserGuest,
    attachGuest: (guest) => attach(guest, true),
    detachGuest: (guest) => attach(guest, false)
  }
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
