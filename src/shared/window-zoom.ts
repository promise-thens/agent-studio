export const DEFAULT_ZOOM_FACTOR = 1
export const MIN_ZOOM_FACTOR = 0.5
export const MAX_ZOOM_FACTOR = 2
export const ZOOM_STEP = 0.1

export type WindowZoomAction = 'in' | 'out' | 'reset'

export interface WindowZoomShortcutInput {
  platform: NodeJS.Platform
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  key: string
}

/**
 * 识别页面缩放快捷键。
 * macOS 只用 Command，其它平台只用 Control，避免和输入框/系统快捷键抢 Option。
 */
export function resolveWindowZoomAction(input: WindowZoomShortcutInput): WindowZoomAction | null {
  const hasPrimaryModifier =
    input.platform === 'darwin' ? input.metaKey && !input.ctrlKey : input.ctrlKey && !input.metaKey
  if (!hasPrimaryModifier || input.altKey) return null

  const key = input.key.length === 1 ? input.key : input.key.toLowerCase()
  if (key === '=' || key === '+' || key === 'add') return 'in'
  if (key === '-' || key === '_' || key === 'subtract') return 'out'
  if (key === '0' || key === 'digit0' || key === 'numpad0') return 'reset'
  return null
}

/** 按 10% 步进，四舍五入到一位小数，避免 1.1 + 0.1 变成 1.2000000002。 */
export function nextZoomFactor(current: number, action: WindowZoomAction): number {
  if (action === 'reset') return DEFAULT_ZOOM_FACTOR
  const delta = action === 'in' ? ZOOM_STEP : -ZOOM_STEP
  const next = Math.round((current + delta) * 10) / 10
  return Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, next))
}
