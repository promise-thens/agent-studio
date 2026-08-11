/** 桌面 IPC 失败只保留稳定错误码和可展示的有限文案。 */
export type DesktopIpcErrorCode =
  | 'forbidden'
  | 'invalid-input'
  | 'payload-too-large'
  | 'invalid-workspace'
  | 'runtime-unavailable'
  | 'invalid-state'
  | 'operation-failed'

export interface DesktopIpcError {
  code: DesktopIpcErrorCode
  message: string
}

/** Agent 与 App invoke 统一使用可结构化克隆的显式结果封套。 */
export type DesktopIpcResult<T> = { ok: true; value: T } | { ok: false; error: DesktopIpcError }
