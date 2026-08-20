/** 用户选择的外观偏好。light 对应内置米白主题。 */
export const APP_APPEARANCE_MODES = ['dark', 'light', 'system'] as const
export type AppAppearanceMode = (typeof APP_APPEARANCE_MODES)[number]
export type AppResolvedAppearance = 'dark' | 'light'

export interface AppAppearanceState {
  mode: AppAppearanceMode
  resolved: AppResolvedAppearance
}

export const DEFAULT_APP_APPEARANCE_MODE: AppAppearanceMode = 'dark'

/** 窗口背景必须和 CSS --app-bg 同步，避免主题切换时闪一帧错误底色。 */
export const APP_APPEARANCE_BACKGROUNDS: Record<AppResolvedAppearance, string> = {
  dark: '#0d1117',
  light: '#f7f7f8'
}

export function isAppAppearanceMode(value: unknown): value is AppAppearanceMode {
  return value === 'dark' || value === 'light' || value === 'system'
}

/** 跟随系统时用 OS 深浅；显式深色/米白不读 OS。 */
export function resolveAppearance(
  mode: AppAppearanceMode,
  systemPrefersDark: boolean
): AppResolvedAppearance {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light'
  return mode === 'light' ? 'light' : 'dark'
}

export function appearanceWindowBackground(resolved: AppResolvedAppearance): string {
  return APP_APPEARANCE_BACKGROUNDS[resolved]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Preload / IPC 只接受 { mode, resolved }，多余字段直接丢弃。 */
export function parseAppAppearanceState(value: unknown): AppAppearanceState | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('mode') || !keys.includes('resolved')) return null
  if (!isAppAppearanceMode(value.mode)) return null
  if (value.resolved !== 'dark' && value.resolved !== 'light') return null
  return { mode: value.mode, resolved: value.resolved }
}
