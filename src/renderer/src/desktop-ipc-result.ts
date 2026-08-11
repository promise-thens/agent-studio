import type { DesktopIpcErrorCode, DesktopIpcResult } from '../../shared/ipc-result'

export interface RendererDesktopIpcError extends Error {
  code: DesktopIpcErrorCode
}

/** 在 Renderer 自己的执行环境中把有限失败结果转换为带稳定 code 的 Error。 */
export function unwrapDesktopIpcResult<T>(result: DesktopIpcResult<T>): T {
  if (result.ok) return result.value

  const error = new Error(result.error.message) as RendererDesktopIpcError
  error.name = 'DesktopIpcError'
  error.code = result.error.code
  throw error
}
