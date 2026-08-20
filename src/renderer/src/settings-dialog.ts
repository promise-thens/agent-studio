import type { AppAppearanceMode, AppResolvedAppearance } from '../../shared/app-appearance'

export type SettingsSection = 'provider' | 'appearance'

export interface SettingsSectionDefinition {
  id: SettingsSection
  label: string
}

export interface AppearanceOption {
  mode: AppAppearanceMode
  label: string
  description: string
}

export interface AppearanceDocumentRoot {
  dataset: {
    theme?: string
    colorMode?: string
    darkTheme?: string
    lightTheme?: string
  }
  style: { colorScheme: string }
}

export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'provider'

export const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  { id: 'provider', label: '供应商' },
  { id: 'appearance', label: '外观' }
]

export const APPEARANCE_OPTIONS: readonly AppearanceOption[] = [
  { mode: 'dark', label: '深色', description: '当前工作台默认外观。' },
  { mode: 'light', label: '米白', description: '浅灰白底，适合白天阅读。' },
  { mode: 'system', label: '跟随系统', description: '系统浅色用米白，系统深色用现有深色。' }
]

const SETTINGS_SECTION_IDS = SETTINGS_SECTIONS.map((section) => section.id)

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === 'string' && SETTINGS_SECTION_IDS.includes(value as SettingsSection)
}

/** 未知栏目一律回到供应商，避免弹窗右侧空白。 */
export function resolveSettingsSection(value: unknown): SettingsSection {
  return isSettingsSection(value) ? value : DEFAULT_SETTINGS_SECTION
}

/**
 * 把主进程解析后的主题写到 html。
 * 同时维护 Primer 的 data-color-mode，避免 Markdown 代码块还停在深色变量。
 */
export function applyResolvedAppearance(
  resolved: AppResolvedAppearance,
  root: AppearanceDocumentRoot = document.documentElement
): void {
  root.dataset.theme = resolved
  root.dataset.colorMode = resolved
  root.style.colorScheme = resolved
  if (resolved === 'dark') {
    root.dataset.darkTheme = 'dark'
    delete root.dataset.lightTheme
    return
  }
  root.dataset.lightTheme = 'light'
  delete root.dataset.darkTheme
}
