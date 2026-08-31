import { describe, expect, it } from 'vitest'
import {
  GROK_TAKEOVER_CONTROL_PROMPT,
  GROK_TAKEOVER_SLASH_COMMAND,
  isPublicTakeoverControlPrompt,
  isTakeoverCommandAdvertised,
  permissionSnapshotFromMode,
  PUBLIC_TAKEOVER_CONTROL_PROMPT_BLOCKED_MESSAGE,
  readPermissionPromptStyle,
  readTakeoverSnapshot,
  resolveTakeoverApply,
  resolveTakeoverHudCopy,
  shouldResubmitPermissionMode,
  taskPermissionModeFromSnapshot,
  type TakeoverApplyInput
} from './task-takeover'

/** 构造可覆写字段的默认输入，避免每个用例重复样板。 */
function baseInput(overrides: Partial<TakeoverApplyInput> = {}): TakeoverApplyInput {
  return {
    hasSession: true,
    idle: true,
    advertisedCommands: [{ name: GROK_TAKEOVER_SLASH_COMMAND }],
    desiredEnabled: true,
    currentlyApplied: false,
    ...overrides
  }
}

describe('isTakeoverCommandAdvertised', () => {
  it('仅当 name 精确等于 always-approve 时为真', () => {
    expect(isTakeoverCommandAdvertised([{ name: 'always-approve' }])).toBe(true)
    expect(isTakeoverCommandAdvertised([{ name: 'always-approve-now' }])).toBe(false)
    expect(isTakeoverCommandAdvertised([{ name: 'help' }])).toBe(false)
    expect(isTakeoverCommandAdvertised([])).toBe(false)
  })
})

describe('resolveTakeoverApply', () => {
  it('desired 与 currentlyApplied 相同时 noop', () => {
    expect(
      resolveTakeoverApply(baseInput({ desiredEnabled: true, currentlyApplied: true }))
    ).toEqual({ kind: 'noop' })
    expect(
      resolveTakeoverApply(baseInput({ desiredEnabled: false, currentlyApplied: false }))
    ).toEqual({ kind: 'noop' })
  })

  it('打开且尚无 session → new-session-meta（无视 idle / 广告）', () => {
    expect(
      resolveTakeoverApply(
        baseInput({
          hasSession: false,
          idle: false,
          advertisedCommands: [],
          desiredEnabled: true,
          currentlyApplied: false
        })
      )
    ).toEqual({ kind: 'new-session-meta' })
  })

  it('关闭且尚无 session → noop', () => {
    expect(
      resolveTakeoverApply(
        baseInput({
          hasSession: false,
          desiredEnabled: false,
          currentlyApplied: true
        })
      )
    ).toEqual({ kind: 'noop' })
  })

  it('有 session 且忙碌 → defer busy（开和关都是）', () => {
    expect(
      resolveTakeoverApply(
        baseInput({
          hasSession: true,
          idle: false,
          desiredEnabled: true,
          currentlyApplied: false
        })
      )
    ).toEqual({ kind: 'defer-next-session', reason: 'busy' })

    expect(
      resolveTakeoverApply(
        baseInput({
          hasSession: true,
          idle: false,
          desiredEnabled: false,
          currentlyApplied: true
        })
      )
    ).toEqual({ kind: 'defer-next-session', reason: 'busy' })
  })

  it('有 session 且空闲且广告含 always-approve → send-command', () => {
    expect(
      resolveTakeoverApply(
        baseInput({
          hasSession: true,
          idle: true,
          advertisedCommands: [{ name: 'always-approve' }],
          desiredEnabled: true,
          currentlyApplied: false
        })
      )
    ).toEqual({
      kind: 'send-command',
      commandName: 'always-approve'
    })
  })

  it('有 session 且空闲但无 always-approve 广告 → defer command-unavailable', () => {
    expect(
      resolveTakeoverApply(
        baseInput({
          hasSession: true,
          idle: true,
          advertisedCommands: [{ name: 'help' }],
          desiredEnabled: true,
          currentlyApplied: false
        })
      )
    ).toEqual({ kind: 'defer-next-session', reason: 'command-unavailable' })
  })

  it('广告匹配必须精确 name，always-approve-now 不算', () => {
    expect(
      resolveTakeoverApply(
        baseInput({
          hasSession: true,
          idle: true,
          advertisedCommands: [{ name: 'always-approve-now' }],
          desiredEnabled: true,
          currentlyApplied: false
        })
      )
    ).toEqual({ kind: 'defer-next-session', reason: 'command-unavailable' })
  })
})

describe('readTakeoverSnapshot', () => {
  it('仅当 takeoverEnabled === true 才为 true，缺字段与非法类型 fail-closed 为 false', () => {
    expect(readTakeoverSnapshot(undefined).takeoverEnabled).toBe(false)
    expect(readTakeoverSnapshot(null).takeoverEnabled).toBe(false)
    expect(readTakeoverSnapshot({}).takeoverEnabled).toBe(false)
    expect(readTakeoverSnapshot({ takeoverEnabled: false }).takeoverEnabled).toBe(false)
    expect(readTakeoverSnapshot({ takeoverEnabled: true }).takeoverEnabled).toBe(true)
    expect(readTakeoverSnapshot({ takeoverEnabled: 'true' }).takeoverEnabled).toBe(false)
    expect(readTakeoverSnapshot({ takeoverEnabled: 1 }).takeoverEnabled).toBe(false)
  })

  it('takeoverUpdatedAt 仅保留非空 ISO-8601 字符串', () => {
    expect(
      readTakeoverSnapshot({
        takeoverEnabled: true,
        takeoverUpdatedAt: '2026-08-31T00:00:00.000Z'
      })
    ).toEqual({
      takeoverEnabled: true,
      takeoverUpdatedAt: '2026-08-31T00:00:00.000Z'
    })
    expect(readTakeoverSnapshot({ takeoverUpdatedAt: '' })).toEqual({ takeoverEnabled: false })
    expect(readTakeoverSnapshot({ takeoverUpdatedAt: 'not-a-date' })).toEqual({
      takeoverEnabled: false
    })
    expect(readTakeoverSnapshot({ takeoverUpdatedAt: 1 })).toEqual({ takeoverEnabled: false })
  })
})

describe('permissionPromptStyle 与三档映射', () => {
  it('缺字段与非法值默认 assist，仅字面量 ask 才是 ask', () => {
    expect(readPermissionPromptStyle(undefined)).toBe('assist')
    expect(readPermissionPromptStyle(null)).toBe('assist')
    expect(readPermissionPromptStyle({})).toBe('assist')
    expect(readPermissionPromptStyle({ permissionPromptStyle: 'assist' })).toBe('assist')
    expect(readPermissionPromptStyle({ permissionPromptStyle: 'ask' })).toBe('ask')
    expect(readPermissionPromptStyle({ permissionPromptStyle: 'takeover' })).toBe('assist')
    expect(readPermissionPromptStyle({ permissionPromptStyle: true })).toBe('assist')
  })

  it('takeoverEnabled 为真即 takeover，否则回落 style；缺字段 fail-closed 为 assist', () => {
    expect(
      taskPermissionModeFromSnapshot({ takeoverEnabled: true, permissionPromptStyle: 'ask' })
    ).toBe('takeover')
    expect(
      taskPermissionModeFromSnapshot({ takeoverEnabled: false, permissionPromptStyle: 'ask' })
    ).toBe('ask')
    expect(
      taskPermissionModeFromSnapshot({ takeoverEnabled: false, permissionPromptStyle: 'assist' })
    ).toBe('assist')
    expect(
      taskPermissionModeFromSnapshot({
        takeoverEnabled: false,
        permissionPromptStyle: readPermissionPromptStyle({})
      })
    ).toBe('assist')
  })

  it('进入接管保留上次 ask/assist，关掉才写回询问风格', () => {
    expect(permissionSnapshotFromMode('takeover', 'ask')).toEqual({
      takeoverEnabled: true,
      permissionPromptStyle: 'ask'
    })
    expect(permissionSnapshotFromMode('assist', 'ask')).toEqual({
      takeoverEnabled: false,
      permissionPromptStyle: 'assist'
    })
    expect(permissionSnapshotFromMode('ask')).toEqual({
      takeoverEnabled: false,
      permissionPromptStyle: 'ask'
    })
    expect(GROK_TAKEOVER_CONTROL_PROMPT).toBe('/always-approve')
    expect(isPublicTakeoverControlPrompt('/always-approve')).toBe(true)
    expect(isPublicTakeoverControlPrompt('/always-approve ')).toBe(false)
    expect(isPublicTakeoverControlPrompt('/always-approve leftover')).toBe(false)
    expect(PUBLIC_TAKEOVER_CONTROL_PROMPT_BLOCKED_MESSAGE).toContain('批准模式菜单')
  })

  it('HUD：执行中才写正在接管；未生效与可能仍在始终可见', () => {
    expect(
      resolveTakeoverHudCopy({
        takeoverEnabled: true,
        takeoverApplied: true,
        executing: true
      })
    ).toBe('Grok 正在完全接管')
    expect(
      resolveTakeoverHudCopy({
        takeoverEnabled: true,
        takeoverApplied: true,
        executing: false
      })
    ).toBeNull()
    expect(
      resolveTakeoverHudCopy({
        takeoverEnabled: true,
        takeoverApplied: false,
        executing: false
      })
    ).toBe('接管未完全生效')
    expect(
      resolveTakeoverHudCopy({
        takeoverEnabled: false,
        takeoverApplied: false,
        takeoverMayStillBeActive: true
      })
    ).toBe('接管可能仍在')
  })
})

describe('shouldResubmitPermissionMode', () => {
  it('lingering 时允许重选当前 ask/assist；已 applied 的接管不再提交', () => {
    expect(
      shouldResubmitPermissionMode({
        current: 'assist',
        next: 'assist',
        takeoverApplied: false,
        takeoverMayStillBeActive: true
      })
    ).toBe(true)
    expect(
      shouldResubmitPermissionMode({
        current: 'ask',
        next: 'ask',
        takeoverApplied: false,
        takeoverMayStillBeActive: true
      })
    ).toBe(true)
    expect(
      shouldResubmitPermissionMode({
        current: 'assist',
        next: 'assist',
        takeoverApplied: false
      })
    ).toBe(false)
    expect(
      shouldResubmitPermissionMode({
        current: 'takeover',
        next: 'takeover',
        takeoverApplied: true
      })
    ).toBe(false)
    expect(
      shouldResubmitPermissionMode({
        current: 'takeover',
        next: 'takeover',
        takeoverApplied: false
      })
    ).toBe(true)
    expect(
      shouldResubmitPermissionMode({
        current: 'assist',
        next: 'takeover',
        takeoverApplied: false
      })
    ).toBe(true)
  })
})
