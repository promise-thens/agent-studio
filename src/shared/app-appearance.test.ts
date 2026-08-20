import { describe, expect, it } from 'vitest'
import {
  APP_APPEARANCE_BACKGROUNDS,
  APP_APPEARANCE_MODES,
  DEFAULT_APP_APPEARANCE_MODE,
  appearanceWindowBackground,
  isAppAppearanceMode,
  parseAppAppearanceState,
  resolveAppearance
} from './app-appearance'

describe('应用外观契约', () => {
  it('跟随系统时按 OS 深浅解析，显式模式忽略 OS', () => {
    expect(resolveAppearance('system', true)).toBe('dark')
    expect(resolveAppearance('system', false)).toBe('light')
    expect(resolveAppearance('light', true)).toBe('light')
    expect(resolveAppearance('dark', false)).toBe('dark')
  })

  it('只接受三种 mode，默认深色，窗口背景跟解析结果走', () => {
    expect(APP_APPEARANCE_MODES).toEqual(['dark', 'light', 'system'])
    expect(DEFAULT_APP_APPEARANCE_MODE).toBe('dark')
    expect(isAppAppearanceMode('light')).toBe(true)
    expect(isAppAppearanceMode('dim')).toBe(false)
    expect(appearanceWindowBackground('dark')).toBe(APP_APPEARANCE_BACKGROUNDS.dark)
    expect(appearanceWindowBackground('light')).toBe(APP_APPEARANCE_BACKGROUNDS.light)
    expect(APP_APPEARANCE_BACKGROUNDS.dark).toBe('#0d1117')
    expect(APP_APPEARANCE_BACKGROUNDS.light).toBe('#f7f7f8')
  })

  it('外观状态解析拒绝多余字段和非法 resolved', () => {
    expect(parseAppAppearanceState({ mode: 'system', resolved: 'light' })).toEqual({
      mode: 'system',
      resolved: 'light'
    })
    expect(parseAppAppearanceState({ mode: 'dark', resolved: 'dark', extra: true })).toBeNull()
    expect(parseAppAppearanceState({ mode: 'system', resolved: 'system' })).toBeNull()
  })
})
