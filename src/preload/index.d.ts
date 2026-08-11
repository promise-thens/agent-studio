import type { AgentDesktopApi } from '../shared/agent-ipc'
import type { AppDesktopApi } from '../shared/app-ipc'
import type { ProviderDesktopApi } from '../shared/provider'

declare global {
  interface Window {
    agent: AgentDesktopApi
    app: AppDesktopApi
    provider: ProviderDesktopApi
  }
}
