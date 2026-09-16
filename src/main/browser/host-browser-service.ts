import { WebContentsView, type BaseWindow } from 'electron'
import {
  parseHostBrowserBounds,
  parseHostBrowserNavigateUrl,
  type HostBrowserBounds,
  type HostBrowserChrome
} from '../../shared/host-browser'
import { createBrowserPartition, createBrowserWebPreferences } from './host-browser-session'

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
}

export interface HostBrowserServiceDependencies {
  createGuest: (projectId: string) => HostBrowserGuest
  attachGuest: (guest: HostBrowserGuest) => void
  detachGuest: (guest: HostBrowserGuest) => void
  onChromeChange?: (chrome: HostBrowserChrome) => void
}

/**
 * 主进程持有的内置浏览器会话。
 * Renderer 只报 bounds 和用户 URL；真正的 WebContents 与 partition 不出主进程。
 */
export class HostBrowserService {
  private guest: HostBrowserGuest | null = null
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

  setOpen(taskId: string, projectId: string, open: boolean): HostBrowserChrome {
    void taskId
    this.bindProject(projectId)
    this.wantOpen = open
    if (open) this.ensureGuest(projectId)
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
    return guest
  }

  private destroyGuest(): void {
    if (!this.guest) return
    if (this.attached) {
      this.dependencies.detachGuest(this.guest)
      this.attached = false
    }
    this.guest.destroy()
    this.guest = null
    this.currentProjectId = null
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
        if (!webContents.isDestroyed()) webContents.close()
      } catch {
        // 窗口已销毁时 close 会抛，忽略即可。
      }
    },
    onChromeChanged(listener: () => void) {
      chromeListeners.push(listener)
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
