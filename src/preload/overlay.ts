import { contextBridge, ipcRenderer } from 'electron'
import { AGENT_INVOKE_CHANNELS } from '../shared/agent-ipc'
import {
  parseAgentPointerSnapshot,
  type AgentPointerSnapshot
} from '../shared/agent-pointer-overlay'
import type { OverlayDesktopApi } from '../shared/browser-plugin-overlay'
import type { DesktopIpcResult } from '../shared/ipc-result'
import { TASK_PUSH_CHANNELS, TASK_SEND_CHANNELS } from '../shared/task-ipc'

/**
 * 插件通道常省略 surface / persistWhenUnfocused；缺省按 browser-plugin 理解并丢 pointer。
 * host-browser 才保留已映射 DIP。computer-use 仍被 parseAgentPointerSnapshot 拒收。
 */
function parseOverlayPointerSnapshot(payload: unknown): AgentPointerSnapshot | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const value = payload as Record<string, unknown>
  // computer-use 本波无 producer，不得改写成插件/宿主 surface
  if (value.surface === 'computer-use') return null
  return parseAgentPointerSnapshot({
    visible: value.visible,
    surface: value.surface === 'host-browser' ? 'host-browser' : 'browser-plugin',
    persistWhenUnfocused: value.persistWhenUnfocused === true,
    taskId: value.taskId,
    turnId: value.turnId,
    executionId: value.executionId,
    pointer: value.pointer
  })
}

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

  let lastSnapshot: AgentPointerSnapshot | null = null

  const api: OverlayDesktopApi = {
    onSnapshot(listener) {
      const handler = (_event: unknown, payload: unknown): void => {
        const snapshot = parseOverlayPointerSnapshot(payload)
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
