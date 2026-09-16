import { describe, expect, it } from 'vitest'
import {
  HOST_BROWSER_SETTING_BUSY_TITLE,
  HOST_BROWSER_SETTING_HINT,
  HOST_BROWSER_SETTING_TITLE,
  resolveHostBrowserSettingTitle
} from './host-browser-settings'

describe('内置浏览器设置文案', () => {
  it('默认开的开关文案写明下一 session 生效，不假装当前 Turn 已切换', () => {
    expect(HOST_BROWSER_SETTING_TITLE).toBe('使用内置浏览器')
    expect(HOST_BROWSER_SETTING_HINT).toContain('下一 session')
    expect(HOST_BROWSER_SETTING_HINT).not.toContain('已应用到当前')
    expect(resolveHostBrowserSettingTitle({ runtimeBusy: true })).toBe(
      HOST_BROWSER_SETTING_BUSY_TITLE
    )
    expect(resolveHostBrowserSettingTitle({ runtimeBusy: false })).toBe(HOST_BROWSER_SETTING_TITLE)
  })
})
