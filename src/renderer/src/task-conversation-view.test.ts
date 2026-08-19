import { describe, expect, it } from 'vitest'
import type { TurnTimelineViewModel } from './task-timeline-reducer'
import type { TaskTimelineViewModel } from './task-timeline-reducer'
import {
  collectLocalComposerErrors,
  collectTurnAssistantTexts,
  collectTurnErrorMessages,
  conversationFollowSignature,
  isConversationPinnedToBottom,
  isTurnProcessExpandedByDefault,
  nextConversationPinnedState,
  nextPinnedConversationScrollTop,
  resolveConversationScrollSource,
  shouldMirrorLiveAgentErrorLocally,
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

  it('贴底时滚到容器底部，上翻后不改 scrollTop', () => {
    const pinned = { scrollTop: 920, clientHeight: 80, scrollHeight: 1400 }
    expect(nextPinnedConversationScrollTop(pinned, true)).toBe(1320)
    expect(
      nextPinnedConversationScrollTop(
        { scrollTop: 40, clientHeight: 80, scrollHeight: 1400 },
        false
      )
    ).toBeNull()
  })

  it('wheel 时 stale nearBottom 不得锁死 pin，随后离开底部的 scroll 才取消贴底', () => {
    let pinned = true
    const staleNearBottomAtWheel = true
    expect(
      nextConversationPinnedState({
        pinned,
        source: 'user-input',
        nearBottom: staleNearBottomAtWheel
      })
    ).toBe(true)

    pinned = nextConversationPinnedState({
      pinned,
      source: 'layout-scroll',
      nearBottom: staleNearBottomAtWheel
    })
    expect(pinned).toBe(true)

    const source = resolveConversationScrollSource({
      pendingUserScroll: true,
      programmaticFollow: false
    })
    expect(source).toBe('user-input')
    pinned = nextConversationPinnedState({
      pinned,
      source,
      nearBottom: false
    })
    expect(pinned).toBe(false)
  })

  it('未由程序化贴底触发的 scroll 都按用户输入评估，含键盘翻页', () => {
    expect(
      resolveConversationScrollSource({
        pendingUserScroll: false,
        programmaticFollow: false
      })
    ).toBe('user-input')
    expect(
      resolveConversationScrollSource({
        pendingUserScroll: false,
        programmaticFollow: true
      })
    ).toBe('layout-scroll')
    expect(
      resolveConversationScrollSource({
        pendingUserScroll: true,
        programmaticFollow: true
      })
    ).toBe('user-input')
  })

  it('用户上翻永远取消贴底，layout/程序化滚动不得吞掉这次意图', () => {
    expect(
      nextConversationPinnedState({
        pinned: true,
        source: 'user-input',
        nearBottom: false
      })
    ).toBe(false)
    expect(
      nextConversationPinnedState({
        pinned: true,
        source: 'layout-scroll',
        nearBottom: false
      })
    ).toBe(true)
    expect(
      nextConversationPinnedState({
        pinned: false,
        source: 'user-input',
        nearBottom: true
      })
    ).toBe(true)
  })

  it('流式增高时用户上翻后，后续跟随不得再改 scrollTop', () => {
    let pinned = true
    const el = { scrollTop: 920, clientHeight: 80, scrollHeight: 1000 }
    expect(nextPinnedConversationScrollTop(el, pinned)).toBe(920)

    el.scrollHeight = 1400
    pinned = nextConversationPinnedState({
      pinned,
      source: 'layout-scroll',
      nearBottom: isConversationPinnedToBottom(el)
    })
    expect(pinned).toBe(true)
    expect(nextPinnedConversationScrollTop(el, pinned)).toBe(1320)

    el.scrollTop = 40
    pinned = nextConversationPinnedState({
      pinned,
      source: 'user-input',
      nearBottom: isConversationPinnedToBottom(el)
    })
    expect(pinned).toBe(false)
    el.scrollHeight = 1800
    expect(nextPinnedConversationScrollTop(el, pinned)).toBeNull()
  })

  it('流式同一节点变长时跟随签名变化', () => {
    const running = turn('turn-live', 'running', [
      {
        nodeId: 'm',
        taskId: 'task-1',
        turnId: 'turn-live',
        source: 'agent-event',
        kind: 'message',
        text: '已'
      }
    ])
    const model: TaskTimelineViewModel = {
      taskId: 'task-1',
      title: '改登录',
      turns: [running],
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
    const before = conversationFollowSignature(model)
    running.nodes[0] = { ...running.nodes[0], kind: 'message', text: '已经改好登录' }
    expect(conversationFollowSignature(model)).not.toBe(before)
  })

  it('Agent 时间线错误不进本地条，Composer/IPC 失败才保留', () => {
    expect(shouldMirrorLiveAgentErrorLocally()).toBe(false)
    expect(
      collectLocalComposerErrors(
        [
          { role: 'error', text: 'Runtime 拒绝了这次调用' },
          { role: 'error', text: '发送失败：网络中断' }
        ],
        ['Runtime 拒绝了这次调用']
      )
    ).toEqual(['发送失败：网络中断'])
  })
})
