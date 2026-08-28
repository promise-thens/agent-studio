import { describe, expect, it } from 'vitest'
import type { TaskTimelineViewModel } from './task-timeline-reducer'
import {
  INSPECTOR_DEFAULT_OPEN,
  INSPECTOR_DEFAULT_TAB,
  INSPECTOR_TABS,
  WORKSPACE_INSPECTOR_PLACEMENT,
  WORKSPACE_PRIMARY_COLUMNS,
  INSPECTOR_CARD_MARGIN,
  clampInspectorCardRect,
  defaultInspectorCardRect,
  inspectorPlaceholderCopy,
  inspectorReviewWorkspaceClass,
  inspectorToggleLabel,
  isInspectorCardDragSource,
  isInspectorTab,
  moveInspectorCardRect,
  nextInspectorTab,
  openChangesReview,
  projectInspectorTimelineSummary,
  resolveInspectorTab,
  toggleInspectorOpen,
  permissionAuditInitiatorLabel,
  permissionAuditReasonLabel,
  permissionAuditScopeLabel
} from './task-inspector'

function fakeClosestNode(
  matches: readonly string[],
  parent?: { closest: (selector: string) => unknown }
): { closest: (selector: string) => unknown } {
  return {
    closest(selector: string) {
      if (matches.some((item) => selector.includes(item))) return this
      return parent?.closest(selector) ?? null
    }
  }
}

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
    expect(INSPECTOR_TABS.map((tab) => tab.label)).toEqual(['时间线', '变更', '终端', '产物'])
  })

  it('开关只翻转布尔值，标题栏文案随开合变化', () => {
    expect(toggleInspectorOpen(false)).toBe(true)
    expect(toggleInspectorOpen(true)).toBe(false)
    expect(inspectorToggleLabel(false)).toBe('打开检查器')
    expect(inspectorToggleLabel(true)).toBe('关闭检查器')
    expect(resolveInspectorTab('changes')).toBe('changes')
  })

  it('审核入口打开 Changes 工作区，产物标签同样加宽', () => {
    expect(openChangesReview()).toEqual({ open: true, tab: 'changes' })
    expect(inspectorReviewWorkspaceClass('changes')).toBe('is-review-workspace')
    expect(inspectorReviewWorkspaceClass('artifacts')).toBe('is-review-workspace')
    expect(inspectorReviewWorkspaceClass('timeline')).toBe('')
    expect(WORKSPACE_INSPECTOR_PLACEMENT).toBe('overlay')
  })

  it('悬浮卡默认贴右上角，拖出视口会夹回边距，放大则铺满工作区', () => {
    expect(
      defaultInspectorCardRect({
        viewportWidth: 1200,
        viewportHeight: 800,
        width: 380,
        height: 560
      })
    ).toEqual({
      left: 1200 - 380 - INSPECTOR_CARD_MARGIN,
      top: INSPECTOR_CARD_MARGIN,
      width: 380,
      height: 560
    })
    expect(
      clampInspectorCardRect({
        left: -80,
        top: 900,
        width: 380,
        height: 560,
        viewportWidth: 1000,
        viewportHeight: 700
      })
    ).toEqual({
      left: INSPECTOR_CARD_MARGIN,
      top: 700 - 560 - INSPECTOR_CARD_MARGIN,
      width: 380,
      height: 560
    })
    expect(
      moveInspectorCardRect({ left: 100, top: 40, width: 380, height: 200 }, 24, -8, {
        viewportWidth: 1000,
        viewportHeight: 700
      })
    ).toMatchObject({ left: 124, top: 32 })
    const expanded = defaultInspectorCardRect({
      viewportWidth: 1000,
      viewportHeight: 700,
      width: 380,
      height: 560,
      expanded: true
    })
    expect(expanded).toEqual({
      left: INSPECTOR_CARD_MARGIN,
      top: INSPECTOR_CARD_MARGIN,
      width: 1000 - INSPECTOR_CARD_MARGIN * 2,
      height: 700 - INSPECTOR_CARD_MARGIN * 2
    })
  })

  it('只有拖动手柄空白处能开始拖拽，标签和关闭按钮不行', () => {
    const handle = fakeClosestNode(['data-inspector-drag-handle'])
    const closeButton = fakeClosestNode(['button'], handle)
    expect(isInspectorCardDragSource(closeButton)).toBe(false)
    expect(isInspectorCardDragSource(handle)).toBe(true)
    expect(isInspectorCardDragSource(null)).toBe(false)
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
  it('Changes 和 Artifacts 已实现，无 Task 时只提示选择', () => {
    expect(inspectorPlaceholderCopy('changes').heading).toBe('选择一个 Task')
    expect(inspectorPlaceholderCopy('changes').heading).not.toMatch(/尚未实现/)
    expect(inspectorPlaceholderCopy('changes').detail).toMatch(/变更|审阅/)
    expect(inspectorPlaceholderCopy('artifacts').heading).toBe('选择一个 Task')
    expect(inspectorPlaceholderCopy('artifacts').detail).toMatch(/Markdown|图片|Diff/)
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
    expect(inspectorPlaceholderCopy('changes').heading).toBe('选择一个 Task')
    expect(inspectorPlaceholderCopy('terminal').heading).toContain('P0-15')
    expect(inspectorPlaceholderCopy('artifacts').heading).toBe('选择一个 Task')

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
        commands: [],
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
    expect(permissionAuditReasonLabel('auto-allowed')).toBe('策略自动允许')
    expect(permissionAuditReasonLabel('grant-reused')).toBe('复用当前 Task 授权')
    expect(permissionAuditReasonLabel('user-allowed')).toBe('用户允许')
    expect(permissionAuditScopeLabel('once')).toBe('仅本次')
    expect(permissionAuditScopeLabel(undefined)).toBe('未授予范围')
    expect(permissionAuditInitiatorLabel({ initiator: 'runtime', runtimeId: 'grok' })).toBe(
      'Grok Build'
    )
    expect(permissionAuditInitiatorLabel({ initiator: 'app', appService: 'git' })).toBe('Git')
  })
})
