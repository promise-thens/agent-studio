import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { APP_APPEARANCE_BACKGROUNDS } from '../../shared/app-appearance'
import {
  APPEARANCE_OPTIONS,
  DEFAULT_SETTINGS_SECTION,
  applyResolvedAppearance,
  resolveSettingsSection
} from './settings-dialog'

const rendererDir = dirname(fileURLToPath(import.meta.url))
const baseCss = readFileSync(join(rendererDir, 'assets/base.css'), 'utf8')
const settingsSource = readFileSync(join(rendererDir, 'components/SettingsDialog.vue'), 'utf8')

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
    expect(APPEARANCE_OPTIONS.find((option) => option.mode === 'light')?.description).not.toMatch(
      /暖色/
    )
  })

  it('米白底色跟窗口背景一致，不再用暖黄纸色', () => {
    const lightBg = APP_APPEARANCE_BACKGROUNDS.light
    expect(lightBg).toBe('#f7f7f8')
    expect(baseCss).toContain(`--app-bg: ${lightBg}`)
    expect(baseCss).not.toContain('#f4efe6')
    expect(baseCss).toContain('--text-1: #1c1c1e')
    expect(settingsSource).toContain(lightBg)
    expect(settingsSource).not.toContain('#f4efe6')
  })
})
