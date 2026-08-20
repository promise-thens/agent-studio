import { describe, expect, it } from 'vitest'
import type { TaskTimelineViewModel } from './task-timeline-reducer'
import {
  INSPECTOR_DEFAULT_OPEN,
  INSPECTOR_DEFAULT_TAB,
  INSPECTOR_TABS,
  WORKSPACE_INSPECTOR_PLACEMENT,
  WORKSPACE_PRIMARY_COLUMNS,
  inspectorPlaceholderCopy,
  inspectorToggleLabel,
  isInspectorTab,
  nextInspectorTab,
  projectInspectorTimelineSummary,
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

  it('默认关、默认 Timeline，主列仍是两列 overlay，摘要不是计划主副本', () => {
    expect(INSPECTOR_DEFAULT_OPEN).toBe(false)
    expect(INSPECTOR_DEFAULT_TAB).toBe('timeline')
    expect(WORKSPACE_PRIMARY_COLUMNS).toEqual(['sidebar', 'conversation'])
    expect(WORKSPACE_INSPECTOR_PLACEMENT).toBe('overlay')
    expect(inspectorPlaceholderCopy('changes').heading).toContain('P0-12')
    expect(inspectorPlaceholderCopy('terminal').heading).toContain('P0-15')
    expect(inspectorPlaceholderCopy('artifacts').heading).toContain('P0-13')

    expect(projectInspectorTimelineSummary(null)).toMatchObject({
      empty: true,
      turnCount: 0,
      planLine: null,
      toolCount: 0
    })

    const timeline: TaskTimelineViewModel = {
      taskId: 'task-1',
      title: '改登录',
      turns: [
        {
          taskId: 'task-1',
          turnId: 'turn-1',
          prompt: '改登录',
          model: { modelId: 'model-1' },
          status: 'running',
          statusProvisional: false,
          statusConflict: false,
          createdAt: '2026-08-12T00:00:00.000Z',
          nodes: [
            {
              nodeId: 'task-1:turn-1:plan',
              taskId: 'task-1',
              turnId: 'turn-1',
              source: 'agent-event',
              kind: 'plan',
              entries: [
                { content: '找现有 auth', priority: 'high', status: 'completed' },
                { content: '改登录表单', priority: 'medium', status: 'in_progress' },
                { content: '补测试', priority: 'low', status: 'pending' }
              ]
            },
            {
              nodeId: 'task-1:turn-1:tool:t1',
              taskId: 'task-1',
              turnId: 'turn-1',
              source: 'agent-event',
              kind: 'tool',
              toolCallId: 't1',
              title: '读取 auth.ts',
              status: 'completed'
            }
          ],
          usage: { contextSamples: [] },
          historyTruncated: false
        }
      ],
      resultReview: {
        status: { value: 'running', source: 'execution' },
        usage: { availability: 'not-observed' },
        changedPaths: { count: 0, availability: 'not-observed' },
        validations: { count: 0, availability: 'not-observed' },
        artifacts: { count: 0, availability: 'not-observed' },
        warnings: []
      },
      integrityIssues: []
    }

    const summary = projectInspectorTimelineSummary(timeline)
    expect(summary.empty).toBe(false)
    expect(summary.turnCount).toBe(1)
    expect(summary.statusLabel).toBe('执行中')
    expect(summary.planLine).toBe('计划 · 1/3')
    expect(summary.toolCount).toBe(1)
    expect(summary).not.toHaveProperty('entries')
    expect(JSON.stringify(summary)).not.toContain('找现有 auth')
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
