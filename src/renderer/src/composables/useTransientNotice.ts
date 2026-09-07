import { ref, type Ref } from 'vue'

export const TRANSIENT_NOTICE_DURATION_MS = 4_000

export interface TransientNoticeState {
  message: Ref<string | null>
  show: (text: string) => void
  dismiss: () => void
  dispose: () => void
}

/**
 * 顶部短提示：操作失败时弹出小框，几秒后自动消失。
 * 新提示会取消上一次定时器，避免旧错误把新错误提前清掉。
 */
export function useTransientNotice(
  durationMs = TRANSIENT_NOTICE_DURATION_MS
): TransientNoticeState {
  const message = ref<string | null>(null)
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  function clearTimer(): void {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  function show(text: string): void {
    const next = ++generation
    message.value = text
    clearTimer()
    timer = setTimeout(() => {
      if (generation !== next) return
      message.value = null
      timer = null
    }, durationMs)
  }

  function dismiss(): void {
    generation += 1
    clearTimer()
    message.value = null
  }

  function dispose(): void {
    dismiss()
  }

  return { message, show, dismiss, dispose }
}
