import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HOST_BROWSER_SETTINGS } from '../../shared/host-browser'
import {
  HOST_BROWSER_AGENT_PERMISSION_COLUMNS,
  HOST_BROWSER_AGENT_PERMISSION_OPTIONS,
  HOST_BROWSER_CLEAR_DATA_KINDS,
  HOST_BROWSER_CLEAR_DATA_LABEL,
  HOST_BROWSER_EXTENSION_MISSING,
  HOST_BROWSER_FULL_CDP_HINT,
  HOST_BROWSER_GROUP_AGENT_PERMISSIONS_TITLE,
  HOST_BROWSER_GROUP_CAUTIOUS_TITLE,
  HOST_BROWSER_GROUP_DOWNLOADS_TITLE,
  HOST_BROWSER_GROUP_EXTENSION_TITLE,
  HOST_BROWSER_GROUP_FULL_CDP_TITLE,
  HOST_BROWSER_GROUP_GENERAL_TITLE,
  HOST_BROWSER_GROUP_PASSWORDS_TITLE,
  HOST_BROWSER_LINK_OPEN_OPTIONS,
  HOST_BROWSER_PASSWORDS_BODY,
  HOST_BROWSER_SCREENSHOT_ANNOTATION_OPTIONS,
  HOST_BROWSER_SCREENSHOT_TOKEN_HINT,
  HOST_BROWSER_SETTING_BUSY_TITLE,
  HOST_BROWSER_SETTING_HINT,
  HOST_BROWSER_SETTING_PAGE_SUBTITLE,
  HOST_BROWSER_SETTING_PAGE_TITLE,
  HOST_BROWSER_SETTING_TITLE,
  formatHostBrowserSyncBlacklist,
  parseHostBrowserSyncBlacklistDraft,
  resolveHostBrowserMasterSwitchDisabled,
  resolveHostBrowserPreferenceDisabled,
  resolveHostBrowserSettingTitle,
  revertHostBrowserCheckbox,
  revertHostBrowserSelect,
  takeHostBrowserCheckboxIntent,
  takeHostBrowserSelectIntent
} from './host-browser-settings'

const rendererDir = dirname(fileURLToPath(import.meta.url))
const panelSource = readFileSync(
  join(rendererDir, 'components/HostBrowserSettingsPanel.vue'),
  'utf8'
)

describe('内置浏览器设置文案', () => {
  it('页标题与副标题对标 Browser Use 偏好页，不写 ChatGPT', () => {
    expect(HOST_BROWSER_SETTING_PAGE_TITLE).toBe('浏览器')
    expect(HOST_BROWSER_SETTING_PAGE_SUBTITLE).toBe('管理 Browser Use 偏好设置和网站访问权限')
    expect(HOST_BROWSER_SETTING_PAGE_SUBTITLE).not.toContain('ChatGPT')
    expect(HOST_BROWSER_SETTING_TITLE).not.toContain('ChatGPT')
  })

  it('总开关文案写明下一 session 生效，不假装当前 Turn 已切换', () => {
    expect(HOST_BROWSER_SETTING_TITLE).toBe('让 Grok 控制内置浏览器')
    expect(HOST_BROWSER_SETTING_HINT).toContain('下一 session')
    expect(HOST_BROWSER_SETTING_HINT).not.toContain('已应用到当前')
    expect(resolveHostBrowserSettingTitle({ runtimeBusy: true })).toBe(
      HOST_BROWSER_SETTING_BUSY_TITLE
    )
    expect(resolveHostBrowserSettingTitle({ runtimeBusy: false })).toBe(HOST_BROWSER_SETTING_TITLE)
  })

  it('分组标题覆盖说明书 §1.7，密码尚未接入，扩展未检测', () => {
    expect(HOST_BROWSER_GROUP_GENERAL_TITLE).toBe('常规')
    expect(HOST_BROWSER_GROUP_PASSWORDS_TITLE).toBe('自动填充和密码')
    expect(HOST_BROWSER_GROUP_DOWNLOADS_TITLE).toBe('下载')
    expect(HOST_BROWSER_GROUP_AGENT_PERMISSIONS_TITLE).toBe('智能体权限')
    expect(HOST_BROWSER_GROUP_EXTENSION_TITLE).toBe('配套扩展')
    expect(HOST_BROWSER_GROUP_FULL_CDP_TITLE).toBe('完整 CDP')
    expect(HOST_BROWSER_GROUP_CAUTIOUS_TITLE).toBe('谨慎模式')
    expect(HOST_BROWSER_PASSWORDS_BODY).toBe(
      '内置密码库尚未接入。Chrome 若未开放密码 API，不会假装已同步密码。'
    )
    expect(HOST_BROWSER_PASSWORDS_BODY).toContain('尚未接入')
    expect(HOST_BROWSER_EXTENSION_MISSING).toBe('未检测到配套扩展')
    expect(HOST_BROWSER_CLEAR_DATA_LABEL).toBe('清除浏览数据')
    expect(HOST_BROWSER_CLEAR_DATA_KINDS).toEqual(['cookies', 'cache', 'history', 'downloads'])
    expect(HOST_BROWSER_FULL_CDP_HINT).toContain('可检查并控制敏感浏览器内部功能')
    expect(HOST_BROWSER_SCREENSHOT_TOKEN_HINT).toContain('token')
  })

  it('选择器出厂值与共享默认一致：始终允许、批注始终包含、下载前询问关', () => {
    expect(HOST_BROWSER_LINK_OPEN_OPTIONS.map((option) => option.value)).toEqual([
      'studio',
      'system'
    ])
    expect(HOST_BROWSER_LINK_OPEN_OPTIONS.map((option) => option.label)).toEqual([
      'Agent Studio',
      '系统浏览器'
    ])
    expect(HOST_BROWSER_SCREENSHOT_ANNOTATION_OPTIONS.map((option) => option.value)).toEqual([
      'always',
      'ask',
      'never'
    ])
    expect(HOST_BROWSER_SCREENSHOT_ANNOTATION_OPTIONS[0]?.label).toBe('始终包含')
    expect(HOST_BROWSER_AGENT_PERMISSION_COLUMNS.map((column) => column.key)).toEqual([
      'browse',
      'download',
      'upload',
      'debug'
    ])
    expect(HOST_BROWSER_AGENT_PERMISSION_OPTIONS.map((option) => option.value)).toEqual([
      'always',
      'ask'
    ])
    expect(HOST_BROWSER_AGENT_PERMISSION_OPTIONS[0]?.label).toBe('始终允许')
    expect(DEFAULT_HOST_BROWSER_SETTINGS.screenshotAnnotation).toBe('always')
    expect(DEFAULT_HOST_BROWSER_SETTINGS.downloadAskBefore).toBe(false)
    expect(DEFAULT_HOST_BROWSER_SETTINGS.agentPermissions).toEqual({
      browse: 'always',
      download: 'always',
      upload: 'always',
      debug: 'always'
    })
    expect(DEFAULT_HOST_BROWSER_SETTINGS.fullCdp).toBe(true)
    expect(DEFAULT_HOST_BROWSER_SETTINGS.cautiousMode).toBe(false)
    expect(DEFAULT_HOST_BROWSER_SETTINGS.cookieSyncEnabled).toBe(true)
    expect(DEFAULT_HOST_BROWSER_SETTINGS.chromeConnectEnabled).toBe(true)
  })
})

describe('总开关与其它偏好的禁用边界', () => {
  it('只有总开关在 runtimeBusy 时禁用，其它分组仍可编辑', () => {
    expect(
      resolveHostBrowserMasterSwitchDisabled({
        runtimeBusy: true,
        saving: false,
        loadState: 'ready'
      })
    ).toBe(true)
    expect(
      resolveHostBrowserMasterSwitchDisabled({
        runtimeBusy: false,
        saving: false,
        loadState: 'ready'
      })
    ).toBe(false)
    expect(
      resolveHostBrowserPreferenceDisabled({
        saving: false,
        loadState: 'ready'
      })
    ).toBe(false)
    expect(
      resolveHostBrowserPreferenceDisabled({
        saving: true,
        loadState: 'ready'
      })
    ).toBe(true)
    expect(
      resolveHostBrowserPreferenceDisabled({
        saving: false,
        loadState: 'loading'
      })
    ).toBe(true)
  })
})

describe('配套扩展黑名单草稿', () => {
  it('空行忽略，origin 规范化，非法或超长整包失败', () => {
    expect(parseHostBrowserSyncBlacklistDraft('')).toEqual([])
    expect(
      parseHostBrowserSyncBlacklistDraft('https://a.example/\n\nhttps://b.example/path')
    ).toEqual(['https://a.example', 'https://b.example'])
    expect(parseHostBrowserSyncBlacklistDraft('javascript:alert(1)')).toBeNull()
    expect(parseHostBrowserSyncBlacklistDraft('https://user:pass@a.example')).toBeNull()
    expect(formatHostBrowserSyncBlacklist(['https://a.example', 'https://b.example'])).toBe(
      'https://a.example\nhttps://b.example'
    )
  })
})

describe('浏览器设置面板源码契约', () => {
  it('按说明书分组，总开关走独立 IPC，其它走补丁，清除四类数据', () => {
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
    expect(panelSource).toContain('resolveHostBrowserMasterSwitchDisabled')
    expect(panelSource).toContain('resolveHostBrowserPreferenceDisabled')
    expect(panelSource).toContain('window.app.setHostBrowserEnabled')
    expect(panelSource).toContain('window.app.setHostBrowserSettings')
    expect(panelSource).toContain('window.app.clearHostBrowserData')
    expect(panelSource).toContain('HOST_BROWSER_CLEAR_DATA_KINDS')
    expect(panelSource).not.toContain('注入宿主浏览器 MCP')
    expect(panelSource).not.toContain('installHostBrowserExtension')
    expect(panelSource).not.toContain('v-model="enabled"')
    expect(panelSource).not.toContain('v-model="settings')
  })

  it('原生 checkbox/select 读出意图后立刻回写确认值，失败再打回一次', () => {
    expect(panelSource).toContain('takeHostBrowserCheckboxIntent')
    expect(panelSource).toContain('takeHostBrowserSelectIntent')
    expect(panelSource).toContain('revertHostBrowserCheckbox')
    expect(panelSource).toContain('revertHostBrowserSelect')
    expect(panelSource).toMatch(
      /takeHostBrowserCheckboxIntent\(\s*target,\s*settings\.value\.enabled\s*\)[\s\S]*setHostBrowserEnabled[\s\S]*revertHostBrowserCheckbox\(\s*target,\s*settings\.value\.enabled\s*\)/
    )
    expect(panelSource).toMatch(
      /takeHostBrowserCheckboxIntent\(\s*target,\s*settings\.value\[key\]\s*\)[\s\S]*savePatch[\s\S]*revertHostBrowserCheckbox\(\s*target,\s*settings\.value\[key\]\s*\)/
    )
    expect(panelSource).toMatch(
      /takeHostBrowserSelectIntent\(\s*target,\s*settings\.value\.linkOpenTarget\s*\)[\s\S]*savePatch[\s\S]*revertHostBrowserSelect\(\s*target,\s*settings\.value\.linkOpenTarget\s*\)/
    )
    expect(panelSource).toMatch(
      /takeHostBrowserSelectIntent\(\s*target,\s*settings\.value\.screenshotAnnotation\s*\)[\s\S]*savePatch[\s\S]*revertHostBrowserSelect\(\s*target,\s*settings\.value\.screenshotAnnotation\s*\)/
    )
    expect(panelSource).toMatch(
      /takeHostBrowserSelectIntent\(\s*target,\s*settings\.value\.agentPermissions\[key\]\s*\)[\s\S]*savePatch[\s\S]*revertHostBrowserSelect\(\s*target,\s*settings\.value\.agentPermissions\[key\]\s*\)/
    )
  })
})

describe('原生控件回写', () => {
  it('读出意图后立刻把 checkbox/select 打回确认值，失败路径可再打回一次', () => {
    const checkbox = { checked: true }
    expect(takeHostBrowserCheckboxIntent(checkbox, false)).toBe(true)
    expect(checkbox.checked).toBe(false)
    revertHostBrowserCheckbox(checkbox, true)
    expect(checkbox.checked).toBe(true)

    const select = { value: 'system' }
    expect(takeHostBrowserSelectIntent(select, 'studio')).toBe('system')
    expect(select.value).toBe('studio')
    revertHostBrowserSelect(select, 'system')
    expect(select.value).toBe('system')
  })
})
