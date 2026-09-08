import { ipcMain, BrowserWindow } from 'electron'
import { TASK_INVOKE_CHANNELS } from '../../shared/task-ipc'
import type { HostBrowserService } from './host-browser-service'

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

  // getBrowserChrome & userNavigateBrowser left to be implemented when actual project binding is set up
}
