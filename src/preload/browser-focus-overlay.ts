import { contextBridge, ipcRenderer } from 'electron'
import { createBrowserFocusOverlayApi } from './browser-focus-api'

/** 输入子窗专用沙箱入口，绝不注入主窗口的 app/task/provider API。 */
if (!process.contextIsolated) throw new Error('浏览器输入浮层需要 contextIsolation。')
contextBridge.exposeInMainWorld('browserFocusOverlay', createBrowserFocusOverlayApi(ipcRenderer))
