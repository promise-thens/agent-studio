import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { GrokAgentBridge } from './grok-agent'

let mainWindow: BrowserWindow | null = null

const agent = new GrokAgentBridge(
  (status) => mainWindow?.webContents.send('grok:status', status),
  (event) => mainWindow?.webContents.send('grok:event', event),
  (request) => mainWindow?.webContents.send('grok:permission', request)
)

/** 创建应用主窗口，并限制渲染层直接访问系统能力。 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: '#0d1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 17 },
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** 注册渲染层可调用的最小 IPC 接口。 */
function registerIpcHandlers(): void {
  ipcMain.handle('grok:get-status', () => agent.getStatus())
  ipcMain.handle('grok:choose-workspace', async () => {
    const options: Electron.OpenDialogOptions = {
      title: '选择 Grok Build 工作目录',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('grok:connect', (_event, workspace: string) => agent.connect(workspace))
  ipcMain.handle('grok:disconnect', () => agent.disconnect())
  ipcMain.handle('grok:send-prompt', (_event, prompt: string) => agent.sendPrompt(prompt))
  ipcMain.handle('grok:cancel', () => agent.cancel())
  ipcMain.handle('grok:respond-permission', (_event, requestId: string, optionId?: string) =>
    agent.respondPermission(requestId, optionId)
  )
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.promise-thens.grok-build-desktop')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  void agent.disconnect(false)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
