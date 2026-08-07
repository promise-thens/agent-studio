import type { ElectronAPI } from '@electron-toolkit/preload'
import type { GrokDesktopApi } from '../shared/grok'

declare global {
  interface Window {
    electron: ElectronAPI
    grok: GrokDesktopApi
  }
}
