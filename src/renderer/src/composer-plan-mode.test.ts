import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GROK_PLAN_SLASH_COMMAND, resolvePlanSubmit } from '../../shared/session-plan-mode'
import { COMPOSER_COMPACT_ALWAYS_VISIBLE } from './task-composer-actions'
import { matchProductSlashSubmit, PRODUCT_SLASH_COMMANDS } from './slash-command-palette'
import {
  PLAN_NEXT_TURN_STATUS,
  PLAN_SWITCH_UNAVAILABLE_TITLE,
  resolveComposerPlanStatusCopy,
  resolveComposerPlanSwitch,
  resolveOpenPlanPermissionChange,
  resolvePlanModeAfterOpenPlanIpc,
  resolvePlanModeAfterTakeoverApplied
} from './composer-plan-mode'

const rendererDir = dirname(fileURLToPath(import.meta.url))
const composerSource = readFileSync(join(rendererDir, 'components/TaskComposer.vue'), 'utf8')
const appSource = readFileSync(join(rendererDir, 'App.vue'), 'utf8')
const mainCss = readFileSync(join(rendererDir, 'assets/main.css'), 'utf8')

const planAdvertised = [{ name: GROK_PLAN_SLASH_COMMAND }]
const noPlanAdvertised = [{ name: 'compact' }, { name: 'plan-mode' }, { name: 'view-plan' }]

function extractFunction(source: string, name: string): string {
  const marker = `async function ${name}`
  const start = source.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  const rest = source.slice(start + marker.length)
  const next = rest.search(/\n(?:async )?function /)
  return source.slice(start, next === -1 ? undefined : start + marker.length + next)
}

describe('Composer Plan 开关决策', () => {
  it('无 plan 命令时按钮 disabled，title 含「当前会话未提供 Plan」', () => {
    const idle = resolveComposerPlanSwitch({
      advertisedCommands: noPlanAdvertised,
      mode: 'normal',
      modelBusy: false,
      composerAction: 'send',
      hasActiveExecution: false
    })
    expect(idle.disabled).toBe(true)
    expect(idle.canToggle).toBe(false)
    expect(idle.title).toContain('当前会话未提供 Plan')
    expect(idle.title).toBe(PLAN_SWITCH_UNAVAILABLE_TITLE)
    expect(idle.pressed).toBe(false)

    const empty = resolveComposerPlanSwitch({
      advertisedCommands: [],
      mode: 'plan',
      modelBusy: false,
      composerAction: 'send',
      hasActiveExecution: false
    })
    expect(empty.disabled).toBe(true)
    expect(empty.canToggle).toBe(false)
    expect(empty.title).toContain('当前会话未提供 Plan')
  })

  it('有 name === plan 且空闲时可切', () => {
    const switchState = resolveComposerPlanSwitch({
      advertisedCommands: planAdvertised,
      mode: 'normal',
      modelBusy: false,
      composerAction: 'send',
      hasActiveExecution: false
    })
    expect(switchState.disabled).toBe(false)
    expect(switchState.canToggle).toBe(true)
    expect(switchState.pressed).toBe(false)
    expect(switchState.title).not.toContain('当前会话未提供 Plan')

    expect(
      resolveComposerPlanSwitch({
        advertisedCommands: [{ name: 'plan-mode' }],
        mode: 'normal',
        modelBusy: false,
        composerAction: 'send',
        hasActiveExecution: false
      }).canToggle
    ).toBe(false)
    expect(
      resolveComposerPlanSwitch({
        advertisedCommands: [{ name: '/plan' }],
        mode: 'normal',
        modelBusy: false,
        composerAction: 'send',
        hasActiveExecution: false
      }).canToggle
    ).toBe(false)
  })

  it('执行中（modelBusy / composer action=stop / 有活动执行）不可切', () => {
    const advertised = {
      advertisedCommands: planAdvertised,
      mode: 'normal' as const
    }
    const busy = resolveComposerPlanSwitch({
      ...advertised,
      modelBusy: true,
      composerAction: 'send',
      hasActiveExecution: false
    })
    const stopping = resolveComposerPlanSwitch({
      ...advertised,
      modelBusy: false,
      composerAction: 'stop',
      hasActiveExecution: false
    })
    const executing = resolveComposerPlanSwitch({
      ...advertised,
      modelBusy: false,
      composerAction: 'send',
      hasActiveExecution: true
    })

    expect(busy.canToggle).toBe(false)
    expect(busy.disabled).toBe(true)
    expect(stopping.canToggle).toBe(false)
    expect(stopping.disabled).toBe(true)
    expect(executing.canToggle).toBe(false)
    expect(executing.disabled).toBe(true)
  })

  it('plan 且空闲且已广告时状态条写「下一轮按 Plan 发送」', () => {
    expect(
      resolveComposerPlanStatusCopy({
        mode: 'plan',
        idle: true,
        hasPlanCommand: true
      })
    ).toBe(PLAN_NEXT_TURN_STATUS)
    expect(PLAN_NEXT_TURN_STATUS).toBe('下一轮按 Plan 发送')
    expect(
      resolveComposerPlanStatusCopy({
        mode: 'plan',
        idle: false,
        hasPlanCommand: true
      })
    ).toBeNull()
    expect(
      resolveComposerPlanStatusCopy({
        mode: 'normal',
        idle: true,
        hasPlanCommand: true
      })
    ).toBeNull()
    expect(
      resolveComposerPlanStatusCopy({
        mode: 'plan',
        idle: true,
        hasPlanCommand: false
      })
    ).toBeNull()
  })
})

describe('Plan 提交与产品斜杠边界', () => {
  it('切到 plan 后提交走 resolvePlanSubmit：startTurn 文本是函数返回值，不是用户原文', () => {
    const typed = '加登录'
    const submitted = resolvePlanSubmit({
      mode: 'plan',
      prompt: typed,
      hasPlanCommand: true,
      idle: true
    })
    expect(submitted.prompt).toBe('/plan 加登录')
    expect(submitted.prompt).not.toBe(typed)

    const sendPrompt = extractFunction(appSource, 'sendPrompt')
    expect(sendPrompt).toContain('resolvePlanSubmit')
    expect(sendPrompt).toContain('planSubmit.prompt')
    expect(sendPrompt).toContain('startTurn(taskId, planSubmit.prompt, attachmentIds)')
    expect(sendPrompt).toContain("appendMessage('user', displayText)")
    expect(sendPrompt).not.toContain('startTurn(taskId, text, attachmentIds)')
  })

  it('/plan 不是 productAction，不得被 matchProductSlashSubmit 拦下来', () => {
    expect(GROK_PLAN_SLASH_COMMAND).toBe('plan')
    expect(PRODUCT_SLASH_COMMANDS.some((item) => item.name === 'plan')).toBe(false)
    expect(PRODUCT_SLASH_COMMANDS.some((item) => item.productAction && item.name === 'plan')).toBe(
      false
    )
    expect(matchProductSlashSubmit('/plan')).toBeNull()
    expect(matchProductSlashSubmit('/plan 加登录')).toBeNull()
    expect(matchProductSlashSubmit('/always-approve')).toBe('open-permission-mode')
  })
})

describe('Plan 与接管互斥', () => {
  it('开 Plan 则先关掉接管；主进程失败时 Plan 保持关', () => {
    expect(
      resolveOpenPlanPermissionChange({
        permissionMode: 'takeover',
        previousStyle: 'ask'
      }).permissionModeToSet
    ).toBe('ask')
    expect(
      resolveOpenPlanPermissionChange({
        permissionMode: 'takeover',
        previousStyle: 'assist'
      }).permissionModeToSet
    ).toBe('assist')
    expect(
      resolveOpenPlanPermissionChange({
        permissionMode: 'assist'
      }).permissionModeToSet
    ).toBeNull()
    expect(
      resolveOpenPlanPermissionChange({
        permissionMode: 'ask'
      }).permissionModeToSet
    ).toBeNull()

    expect(
      resolvePlanModeAfterOpenPlanIpc({
        permissionChangeRequired: true,
        ipcSucceeded: false
      })
    ).toBe('normal')
    expect(
      resolvePlanModeAfterOpenPlanIpc({
        permissionChangeRequired: true,
        ipcSucceeded: true
      })
    ).toBe('plan')
    expect(
      resolvePlanModeAfterOpenPlanIpc({
        permissionChangeRequired: false,
        ipcSucceeded: true
      })
    ).toBe('plan')
  })

  it('开接管则退出 Plan', () => {
    expect(resolvePlanModeAfterTakeoverApplied()).toBe('normal')
  })
})

describe('Composer / App 接线', () => {
  it('footer 在模型选择器旁提供 Plan 开关，有 title 和 aria-label', () => {
    expect(composerSource).toContain('TaskPermissionModeMenu')
    expect(composerSource).toContain('composer-plan-switch')
    expect(composerSource).toContain('resolveComposerPlanSwitch')
    expect(composerSource).toContain('resolveComposerPlanStatusCopy')
    expect(composerSource).toMatch(/:title="planSwitch\.title"/)
    expect(composerSource).toMatch(/:aria-label="planSwitch\.title"/)
    expect(composerSource).toContain('setPlanMode')
    expect(composerSource).toContain('planStatusCopy')
    expect(composerSource).not.toContain("name: 'plan'")
    expect(composerSource).not.toContain("productAction: 'open-plan'")
  })

  it('App 按 Task 存 composerPlanMode，提交走 resolvePlanSubmit，接管成功后退出 Plan', () => {
    expect(appSource).toContain('composerPlanModeByTask')
    expect(appSource).toContain("?? 'normal'")
    expect(appSource).toContain('setTaskPlanMode')
    expect(appSource).toContain('resolveOpenPlanPermissionChange')
    expect(appSource).toContain('resolvePlanModeAfterTakeoverApplied')
    expect(appSource).toContain('isPlanCommandAdvertised')
    expect(appSource).not.toContain('current_mode_update')

    const setPlan = extractFunction(appSource, 'setTaskPlanMode')
    expect(setPlan).not.toContain('cancelTurn')
    expect(setPlan).toMatch(/catch[\s\S]*return/)

    const setPermission = extractFunction(appSource, 'setTaskPermissionMode')
    expect(setPermission).toContain("mode === 'takeover'")
    expect(setPermission).toContain('resolvePlanModeAfterTakeoverApplied')
  })

  it('小窗 Plan 可缩成图标，但不得 display:none 掉模型、输入和发送/停止', () => {
    expect(COMPOSER_COMPACT_ALWAYS_VISIBLE).toEqual([
      'model',
      'permission-mode',
      'plan',
      'send-or-stop'
    ])
    expect(mainCss).toMatch(/@media \(max-width: 980px\)[\s\S]*composer-plan-switch/)
    expect(mainCss).toMatch(
      /@media \(max-width: 980px\)[\s\S]*\.composer-footer \.composer-plan-switch[\s\S]*display: inline-flex/
    )
    expect(mainCss).not.toMatch(/\.composer-plan-switch\s*\{[^}]*display:\s*none/)
    expect(mainCss).toMatch(
      /@media \(max-width: 980px\)[\s\S]*\.composer-footer \.model-selector[\s\S]*display: inline-flex/
    )
  })
})
