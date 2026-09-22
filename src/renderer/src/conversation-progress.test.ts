import { describe, expect, it } from 'vitest'
import type { TaskTimelineNode } from './task-timeline-reducer'
import {
  conversationTurnDurationMs,
  formatConversationActivityAge,
  formatConversationDuration,
  isAskUserToolTitle,
  isConversationWaitingForEvent,
  resolveConversationActivityHint,
  resolveConversationStep,
  shouldShowConversationStatus
} from './conversation-progress'

/** 完成正文不重复状态大卡，异常和仍待用户操作的事实不能被视觉收束隐藏。 */
describe('对话状态层级', () => {
  it('正常完成轮隐藏重复头部，运行、停止、失败和异常历史保持可见', () => {
    expect(shouldShowConversationStatus({ status: 'completed' })).toBe(false)
    for (const status of [
      'running',
      'waiting-permission',
      'failed',
      'cancelled',
      'interrupted'
    ] as const) {
      expect(shouldShowConversationStatus({ status })).toBe(true)
    }
    expect(shouldShowConversationStatus({ status: 'completed', historyTruncated: true })).toBe(true)
    expect(shouldShowConversationStatus({ status: 'completed', statusConflict: true })).toBe(true)
    expect(shouldShowConversationStatus({ status: 'completed' }, true)).toBe(true)
  })
})

function toolNode(
  title: string,
  status: 'completed' | 'in_progress' = 'completed'
): TaskTimelineNode {
  return {
    nodeId: `tool-${title}`,
    taskId: 'task-1',
    turnId: 'turn-1',
    source: 'agent-event',
    kind: 'tool',
    toolCallId: `tool-${title}`,
    title,
    status
  }
}

function planNode(completed = 0, total = 2): TaskTimelineNode {
  return {
    nodeId: 'plan',
    taskId: 'task-1',
    turnId: 'turn-1',
    source: 'agent-event',
    kind: 'plan',
    entries: Array.from({ length: total }, (_, index) => ({
      content: `步骤 ${index + 1}`,
      priority: 'medium' as const,
      status: index < completed ? ('completed' as const) : ('pending' as const)
    }))
  }
}

function auditNode(): TaskTimelineNode {
  return {
    nodeId: 'audit',
    taskId: 'task-1',
    turnId: 'turn-1',
    source: 'permission-audit',
    kind: 'permission-audit',
    foldedCount: 4,
    summary: '已自动允许 4 次未知操作',
    audit: {
      auditId: 'a1',
      taskId: 'task-1',
      turnId: 'turn-1',
      projectId: 'project-1',
      environmentId: 'local:test',
      initiator: 'runtime',
      operationType: 'read-project',
      risk: 'L0',
      targetSummaries: [],
      title: '读取',
      impact: '',
      reason: 'auto-allowed',
      createdAt: '2026-09-02T00:00:04.000Z'
    }
  }
}

const baseTurn = {
  status: 'running' as const,
  createdAt: '2026-09-02T00:00:00.000Z',
  dispatchedAt: '2026-09-02T00:00:02.000Z',
  lastEventAt: '2026-09-02T00:00:04.000Z'
}

describe('conversation progress', () => {
  it('格式化短时长与小时级时长', () => {
    expect(formatConversationDuration(0)).toBe('00:00')
    expect(formatConversationDuration(65_000)).toBe('01:05')
    expect(formatConversationDuration(3_661_000)).toBe('1:01:01')
  })

  it('终态冻结耗时，运行态使用当前时钟', () => {
    expect(
      conversationTurnDurationMs(
        {
          createdAt: baseTurn.createdAt,
          dispatchedAt: baseTurn.dispatchedAt,
          endedAt: '2026-09-02T00:00:07.500Z'
        },
        Date.parse('2026-09-02T00:01:00.000Z')
      )
    ).toBe(5_500)
    expect(
      conversationTurnDurationMs(
        { createdAt: baseTurn.createdAt, dispatchedAt: baseTurn.dispatchedAt },
        Date.parse('2026-09-02T00:00:12.000Z')
      )
    ).toBe(10_000)
  })

  it('只在运行中且超过静默阈值时提示等待事件', () => {
    const now = Date.parse('2026-09-02T00:00:14.000Z')
    expect(isConversationWaitingForEvent(baseTurn, now, 8_000)).toBe(true)
    expect(isConversationWaitingForEvent({ ...baseTurn, status: 'completed' }, now, 8_000)).toBe(
      false
    )
  })

  it('展示最近活动年龄和当前步骤', () => {
    expect(
      formatConversationActivityAge(
        Date.parse(baseTurn.lastEventAt),
        Date.parse('2026-09-02T00:00:06.000Z')
      )
    ).toBe('2 秒前更新')
    expect(
      resolveConversationStep([
        {
          nodeId: 'tool',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'tool',
          toolCallId: 'tool-1',
          title: '列目录',
          status: 'in_progress'
        }
      ])
    ).toBe('列目录')
  })

  it('Ask 工具静默时提示等待回答，而不是等待 Runtime 事件', () => {
    expect(isAskUserToolTitle('Ask: 你现在最想先解决哪一件事?')).toBe(true)
    expect(isAskUserToolTitle('Ask 3 questions')).toBe(true)
    expect(isAskUserToolTitle('列目录')).toBe(false)
    expect(
      resolveConversationActivityHint({
        waitingForEvent: true,
        hasPendingQuestion: false,
        currentStepLabel: 'Ask: 你现在最想先解决哪一件事?'
      })
    ).toBe('等待你的回答')
    expect(
      resolveConversationActivityHint({
        waitingForEvent: true,
        hasPendingQuestion: true,
        currentStepLabel: '思考中'
      })
    ).toBe('等待你的回答')
    expect(
      resolveConversationActivityHint({
        waitingForEvent: true,
        hasPendingQuestion: false,
        currentStepLabel: '列目录'
      })
    ).toBe('等待 Runtime 新事件')
  })

  it('静默授权排在事件后面时，步骤仍显示计划和工具，而不是记录权限决定', () => {
    expect(resolveConversationStep([planNode(0, 3), auditNode()])).toBe('执行计划 · 0/3')
    expect(resolveConversationStep([toolNode('列目录'), planNode(1, 2), auditNode()])).toBe(
      '执行计划 · 1/2'
    )
    expect(resolveConversationStep([toolNode('打开网页', 'in_progress'), auditNode()])).toBe(
      '打开网页'
    )
    expect(resolveConversationStep([auditNode()])).toBe('记录权限决定')
  })

  it('终态且没有真实步骤时，不把「准备执行」当成当前动作', () => {
    expect(
      resolveConversationActivityHint({
        waitingForEvent: false,
        hasPendingQuestion: false,
        currentStepLabel: '准备执行',
        turnStatus: 'completed'
      })
    ).toBe('')
    expect(
      resolveConversationActivityHint({
        waitingForEvent: false,
        hasPendingQuestion: false,
        currentStepLabel: '打开网页',
        turnStatus: 'cancelled'
      })
    ).toBe('打开网页')
  })
})
