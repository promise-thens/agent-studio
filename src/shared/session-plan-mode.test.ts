import { describe, expect, it } from 'vitest'
import {
  GROK_PLAN_SLASH_COMMAND,
  isPlanCommandAdvertised,
  resolvePlanSubmit
} from './session-plan-mode'

describe('isPlanCommandAdvertised', () => {
  it('仅当 name 精确等于 plan 时为真', () => {
    expect(isPlanCommandAdvertised([{ name: 'plan' }])).toBe(true)
    expect(isPlanCommandAdvertised([{ name: 'plan-mode' }])).toBe(false)
    expect(isPlanCommandAdvertised([{ name: 'view-plan' }])).toBe(false)
    expect(isPlanCommandAdvertised([{ name: '/plan' }])).toBe(false)
    expect(isPlanCommandAdvertised([{ name: 'help' }])).toBe(false)
    expect(isPlanCommandAdvertised([])).toBe(false)
  })
})

describe('resolvePlanSubmit', () => {
  it('mode=normal 时 prompt 原样，即使已广告 plan', () => {
    expect(
      resolvePlanSubmit({
        mode: 'normal',
        prompt: '加登录',
        hasPlanCommand: true,
        idle: true
      })
    ).toEqual({ prompt: '加登录' })
  })

  it('mode=plan 且普通正文且有 plan 命令且 idle 时一步改写为 /plan + 正文', () => {
    expect(
      resolvePlanSubmit({
        mode: 'plan',
        prompt: '加登录',
        hasPlanCommand: true,
        idle: true
      })
    ).toEqual({ prompt: '/plan 加登录' })
    expect(
      resolvePlanSubmit({
        mode: 'plan',
        prompt: '加登录',
        hasPlanCommand: true,
        idle: true
      }).prompt.startsWith('//')
    ).toBe(false)
  })

  it('mode=plan 且已是 Runtime 斜杠命令时不二次包装', () => {
    expect(
      resolvePlanSubmit({
        mode: 'plan',
        prompt: '/compact',
        hasPlanCommand: true,
        idle: true
      })
    ).toEqual({ prompt: '/compact' })
    expect(
      resolvePlanSubmit({
        mode: 'plan',
        prompt: '/compact keep auth',
        hasPlanCommand: true,
        idle: true
      })
    ).toEqual({ prompt: '/compact keep auth' })
    expect(
      resolvePlanSubmit({
        mode: 'plan',
        prompt: '/plan 加登录',
        hasPlanCommand: true,
        idle: true
      })
    ).toEqual({ prompt: '/plan 加登录' })
    expect(
      resolvePlanSubmit({
        mode: 'plan',
        prompt: '/view-plan',
        hasPlanCommand: true,
        idle: true
      })
    ).toEqual({ prompt: '/view-plan' })
  })

  it('无 plan 命令时永不改写 prompt，即使 mode=plan 且 idle', () => {
    expect(
      resolvePlanSubmit({
        mode: 'plan',
        prompt: '加登录',
        hasPlanCommand: false,
        idle: true
      })
    ).toEqual({ prompt: '加登录' })
    expect(
      resolvePlanSubmit({
        mode: 'plan',
        prompt: '/compact',
        hasPlanCommand: false,
        idle: true
      })
    ).toEqual({ prompt: '/compact' })
  })

  it('idle=false 执行中不改写 prompt', () => {
    expect(
      resolvePlanSubmit({
        mode: 'plan',
        prompt: '加登录',
        hasPlanCommand: true,
        idle: false
      })
    ).toEqual({ prompt: '加登录' })
  })

  it('导出的广告 name 是 plan，不含前导斜杠', () => {
    expect(GROK_PLAN_SLASH_COMMAND).toBe('plan')
  })
})
