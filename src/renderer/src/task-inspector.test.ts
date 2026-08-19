import { describe, expect, it } from 'vitest'
import {
  INSPECTOR_DEFAULT_OPEN,
  INSPECTOR_DEFAULT_TAB,
  INSPECTOR_TABS,
  inspectorPlaceholderCopy,
  inspectorToggleLabel,
  isInspectorTab,
  nextInspectorTab,
  resolveInspectorTab,
  toggleInspectorOpen,
  permissionAuditInitiatorLabel,
  permissionAuditReasonLabel,
  permissionAuditScopeLabel
} from './task-inspector'

describe('Inspector 开关与标签', () => {
  it('默认关闭，且默认落在 Timeline', () => {
    expect(INSPECTOR_DEFAULT_OPEN).toBe(false)
    expect(INSPECTOR_DEFAULT_TAB).toBe('timeline')
    expect(INSPECTOR_TABS.map((tab) => tab.id)).toEqual([
      'timeline',
      'changes',
      'terminal',
      'artifacts'
    ])
  })

  it('开关只翻转布尔值，标题栏文案随开合变化', () => {
    expect(toggleInspectorOpen(false)).toBe(true)
    expect(toggleInspectorOpen(true)).toBe(false)
    expect(inspectorToggleLabel(false)).toBe('打开检查器')
    expect(inspectorToggleLabel(true)).toBe('关闭检查器')
    expect(resolveInspectorTab('changes')).toBe('changes')
  })

  it('未知标签回退到 Timeline，左右方向键循环', () => {
    expect(isInspectorTab('plan')).toBe(false)
    expect(resolveInspectorTab('plan')).toBe('timeline')
    expect(resolveInspectorTab(undefined)).toBe('timeline')
    expect(nextInspectorTab('timeline', 1)).toBe('changes')
    expect(nextInspectorTab('artifacts', 1)).toBe('timeline')
    expect(nextInspectorTab('timeline', -1)).toBe('artifacts')
  })
})

describe('Inspector 占位文案', () => {
  it('Changes 与 Artifacts 指向后续计划，不伪装已实现', () => {
    expect(inspectorPlaceholderCopy('changes').heading).toBe('尚未实现 · P0-12 Git Review')
    expect(inspectorPlaceholderCopy('artifacts').heading).toBe('尚未实现 · P0-13')
  })

  it('Terminal 标明 P0-15 用户交互终端，不把命令证据缺失写成终端未接入', () => {
    const copy = inspectorPlaceholderCopy('terminal')
    expect(copy.heading).toBe('尚未实现 · P0-15 用户交互终端')
    expect(copy.detail).toMatch(/用户可输入|可交互/)
    expect(copy.heading + copy.detail).not.toMatch(/命令证据缺失|命令证据尚未|尚未接入命令/)
  })
})

describe('权限审计展示标签', () => {
  it('把已有审计字段翻成可读中文，不引入 Runtime 营销名', () => {
    expect(permissionAuditReasonLabel('user-allowed')).toBe('用户允许')
    expect(permissionAuditScopeLabel('once')).toBe('仅本次')
    expect(permissionAuditScopeLabel(undefined)).toBe('未授予范围')
    expect(permissionAuditInitiatorLabel({ initiator: 'runtime', runtimeId: 'grok' })).toBe(
      'Grok Build'
    )
    expect(permissionAuditInitiatorLabel({ initiator: 'app', appService: 'git' })).toBe('Git')
  })
})
