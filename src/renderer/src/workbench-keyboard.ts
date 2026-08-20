export type EscapeWorkbenchTarget = 'stop-button' | 'close-inspector' | 'none'

/**
 * 执行中 Esc 先保证停止可达；只有焦点已在检查器内部时才关抽屉。
 * 空闲时保持「Esc 关检查器」。
 */
export function resolveEscapeWorkbenchTarget(input: {
  turnExecuting: boolean
  inspectorOpen: boolean
  focusInsideInspector: boolean
}): EscapeWorkbenchTarget {
  if (input.turnExecuting && !input.focusInsideInspector) return 'stop-button'
  if (input.inspectorOpen) return 'close-inspector'
  return 'none'
}

/** 输入法、已处理按键、权限卡/确认框自己要吃掉 Esc 时，工作台不要再抢。 */
export function shouldIgnoreWorkbenchEscape(input: {
  key: string
  isComposing?: boolean
  keyCode?: number
  defaultPrevented?: boolean
  overlayConsumesEscape?: boolean
}): boolean {
  if (input.key !== 'Escape') return true
  if (input.defaultPrevented) return true
  if (input.isComposing || input.keyCode === 229) return true
  return Boolean(input.overlayConsumesEscape)
}

export function overlayConsumesEscape(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest('.modal-backdrop, .permission-dialog, .permission-inline-card'))
  )
}

export function isFocusInsideInspector(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-inspector-drawer]'))
}
