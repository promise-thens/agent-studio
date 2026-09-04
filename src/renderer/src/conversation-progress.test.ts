import { describe, expect, it } from 'vitest'
import {
  conversationTurnDurationMs,
  formatConversationActivityAge,
  formatConversationDuration,
  isAskUserToolTitle,
  isConversationWaitingForEvent,
  resolveConversationActivityHint,
  resolveConversationStep
} from './conversation-progress'

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
})
