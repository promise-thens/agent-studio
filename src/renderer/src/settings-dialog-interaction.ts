import { watch, type WatchStopHandle } from 'vue'

/** 设置壳只接收交互摘要，不接收配置正文或密钥。 */
export interface SettingsPaneState {
  dirty: boolean
  saving: boolean
  error: string
  message?: string
}

/** 同步汇报状态，避免 blur 保存与同一轮 click 离开之间出现保护空窗。 */
export function reportSettingsPaneState(
  read: () => SettingsPaneState,
  report: (state: SettingsPaneState) => void
): WatchStopHandle {
  return watch(read, report, { immediate: true, flush: 'sync' })
}

/** 保存中不允许销毁子页；只有用户明确确认才丢弃草稿。 */
export function canLeaveSettingsPane(
  state: SettingsPaneState,
  confirmDiscard: () => boolean
): boolean {
  return !state.saving && (!state.dirty || confirmDiscard())
}

/** 反馈优先展示正在进行的操作和失败，不把 dirty 或即时项误报为已保存。 */
export function settingsPaneFeedback(state: SettingsPaneState): string {
  if (state.saving) return '正在处理，请稍候再离开。'
  if (state.error) return state.dirty ? '操作失败，未保存的更改仍保留在当前页。' : '操作失败，请查看页面提示并重试。'
  if (state.dirty) return '有未保存的更改，离开前请保存或确认丢弃。'
  return state.message || '当前没有未保存的更改。'
}

/** 动态读取可见控件，兼容子页加载、禁用 fieldset 和原生 radio 的 Tab 顺序。 */
export function settingsTabStops(root: HTMLElement): HTMLElement[] {
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], summary, [tabindex]'
    )
  ).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(':disabled') &&
      !element.closest('[inert], [hidden]') &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden'
  )
  return candidates.filter((element) => {
    if (!(element instanceof HTMLInputElement) || element.type !== 'radio' || !element.name) {
      return true
    }
    const group = candidates.filter(
      (other): other is HTMLInputElement =>
        other instanceof HTMLInputElement && other.type === 'radio' && other.name === element.name
    )
    return element === (group.find((other) => other.checked) ?? group[0])
  })
}

/** 模态期间隔离背景 DOM 并捕获键盘；原生 WebContentsView 仍由 App 协调隐藏。 */
export function mountSettingsFocus(
  root: HTMLElement,
  requestClose: () => void,
  returnFocus: HTMLElement | null
): () => void {
  const isolated: Array<{ element: HTMLElement; inert: boolean }> = []
  let branch: HTMLElement = root
  while (branch.parentElement) {
    for (const sibling of Array.from(branch.parentElement.children)) {
      if (sibling !== branch && sibling instanceof HTMLElement) {
        isolated.push({ element: sibling, inert: sibling.inert })
        sibling.inert = true
      }
    }
    if (branch.parentElement === document.body) break
    branch = branch.parentElement
  }
  const focusEntry = (): void => (settingsTabStops(root)[0] ?? root).focus()
  const onFocus = (event: FocusEvent): void => {
    if (!root.contains(event.target as Node)) focusEntry()
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      requestClose()
    } else if (event.key === 'Tab') {
      const stops = settingsTabStops(root)
      const current = stops.indexOf(document.activeElement as HTMLElement)
      if (!stops.length || current < 0 || (event.shiftKey ? current === 0 : current === stops.length - 1)) {
        event.preventDefault()
        ;(event.shiftKey ? stops.at(-1) ?? root : stops[0] ?? root).focus()
      }
    }
  }
  window.addEventListener('keydown', onKey, true)
  document.addEventListener('focusin', onFocus)
  focusEntry()
  return () => {
    window.removeEventListener('keydown', onKey, true)
    document.removeEventListener('focusin', onFocus)
    for (const { element, inert } of isolated) element.inert = inert
    if (returnFocus?.isConnected) returnFocus.focus()
  }
}
