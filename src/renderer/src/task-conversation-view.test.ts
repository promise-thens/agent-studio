import { describe, expect, it } from 'vitest'
import type { TurnTimelineViewModel } from './task-timeline-reducer'
import {
  collectTurnAssistantTexts,
  collectTurnErrorMessages,
  isConversationPinnedToBottom,
  isTurnProcessExpandedByDefault,
  turnHasCollapsibleProcess
} from './task-conversation-view'

function turn(
  turnId: string,
  status: TurnTimelineViewModel['status'],
  nodes: TurnTimelineViewModel['nodes']
): TurnTimelineViewModel {
  return {
    taskId: 'task-1',
    turnId,
    prompt: '请改登录',
    model: { modelId: 'model-1' },
    status,
    statusProvisional: false,
    statusConflict: false,
    createdAt: '2026-08-12T00:00:00.000Z',
    nodes,
    usage: { contextSamples: [] },
    historyTruncated: false
  }
}

describe('对话滚动与折叠', () => {
  it('只有接近底部时才跟随最新活动 Turn', () => {
    expect(
      isConversationPinnedToBottom({ scrollTop: 920, clientHeight: 80, scrollHeight: 1000 })
    ).toBe(true)
    expect(
      isConversationPinnedToBottom({ scrollTop: 100, clientHeight: 80, scrollHeight: 1000 })
    ).toBe(false)
  })

  it('历史 Turn 默认折叠过程，活动 Turn 展开', () => {
    const completed = turn('turn-old', 'completed', [
      {
        nodeId: 'u',
        taskId: 'task-1',
        turnId: 'turn-old',
        source: 'turn-record',
        kind: 'user-prompt',
        text: '请改登录'
      },
      {
        nodeId: 't',
        taskId: 'task-1',
        turnId: 'turn-old',
        source: 'agent-event',
        kind: 'thought',
        text: '先找 auth'
      },
      {
        nodeId: 'm',
        taskId: 'task-1',
        turnId: 'turn-old',
        source: 'agent-event',
        kind: 'message',
        text: '已经改好'
      }
    ])
    const running = turn('turn-live', 'running', [
      {
        nodeId: 'u2',
        taskId: 'task-1',
        turnId: 'turn-live',
        source: 'admission',
        kind: 'user-prompt',
        text: '再补测试'
      },
      {
        nodeId: 'tool',
        taskId: 'task-1',
        turnId: 'turn-live',
        source: 'agent-event',
        kind: 'tool',
        toolCallId: 't1',
        title: '读文件',
        status: 'in_progress'
      }
    ])

    expect(turnHasCollapsibleProcess(completed)).toBe(true)
    expect(isTurnProcessExpandedByDefault(completed)).toBe(false)
    expect(isTurnProcessExpandedByDefault(running)).toBe(true)
    expect(collectTurnAssistantTexts(completed)).toEqual(['已经改好'])
    expect(collectTurnErrorMessages(completed)).toEqual([])
  })
})
