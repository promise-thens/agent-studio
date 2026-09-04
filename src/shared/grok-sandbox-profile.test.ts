import { describe, expect, it } from 'vitest'
import { GROK_SANDBOX_PROFILES, isGrokSandboxProfile } from './grok-sandbox-profile'

describe('GROK_SANDBOX_PROFILES', () => {
  it('首期只冻结 off / workspace / read-only / strict 四档', () => {
    expect([...GROK_SANDBOX_PROFILES]).toEqual(['off', 'workspace', 'read-only', 'strict'])
  })
})

describe('isGrokSandboxProfile', () => {
  it('四档精确匹配为 true', () => {
    expect(isGrokSandboxProfile('off')).toBe(true)
    expect(isGrokSandboxProfile('workspace')).toBe(true)
    expect(isGrokSandboxProfile('read-only')).toBe(true)
    expect(isGrokSandboxProfile('strict')).toBe(true)
  })

  it('devbox、未知名、空串、前导空白、无连字符变体都是 false', () => {
    expect(isGrokSandboxProfile('devbox')).toBe(false)
    expect(isGrokSandboxProfile('not-a-profile')).toBe(false)
    expect(isGrokSandboxProfile('')).toBe(false)
    expect(isGrokSandboxProfile(' workspace')).toBe(false)
    expect(isGrokSandboxProfile('readonly')).toBe(false)
  })

  it('大小写、下划线、斜杠前缀、旗标字面量和空白都不是合法档', () => {
    expect(isGrokSandboxProfile('read_only')).toBe(false)
    expect(isGrokSandboxProfile('Read-Only')).toBe(false)
    expect(isGrokSandboxProfile('/workspace')).toBe(false)
    expect(isGrokSandboxProfile('--sandbox')).toBe(false)
    expect(isGrokSandboxProfile('strict ')).toBe(false)
    expect(isGrokSandboxProfile('   ')).toBe(false)
  })

  it('非字符串一律 false，且不抛错', () => {
    expect(isGrokSandboxProfile(undefined)).toBe(false)
    expect(isGrokSandboxProfile(null)).toBe(false)
    expect(isGrokSandboxProfile(0)).toBe(false)
    expect(isGrokSandboxProfile(1)).toBe(false)
    expect(isGrokSandboxProfile({})).toBe(false)
    expect(isGrokSandboxProfile(['workspace'])).toBe(false)
    expect(() => isGrokSandboxProfile({ profile: 'workspace' })).not.toThrow()
  })
})
