import type { ElectronAPI } from '@electron-toolkit/preload'
import type { GrokDesktopApi } from '../shared/grok'
import type { ProviderDesktopApi } from '../shared/provider'

declare global {
  interface Window {
    electron: ElectronAPI
    grok: GrokDesktopApi
    provider: ProviderDesktopApi
  }
}
