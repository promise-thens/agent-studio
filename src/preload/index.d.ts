import type { AgentDesktopApi } from '../shared/agent-ipc'
import type { AppDesktopApi } from '../shared/app-ipc'
import type { OverlayDesktopApi } from '../shared/browser-plugin-overlay'
import type { ProviderDesktopApi } from '../shared/provider'
import type { TaskDesktopApi } from '../shared/task-ipc'

declare global {
  interface Window {
    agent: AgentDesktopApi
    app: AppDesktopApi
    task: TaskDesktopApi
    provider: ProviderDesktopApi
    /** 仅 overlay 窗口由独立 preload 注入；主窗口不得依赖此 API。 */
    overlay?: OverlayDesktopApi
  }
}
