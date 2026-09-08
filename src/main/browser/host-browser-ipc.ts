import { ipcMain, BrowserWindow } from 'electron'
import { TASK_INVOKE_CHANNELS } from '../../shared/task-ipc'
import type { HostBrowserService } from './host-browser-service'
import type { HostBrowserChrome } from '../../shared/host-browser'

export function registerHostBrowserIpc(service: HostBrowserService, mainWindow: BrowserWindow): void {
  ipcMain.handle(TASK_INVOKE_CHANNELS.setBrowserOpen, async (event, _taskId: string, open: boolean) => {
    if (event.sender.id !== mainWindow.webContents.id) {
      return { kind: 'error', error: { code: 'unauthorized', message: 'Unauthorized sender' } }
    }
    if (open) {
      service.show()
    } else {
      service.hide()
    }
    return { kind: 'success', data: null }
  })

  ipcMain.handle(TASK_INVOKE_CHANNELS.updateBrowserBounds, async (event, _taskId: string, bounds: { x: number; y: number; width: number; height: number }) => {
    if (event.sender.id !== mainWindow.webContents.id) {
      return { kind: 'error', error: { code: 'unauthorized', message: 'Unauthorized sender' } }
    }
    service.setBounds(bounds.x, bounds.y, bounds.width, bounds.height)
    return { kind: 'success', data: null }
  })

  ipcMain.handle(TASK_INVOKE_CHANNELS.userNavigateBrowser, async (event, _taskId: string, url: string) => {
    if (event.sender.id !== mainWindow.webContents.id) {
      return { kind: 'error', error: { code: 'unauthorized', message: 'Unauthorized sender' } }
    }
    
    if (url.length > 2048) {
      return { kind: 'error', error: { code: 'invalid-url', message: 'URL too long' } }
    }
    
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { kind: 'error', error: { code: 'invalid-url', message: 'Only http/https allowed' } }
      }
    } catch {
      return { kind: 'error', error: { code: 'invalid-url', message: 'Invalid URL' } }
    }

    // A real implementation would fetch the active view for the task's project
    const view = service.getOrCreateView('dummy-project-for-now')
    view.webContents.loadURL(url)
    
    return { kind: 'success', data: null }
  })

  ipcMain.handle(TASK_INVOKE_CHANNELS.getBrowserChrome, async (event, _taskId: string) => {
    if (event.sender.id !== mainWindow.webContents.id) {
      return { kind: 'error', error: { code: 'unauthorized', message: 'Unauthorized sender' } }
    }
    
    // Stub
    const chrome: HostBrowserChrome = {
      url: 'about:blank',
      title: 'Blank',
      isLoading: false,
      open: false
    }
    return { kind: 'success', data: chrome }
  })
}
