import {
  BROWSER_FOCUS_CHANNELS as channels,
  parseBrowserFocusIntent,
  parseBrowserFocusSnapshot,
  type BrowserFocusOverlayApi,
  type BrowserFocusOwnerApi
} from '../shared/browser-focus-overlay'
import type { DesktopIpcResult } from '../shared/ipc-result'
import type { NarrowIpcRenderer } from './desktop-api'

/** 窄订阅仅传解析后的 payload，清理不影响同 channel 的其他订阅。 */
function subscribe<T>(
  ipc: NarrowIpcRenderer,
  channel: string,
  parse: (payload: unknown) => T | null,
  listener: (value: T) => void
): () => void {
  const handler = (_event: unknown, payload: unknown): void => {
    const value = parse(payload)
    if (value) listener(value)
  }
  ipc.on(channel, handler)
  return () => ipc.removeListener(channel, handler)
}

/** 主窗口专用：发布受控状态、订阅操作；不向子窗暴露此 API。 */
export function createBrowserFocusOwnerApi(ipc: NarrowIpcRenderer): BrowserFocusOwnerApi {
  return {
    publish: (snapshot) =>
      ipc.invoke(channels.publish, parseBrowserFocusSnapshot(snapshot)) as Promise<
        DesktopIpcResult<null>
      >,
    onIntent: (listener) => subscribe(ipc, channels.ownerIntent, parseBrowserFocusIntent, listener)
  }
}

/** 子窗专用：只有读投影、订阅和窄操作，不能创建任务或直接停止 Runtime。 */
export function createBrowserFocusOverlayApi(ipc: NarrowIpcRenderer): BrowserFocusOverlayApi {
  return {
    async read() {
      const result = (await ipc.invoke(channels.read)) as DesktopIpcResult<unknown>
      if (!result.ok) return result
      const snapshot = parseBrowserFocusSnapshot(result.value)
      if (result.value !== null && !snapshot) {
        return { ok: false, error: { code: 'invalid-state', message: '浮层投影无效。' } }
      }
      return { ok: true, value: snapshot }
    },
    dispatch: (intent) =>
      ipc.invoke(channels.intent, parseBrowserFocusIntent(intent)) as Promise<
        DesktopIpcResult<null>
      >,
    onSnapshot: (listener) => subscribe(ipc, channels.snapshot, parseBrowserFocusSnapshot, listener)
  }
}
