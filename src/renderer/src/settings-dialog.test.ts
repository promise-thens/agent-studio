import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { APP_APPEARANCE_BACKGROUNDS } from '../../shared/app-appearance'
import {
  APPEARANCE_OPTIONS,
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  applyResolvedAppearance,
  resolveSettingsSection
} from './settings-dialog'

const rendererDir = dirname(fileURLToPath(import.meta.url))
const baseCss = readFileSync(join(rendererDir, 'assets/base.css'), 'utf8')
const settingsSource = readFileSync(join(rendererDir, 'components/SettingsDialog.vue'), 'utf8')
const onboardingSource = readFileSync(
  join(rendererDir, 'components/ProviderOnboarding.vue'),
  'utf8'
)

describe('设置弹窗与外观应用', () => {
  it('非法栏目回到供应商', () => {
    expect(resolveSettingsSection('appearance')).toBe('appearance')
    expect(resolveSettingsSection('grok-config')).toBe('grok-config')
    expect(resolveSettingsSection('memory')).toBe('memory')
    expect(resolveSettingsSection('hooks')).toBe('hooks')
    expect(resolveSettingsSection('browser')).toBe('browser')
    expect(resolveSettingsSection('mcp')).toBe(DEFAULT_SETTINGS_SECTION)
    expect(resolveSettingsSection('fonts')).toBe(DEFAULT_SETTINGS_SECTION)
    expect(settingsSource).not.toContain("section === 'mcp'")
    expect(settingsSource).not.toContain('McpSettingsPanel')
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

  it('侧栏在 Grok 配置后单独开浏览器页，不并进 grok-config', () => {
    const grokConfigSource = readFileSync(
      join(rendererDir, 'components/GrokConfigEditor.vue'),
      'utf8'
    )
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([
      'provider',
      'appearance',
      'memory',
      'grok-config',
      'browser',
      'hooks'
    ])
    expect(SETTINGS_SECTIONS.map((section) => section.label)).toEqual([
      '供应商',
      '外观',
      '记忆',
      'Grok 配置',
      '浏览器',
      'Hooks'
    ])
    expect(settingsSource).toContain("section === 'browser'")
    expect(settingsSource).toContain('HostBrowserSettingsPanel')
    expect(settingsSource).toContain('PhGlobe')
    expect(settingsSource).toContain("section === 'hooks'")
    expect(settingsSource).toContain('GrokHooksPanel')
    expect(grokConfigSource).not.toContain('host-browser-enabled')
    expect(grokConfigSource).not.toContain('HOST_BROWSER_SETTING_TITLE')
  })

  it('浏览器页源码包含说明书分组标题、尚未接入和扩展占位', () => {
    const panelSource = readFileSync(
      join(rendererDir, 'components/HostBrowserSettingsPanel.vue'),
      'utf8'
    )
    expect(panelSource).toContain('HOST_BROWSER_SETTING_PAGE_SUBTITLE')
    expect(panelSource).toContain('HOST_BROWSER_GROUP_GENERAL_TITLE')
    expect(panelSource).toContain('HOST_BROWSER_GROUP_PASSWORDS_TITLE')
    expect(panelSource).toContain('HOST_BROWSER_GROUP_DOWNLOADS_TITLE')
    expect(panelSource).toContain('HOST_BROWSER_GROUP_AGENT_PERMISSIONS_TITLE')
    expect(panelSource).toContain('HOST_BROWSER_GROUP_EXTENSION_TITLE')
    expect(panelSource).toContain('HOST_BROWSER_GROUP_FULL_CDP_TITLE')
    expect(panelSource).toContain('HOST_BROWSER_GROUP_CAUTIOUS_TITLE')
    expect(panelSource).toContain('HOST_BROWSER_PASSWORDS_BODY')
    expect(panelSource).toContain('HOST_BROWSER_EXTENSION_MISSING')
    expect(panelSource).toContain('HOST_BROWSER_SETTING_BUSY_TITLE')
    expect(panelSource).not.toContain('ChatGPT')
  })

  it('供应商页说明生图走同一 Base URL', () => {
    expect(onboardingSource).toContain('/v1/images/generations')
    expect(onboardingSource).toContain('生图走同一 Base URL')
  })
})
