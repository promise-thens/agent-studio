import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent, type Rectangle } from 'electron'
import { pathToFileURL } from 'node:url'
import type { EventEmitter } from 'node:events'
import {
  BROWSER_FOCUS_CHANNELS as channels,
  parseBrowserFocusIntent,
  parseBrowserFocusSnapshot,
  type BrowserFocusSnapshot
} from '../../shared/browser-focus-overlay'
import {
  assertTrustedIpcSender,
  DesktopIpcFailure,
  runDesktopIpcOperation,
  sendToTrustedRenderer,
  type RendererTrustOptions
} from '../security/ipc-sender-validation'

export interface BrowserFocusOverlayOptions {
  parent: BrowserWindow
  ownerTrust: RendererTrustOptions
  preloadPath: string
  productionHtmlPath: string
  rendererUrl?: string
}

/**
 * 浏览器专注悬浮岛高度（DIP）：调整为 440px。
 * 窗口本身是透明背景（transparent: true），充裕的 440px 高度可以让一体化卡片从容展开长回复，
 * 同时不遮挡任何多余网页内容。
 */
export const BROWSER_FOCUS_OVERLAY_HEIGHT = 440

/** 网页 CSS 矩形投影到屏幕 DIP；输入窗覆盖网页底部，不改变网页自身 bounds。 */
export function resolveBrowserFocusBounds(
  content: Rectangle,
  browser: BrowserFocusSnapshot['browserBounds'],
  zoom: number
): Rectangle | null {
  if (!Number.isFinite(zoom) || zoom <= 0) return null
  const left = Math.max(0, browser.x * zoom)
  const top = Math.max(0, browser.y * zoom)
  const right = Math.min(content.width, (browser.x + browser.width) * zoom)
  const bottom = Math.min(content.height, (browser.y + browser.height) * zoom)
  const width = Math.floor(Math.min(720, right - left - 24))
  // 采用悬浮岛高度 440px，容纳展开态长回复卡片、底部药丸输入栏与操作按钮，留足呼吸感
  const height = BROWSER_FOCUS_OVERLAY_HEIGHT
  if (width < 280 || bottom - top < height + 24) return null
  return {
    x: Math.round(content.x + left + (right - left - width) / 2),
    y: Math.round(content.y + bottom - height - 12),
    width,
    height
  }
}

/** Electron 原生窗口已释放时会抛此错误；只把它视为幂等清理成功。 */
function isDestroyedNativeObjectError(error: unknown): boolean {
  return error instanceof TypeError && error.message.includes('Object has been destroyed')
}

/**
 * 主窗口唯一状态的受控原生投影。子窗不持有 Runtime、不修改草稿，
 * 不使用全局置顶；原生父子窗口关系使其位于父窗 WebContentsView 之上。
 */
export class BrowserFocusOverlay {
  private window: BrowserWindow | null = null
  private snapshot: BrowserFocusSnapshot | null = null
  private loading: Promise<void> | null = null
  private loaded = false
  private disposed = false
  private latestDraftSequence = 0
  private actionRevision = -1
  private windowGroupActive = false
  private parentFocusObserved = false
  private overlayFocusObserved = false
  private focusCheck: NodeJS.Immediate | null = null
  private cleanups: (() => void)[] = []
  private readonly pageUrl: string

  constructor(private readonly options: BrowserFocusOverlayOptions) {
    this.pageUrl = options.rendererUrl
      ? new URL('browser-focus-overlay.html', `${options.rendererUrl.replace(/\/$/, '')}/`).href
      : pathToFileURL(options.productionHtmlPath).href
    const parent = options.parent
    const events: EventEmitter = parent
    // closed 触发时 BrowserWindow.webContents getter 可能已经失效，必须在存活期固定引用。
    const parentWebContents = parent.webContents
    for (const event of [
      'move',
      'resize',
      'restore',
      'show',
      'enter-full-screen',
      'leave-full-screen'
    ] as const) {
      const listener = (): void => this.syncWindow()
      events.on(event, listener)
      this.cleanups.push(() => events.removeListener(event, listener))
    }
    parent.on('focus', this.handleParentFocus)
    for (const event of ['minimize', 'hide'] as const) {
      const listener = (): void => this.deactivateWindowGroup()
      events.on(event, listener)
      this.cleanups.push(() => events.removeListener(event, listener))
    }
    parent.on('blur', this.handleParentBlur)
    parent.on('closed', this.destroy)
    this.cleanups.push(
      () => parent.removeListener('focus', this.handleParentFocus),
      () => parent.removeListener('blur', this.handleParentBlur),
      () => parent.removeListener('closed', this.destroy)
    )
    const zoom = (): void => this.syncWindow()
    parentWebContents.on('zoom-changed', zoom)
    const invalidate = (): void => {
      this.snapshot = null
      this.window?.hide()
    }
    parentWebContents.on('did-start-loading', invalidate)
    parentWebContents.on('render-process-gone', invalidate)
    this.cleanups.push(
      () => {
        if (!parentWebContents.isDestroyed()) parentWebContents.removeListener('zoom-changed', zoom)
      },
      () => {
        if (!parentWebContents.isDestroyed())
          parentWebContents.removeListener('did-start-loading', invalidate)
      },
      () => {
        if (!parentWebContents.isDestroyed())
          parentWebContents.removeListener('render-process-gone', invalidate)
      }
    )
  }

  /** 固定 IPC 分别授权主窗口和已知子窗，错误不携带原始 Electron 堆栈。 */
  registerIpc(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>): void {
    const register = (
      channel: string,
      operation: (event: IpcMainInvokeEvent, args: unknown[]) => unknown
    ): void => {
      ipc.handle(channel, (event, ...args: unknown[]) =>
        runDesktopIpcOperation(
          () => operation(event, args),
          () => '浏览器输入浮层操作失败。'
        )
      )
      this.cleanups.push(() => ipc.removeHandler(channel))
    }
    register(channels.publish, async (event, args) => {
      assertTrustedIpcSender(event, this.options.ownerTrust)
      if (args.length !== 1) throw new DesktopIpcFailure('invalid-input', '浮层投影无效。')
      const snapshot = parseBrowserFocusSnapshot(args[0])
      if (!snapshot) throw new DesktopIpcFailure('invalid-input', '浮层投影无效。')
      await this.publish(snapshot)
      return null
    })
    register(channels.read, (event, args) => {
      this.assertOverlaySender(event)
      if (args.length) throw new DesktopIpcFailure('invalid-input', '浮层请求无效。')
      return this.snapshot
    })
    register(channels.intent, (event, args) => {
      this.assertOverlaySender(event)
      const intent = args.length === 1 ? parseBrowserFocusIntent(args[0]) : null
      const state = this.snapshot
      if (!intent) throw new DesktopIpcFailure('invalid-input', '浮层操作无效。')
      if (
        !state?.visible ||
        !this.window?.isVisible() ||
        intent.projectionId !== state.projectionId
      ) {
        throw new DesktopIpcFailure('invalid-state', '浮层状态已更新。')
      }
      // 连续输入可晚于状态更新到达；普通操作按钮必须匹配最新确认版本。
      if (intent.kind === 'draft') {
        if (
          state.textareaDisabled ||
          intent.revision > state.revision ||
          intent.sequence <= this.latestDraftSequence
        ) {
          throw new DesktopIpcFailure('invalid-state', '草稿状态已更新。')
        }
      } else {
        // Stop 可落后于状态发布，但只能停止点击时看到的同一执行；执行已切换时必须拒绝。
        const stopMatchesCurrentExecution =
          intent.kind === 'stop' &&
          intent.revision <= state.revision &&
          state.execution !== null &&
          intent.execution.taskId === state.taskId &&
          intent.execution.executionId === state.execution.executionId &&
          intent.execution.taskId === state.execution.taskId &&
          intent.execution.turnId === state.execution.turnId
        if (
          (intent.kind !== 'stop' && intent.revision !== state.revision) ||
          (intent.kind === 'send' &&
            (!state.canSend || this.latestDraftSequence > state.draftAck)) ||
          (intent.kind === 'stop' && !stopMatchesCurrentExecution) ||
          (intent.kind !== 'expand' && this.actionRevision === state.revision)
        ) {
          throw new DesktopIpcFailure('invalid-state', '操作状态已更新。')
        }
      }
      if (!sendToTrustedRenderer(this.options.ownerTrust, channels.ownerIntent, intent)) {
        throw new DesktopIpcFailure('invalid-state', '主窗口暂不可用。')
      }
      if (intent.kind === 'draft') this.latestDraftSequence = intent.sequence
      else if (intent.kind !== 'expand') this.actionRevision = state.revision
      return null
    })
  }

  /** 只接受主窗口发布的新版本；缓存只是投影，不成为第二个草稿来源。 */
  async publish(snapshot: BrowserFocusSnapshot): Promise<void> {
    if (this.disposed) throw new DesktopIpcFailure('invalid-state', '浮层已关闭。')
    const previous = this.snapshot
    if (previous?.projectionId === snapshot.projectionId) {
      if (
        snapshot.taskId !== previous.taskId ||
        snapshot.revision <= previous.revision ||
        snapshot.draftAck < previous.draftAck
      ) {
        throw new DesktopIpcFailure('invalid-state', '浮层版本已过期。')
      }
    } else {
      this.latestDraftSequence = snapshot.draftAck
      this.actionRevision = -1
    }
    this.snapshot = snapshot
    if (!snapshot.visible) {
      this.pushSnapshot()
      this.window?.hide()
      return
    }
    const createsWindow = !this.window
    await this.ensureWindow()
    // macOS 首次创建父属子窗时，父子 isFocused 可能同时短暂为 false；
    // 主窗口主动发布可见投影足以证明当前窗口组仍是用户正在操作的目标。
    this.pushSnapshot()
    if (createsWindow) this.activateWindowGroup()
    else this.syncWindow()
  }

  /** 精确绑定本地页面与主 frame；同 origin 的其他页面也不能调用。 */
  private assertOverlaySender(event: IpcMainInvokeEvent): void {
    const window = this.window
    if (
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame?.url !== this.pageUrl
    )
      throw new DesktopIpcFailure('forbidden', '拒绝此浮层调用。')
  }

  /** 独立沙箱入口，不复用主窗口 preload；拒绝导航、弹窗与 WebView 附着。 */
  private async ensureWindow(): Promise<void> {
    if (this.window) return this.loading ?? Promise.resolve()
    const window = new BrowserWindow({
      parent: this.options.parent,
      width: 720,
      height: BROWSER_FOCUS_OVERLAY_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: true,
      // 必须关闭原生系统硬阴影，完全交由 Renderer CSS 提供柔和圆角弥散阴影，杜绝透明窗口外围溢出双层系统灰线。
      hasShadow: false,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        partition: 'browser-focus-overlay'
      }
    })
    this.window = window
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('will-redirect', (event) => event.preventDefault())
    window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false)
    )
    window.webContents.session.setPermissionCheckHandler(() => false)
    window.on('blur', this.handleOverlayBlur)
    window.on('focus', this.handleOverlayFocus)
    window.on('closed', () => {
      if (this.window === window) {
        this.loaded = false
        this.window = null
      }
    })
    const loading = window
      .loadURL(this.pageUrl)
      .then(() => {
        if (this.window === window && !window.isDestroyed()) this.loaded = true
      })
      .catch(() => {
        // 只收尾仍由当前实例持有的窗口，避免关闭后的异步失败再次销毁旧原生对象。
        if (this.window === window) {
          this.window = null
          this.loaded = false
          this.destroyWindow(window)
        }
        throw new DesktopIpcFailure('operation-failed', '无法加载浏览器输入浮层，请返回分栏。')
      })
      .finally(() => {
        if (this.loading === loading) this.loading = null
      })
    this.loading = loading
    return loading
  }

  /** 父子窗口之间切焦不闪退；离开窗口组时隐藏，避免盖住其他应用。 */
  private deferFocusCheck = (): void => {
    if (this.disposed) return
    if (this.focusCheck) clearImmediate(this.focusCheck)
    this.focusCheck = setImmediate(() => {
      this.focusCheck = null
      const window = this.window
      if (
        this.parentFocusObserved ||
        this.overlayFocusObserved ||
        this.options.parent.isFocused() ||
        Boolean(window && !window.isDestroyed() && window.isFocused())
      ) {
        this.windowGroupActive = true
        this.syncWindow()
        return
      }
      this.deactivateWindowGroup()
    })
  }

  private handleParentFocus = (): void => {
    this.parentFocusObserved = true
    this.activateWindowGroup()
  }

  private handleParentBlur = (): void => {
    this.parentFocusObserved = false
    this.deferFocusCheck()
  }

  private handleOverlayFocus = (): void => {
    this.overlayFocusObserved = true
    this.activateWindowGroup()
  }

  private handleOverlayBlur = (): void => {
    this.overlayFocusObserved = false
    this.deferFocusCheck()
  }

  /** focus 事件本身就是窗口组回到前台的证据；取消上一轮 blur 检查以避免组内切焦闪烁。 */
  private activateWindowGroup = (): void => {
    const parent = this.options.parent
    if (this.disposed || parent.isDestroyed() || parent.isMinimized() || !parent.isVisible()) {
      this.deactivateWindowGroup()
      return
    }
    if (this.focusCheck) {
      clearImmediate(this.focusCheck)
      this.focusCheck = null
    }
    this.windowGroupActive = true
    this.syncWindow()
  }

  /** 最小化、隐藏或确认离开父子窗口组后立即撤下子窗，绝不覆盖其他应用。 */
  private deactivateWindowGroup = (): void => {
    if (this.focusCheck) {
      clearImmediate(this.focusCheck)
      this.focusCheck = null
    }
    this.parentFocusObserved = false
    this.overlayFocusObserved = false
    this.windowGroupActive = false
    this.window?.hide()
  }

  /** 原生窗口更新只 showInactive，输入焦点由用户点击或键盘操作决定。 */
  private syncWindow(): void {
    const parent = this.options.parent
    const window = this.window
    if (!window || window.isDestroyed() || this.disposed) return
    const state = this.snapshot
    const bounds =
      state && !parent.isDestroyed()
        ? resolveBrowserFocusBounds(
            parent.getContentBounds(),
            state.browserBounds,
            parent.webContents.getZoomFactor()
          )
        : null
    if (
      !this.loaded ||
      !state?.visible ||
      !bounds ||
      parent.isDestroyed() ||
      parent.isMinimized() ||
      !parent.isVisible() ||
      !this.windowGroupActive
    ) {
      window.hide()
      return
    }
    window.setBounds(bounds)
    if (!window.isVisible()) window.showInactive()
  }

  private pushSnapshot(): void {
    if (
      this.loaded &&
      this.window &&
      !this.window.isDestroyed() &&
      this.snapshot &&
      this.window.webContents.mainFrame.url === this.pageUrl
    ) {
      this.window.webContents.send(channels.snapshot, this.snapshot)
    }
  }

  /** 先检查再 destroy 仍有原生竞态；只吞 Electron 已销毁错误，其他异常继续上抛。 */
  private destroyWindow(window: BrowserWindow): void {
    try {
      if (!window.isDestroyed()) window.destroy()
    } catch (error) {
      if (!isDestroyedNativeObjectError(error)) throw error
    }
  }

  /** 主窗关闭时一次性撤销所有入口与延迟焦点检查，不向已销毁 frame 发事件。 */
  destroy = (): void => {
    if (this.disposed) return
    this.disposed = true
    if (this.focusCheck) {
      clearImmediate(this.focusCheck)
      this.focusCheck = null
    }
    // 先摘掉引用，destroy 同步触发 closed 时便不会重入同一原生窗口。
    const window = this.window
    this.window = null
    this.loaded = false
    this.snapshot = null
    const cleanupErrors: unknown[] = []
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup()
      } catch (error) {
        // 一个已释放的原生对象不能阻断后续 IPC Handler 与窗口资源清理。
        if (!isDestroyedNativeObjectError(error)) cleanupErrors.push(error)
      }
    }
    if (window) {
      try {
        this.destroyWindow(window)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (cleanupErrors.length) throw cleanupErrors[0]
  }
}
