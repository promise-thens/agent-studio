import { describe, expect, it } from 'vitest'
import {
  APPEARANCE_OPTIONS,
  DEFAULT_SETTINGS_SECTION,
  applyResolvedAppearance,
  resolveSettingsSection
} from './settings-dialog'

describe('设置弹窗与外观应用', () => {
  it('非法栏目回到供应商', () => {
    expect(resolveSettingsSection('appearance')).toBe('appearance')
    expect(resolveSettingsSection('fonts')).toBe(DEFAULT_SETTINGS_SECTION)
  })

  it('解析后的主题写到 document dataset 和 color-scheme', () => {
    const root = {
      dataset: {} as Record<string, string | undefined>,
      style: { colorScheme: '' }
    }
    applyResolvedAppearance('light', root)
    expect(root.dataset.theme).toBe('light')
    expect(root.dataset.colorMode).toBe('light')
    expect(root.dataset.lightTheme).toBe('light')
    expect(root.dataset.darkTheme).toBeUndefined()
    expect(root.style.colorScheme).toBe('light')

    applyResolvedAppearance('dark', root)
    expect(root.dataset.theme).toBe('dark')
    expect(root.dataset.colorMode).toBe('dark')
    expect(root.dataset.darkTheme).toBe('dark')
    expect(root.dataset.lightTheme).toBeUndefined()
    expect(root.style.colorScheme).toBe('dark')
  })

  it('外观选项包含深色、米白和跟随系统', () => {
    expect(APPEARANCE_OPTIONS.map((option) => option.mode)).toEqual(['dark', 'light', 'system'])
    expect(APPEARANCE_OPTIONS.map((option) => option.label)).toEqual(['深色', '米白', '跟随系统'])
  })
})
