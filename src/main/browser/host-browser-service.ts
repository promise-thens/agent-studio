import { WebContentsView, BaseWindow } from 'electron'
import { createBrowserPartition, createBrowserWebPreferences } from './host-browser-session'

export class HostBrowserService {
  private view: WebContentsView | null = null
  private currentProjectId: string | null = null
  private bounds: { x: number; y: number; width: number; height: number } | null = null
  private isVisible = false

  constructor(private mainWindow: BaseWindow) {}

  public getOrCreateView(projectId: string): WebContentsView {
    if (this.view && this.currentProjectId === projectId) {
      return this.view
    }

    this.destroyView()
    this.currentProjectId = projectId

    this.view = new WebContentsView({
      webPreferences: {
        ...createBrowserWebPreferences(),
        partition: createBrowserPartition(projectId)
      }
    })

    const wc = this.view.webContents
    
    wc.on('will-navigate', (event, url) => {
      try {
        const parsedUrl = new URL(url)
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          event.preventDefault()
        }
      } catch {
        event.preventDefault()
      }
    })

    wc.setWindowOpenHandler(() => {
      return { action: 'deny' }
    })

    wc.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })

    wc.session.on('will-download', (event) => {
      event.preventDefault()
    })

    return this.view
  }

  public destroyView(): void {
    if (this.view) {
      if (this.isVisible) {
        this.mainWindow.contentView.removeChildView(this.view)
      }
      try {
        ;(this.view.webContents as any).destroy?.()
      } catch {
        // ignore
      }
      this.view = null
      this.currentProjectId = null
      this.isVisible = false
    }
  }

  public setBounds(x: number, y: number, width: number, height: number): void {
    if (!this.view) return
    this.bounds = { x: Math.floor(x), y: Math.floor(y), width: Math.floor(width), height: Math.floor(height) }
    if (this.isVisible) {
      this.view.setBounds(this.bounds)
    }
  }

  public show(): void {
    if (!this.view || this.isVisible) return
    this.mainWindow.contentView.addChildView(this.view)
    if (this.bounds) {
      this.view.setBounds(this.bounds)
    }
    this.isVisible = true
  }

  public hide(): void {
    if (!this.view || !this.isVisible) return
    this.mainWindow.contentView.removeChildView(this.view)
    this.isVisible = false
  }
}
