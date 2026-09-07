const IPC_INVOKE_PREFIX = /^Error invoking remote method '[^']+': (?:Error:\s*)?/i

/**
 * 把 Electron invoke 外壳剥掉，只把主进程已经脱敏的正文交给 UI。
 * Renderer 不得再展示 channel 名或 `Error invoking remote method`。
 */
export function readRendererErrorMessage(error: unknown, fallback = '操作失败。'): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof (error as { message?: unknown } | null)?.message === 'string'
          ? (error as { message: string }).message
          : ''
  const text = raw.replace(IPC_INVOKE_PREFIX, '').trim()
  return text || fallback
}
