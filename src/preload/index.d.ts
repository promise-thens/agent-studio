import type { AgentDesktopApi } from '../shared/agent-ipc'
import type { AppDesktopApi } from '../shared/app-ipc'
import type { ProviderDesktopApi } from '../shared/provider'
import type { TaskDesktopApi } from '../shared/task-ipc'

declare global {
  interface Window {
    agent: AgentDesktopApi
    app: AppDesktopApi
    task: TaskDesktopApi
    provider: ProviderDesktopApi
  }
}
