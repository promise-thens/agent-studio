import { describe, expect, it } from 'vitest'
import { GROK_SANDBOX_PROFILES } from '../../shared/grok-sandbox-profile'
import {
  GROK_SANDBOX_BUSY_TITLE,
  GROK_SANDBOX_DIRTY_TITLE,
  GROK_SANDBOX_INTRO,
  GROK_SANDBOX_OPTIONS,
  GROK_SANDBOX_SAVING_TITLE,
  GROK_SANDBOX_TITLE,
  resolveConfirmedSandboxProfile,
  resolveSandboxPickerTitle,
  resolveSandboxSelectValue
} from './grok-sandbox-settings'

describe('Grok 沙箱设置文案', () => {
  it('标题是 Grok 沙箱，并写清不是 Electron sandbox、也不是 Broker 替代', () => {
    expect(GROK_SANDBOX_TITLE).toBe('Grok 沙箱')
    expect(GROK_SANDBOX_INTRO).toContain('Grok 进程的内核限制')
    expect(GROK_SANDBOX_INTRO).toContain('webPreferences.sandbox')
    expect(GROK_SANDBOX_INTRO).toContain('不是 Permission Broker 的替代')
    expect(GROK_SANDBOX_INTRO).toContain('Permission Broker 仍然审批')
    expect(GROK_SANDBOX_INTRO).toContain('改档会重启 Runtime')
    expect(GROK_SANDBOX_INTRO).toContain('恢复可能失败')
    expect(GROK_SANDBOX_INTRO).not.toContain('撤销')
    expect(GROK_SANDBOX_INTRO).toContain('按 Grok 档位')
    expect(GROK_SANDBOX_INTRO).toContain('~/.grok/memory')
    expect(GROK_SANDBOX_INTRO).toContain('不承诺挡住记忆')
    expect(GROK_SANDBOX_INTRO).not.toMatch(/会挡住|保证挡住|能够挡住/)
  })

  it('四档选择器覆盖枚举，且每档注明 Broker 与按 Grok 档位', () => {
    expect(GROK_SANDBOX_OPTIONS.map((option) => option.profile)).toEqual([
      'workspace',
      'read-only',
      'strict',
      'off'
    ])
    expect(GROK_SANDBOX_OPTIONS.map((option) => option.profile).sort()).toEqual(
      [...GROK_SANDBOX_PROFILES].sort()
    )
    const byProfile = Object.fromEntries(
      GROK_SANDBOX_OPTIONS.map((option) => [option.profile, option])
    )
    expect(byProfile.workspace.label).toBe('日常')
    expect(byProfile.workspace.description).toContain('可读各处')
    expect(byProfile.workspace.description).toContain('可写 CWD')
    expect(byProfile.workspace.description).toContain('按 Grok 档位')
    expect(byProfile['read-only'].label).toBe('以读为主')
    expect(byProfile['read-only'].description).toContain('项目文件不可写')
    expect(byProfile['read-only'].description).toContain('按 Grok 档位')
    expect(byProfile.strict.label).toBe('更窄读')
    expect(byProfile.strict.description).toContain('CWD')
    expect(byProfile.strict.description).toContain('按 Grok 档位')
    expect(byProfile.off.label).toBe('关闭')
    expect(byProfile.off.description).toContain('无 Grok 内核限制')
    for (const option of GROK_SANDBOX_OPTIONS) {
      expect(option.description).toContain('Broker 仍然审批')
    }
    expect(GROK_SANDBOX_BUSY_TITLE).toContain('任务执行中')
  })
})

describe('resolveSandboxPickerTitle', () => {
  it('toml 未保存时优先提示先保存，不得暗示可以改档', () => {
    expect(resolveSandboxPickerTitle({ dirty: true, runtimeBusy: false, saving: false })).toBe(
      GROK_SANDBOX_DIRTY_TITLE
    )
    expect(resolveSandboxPickerTitle({ dirty: true, runtimeBusy: true, saving: true })).toBe(
      GROK_SANDBOX_DIRTY_TITLE
    )
    expect(GROK_SANDBOX_DIRTY_TITLE).toContain('保存')
    expect(GROK_SANDBOX_DIRTY_TITLE).toContain('放弃')
  })

  it('空闲时用沙箱标题，执行中和保存中用对应原因', () => {
    expect(resolveSandboxPickerTitle({ dirty: false, runtimeBusy: false, saving: false })).toBe(
      GROK_SANDBOX_TITLE
    )
    expect(resolveSandboxPickerTitle({ dirty: false, runtimeBusy: true, saving: false })).toBe(
      GROK_SANDBOX_BUSY_TITLE
    )
    expect(resolveSandboxPickerTitle({ dirty: false, runtimeBusy: false, saving: true })).toBe(
      GROK_SANDBOX_SAVING_TITLE
    )
  })
})

describe('resolveConfirmedSandboxProfile', () => {
  it('未 applied 不得把 pending 档当成已应用', () => {
    expect(resolveConfirmedSandboxProfile('off', { profile: 'workspace', applied: false })).toBe(
      'off'
    )
    expect(resolveConfirmedSandboxProfile('workspace', { profile: 'strict', applied: false })).toBe(
      'workspace'
    )
    expect(resolveConfirmedSandboxProfile('strict', { profile: 'off', applied: undefined })).toBe(
      'strict'
    )
    expect(resolveConfirmedSandboxProfile('read-only', null)).toBe('read-only')
    expect(
      resolveConfirmedSandboxProfile(null, { profile: 'workspace', applied: false })
    ).toBeNull()
  })

  it('只有 applied: true 且档位合法才接受新档', () => {
    expect(resolveConfirmedSandboxProfile('off', { profile: 'workspace', applied: true })).toBe(
      'workspace'
    )
    expect(resolveConfirmedSandboxProfile('off', { profile: 'devbox', applied: true })).toBe('off')
    expect(resolveConfirmedSandboxProfile(null, { profile: 'strict', applied: true })).toBe(
      'strict'
    )
    expect(resolveConfirmedSandboxProfile('workspace', { profile: 'off', applied: true })).toBe(
      'off'
    )
  })
})

describe('resolveSandboxSelectValue', () => {
  it('非法字符串不得进入选择器 value', () => {
    expect(resolveSandboxSelectValue('devbox')).toBeNull()
    expect(resolveSandboxSelectValue('read_only')).toBeNull()
    expect(resolveSandboxSelectValue('READONLY')).toBeNull()
    expect(resolveSandboxSelectValue(' workspace ')).toBeNull()
    expect(resolveSandboxSelectValue('workspace')).toBe('workspace')
    expect(resolveSandboxSelectValue('read-only')).toBe('read-only')
    expect(resolveSandboxSelectValue('strict')).toBe('strict')
    expect(resolveSandboxSelectValue('off')).toBe('off')
  })
})
