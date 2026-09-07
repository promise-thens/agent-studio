import { contextBridge, ipcRenderer } from 'electron'
import { AGENT_INVOKE_CHANNELS } from '../shared/agent-ipc'
import {
  parseBrowserPluginOverlaySnapshot,
  type BrowserPluginOverlaySnapshot,
  type OverlayDesktopApi
} from '../shared/browser-plugin-overlay'
import type { DesktopIpcResult } from '../shared/ipc-result'
import { TASK_PUSH_CHANNELS, TASK_SEND_CHANNELS } from '../shared/task-ipc'

/**
 * Overlay 只允许订阅快照、调用现有 agent:cancel-turn，以及芯片 hover 穿透切换。
 * 禁止把完整 window.agent / window.app / window.electron 注入这扇窗口。
 */
function exposeOverlayApi(
  contextIsolated: boolean,
  exposeInMainWorld: (apiKey: string, api: unknown) => void
): void {
  if (!contextIsolated) {
    throw new Error('Agent Studio 需要启用 contextIsolation。')
  }

  let lastSnapshot: BrowserPluginOverlaySnapshot | null = null

  const api: OverlayDesktopApi = {
    onSnapshot(listener) {
      const handler = (_event: unknown, payload: unknown): void => {
        const snapshot = parseBrowserPluginOverlaySnapshot(payload)
        if (!snapshot) return
        lastSnapshot = snapshot
        listener(snapshot)
      }
      ipcRenderer.on(TASK_PUSH_CHANNELS.browserPluginOverlay, handler)
      let cleaned = false
      return () => {
        if (cleaned) return
        cleaned = true
        ipcRenderer.removeListener(TASK_PUSH_CHANNELS.browserPluginOverlay, handler)
      }
    },
    async cancelTurn() {
      const snapshot = lastSnapshot
      if (!snapshot?.visible || !snapshot.executionId || !snapshot.taskId || !snapshot.turnId) {
        return {
          ok: false,
          error: { code: 'invalid-state', message: '当前没有可停止的浏览器控制。' }
        }
      }
      return (await ipcRenderer.invoke(AGENT_INVOKE_CHANNELS.cancelTurn, {
        executionId: snapshot.executionId,
        taskId: snapshot.taskId,
        turnId: snapshot.turnId
      })) as DesktopIpcResult<void>
    },
    setChipHover(hovered) {
      ipcRenderer.send(TASK_SEND_CHANNELS.browserPluginOverlayChipHover, hovered === true)
    }
  }

  exposeInMainWorld('overlay', api)
}

exposeOverlayApi(process.contextIsolated, (apiKey, api) =>
  contextBridge.exposeInMainWorld(apiKey, api)
)
