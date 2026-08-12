import { describe, expect, it } from 'vitest'
import type {
  AgentErrorEvent,
  AgentMessageEvent,
  AgentThoughtEvent,
  AgentToolEvent,
  AgentTurnCompleteEvent
} from '../../shared/agent'
import {
  createAgentEventGuard,
  createAgentMessageKey,
  createAgentToolKey
} from './agent-event-consumer'

const OBSERVED_AT = '2026-08-10T13:00:00.000Z'

describe('Renderer AgentEvent 消费守卫', () => {
  it('保留连续文本，同时拒绝重复 sequence 和晚到旧事件', () => {
    const accept = createAgentEventGuard()

    expect(accept(messageEvent('task-1', 1))).toBe(true)
    expect(accept(messageEvent('task-1', 2))).toBe(true)
    expect(accept(messageEvent('task-1', 2))).toBe(false)
    expect(accept(messageEvent('task-1', 1))).toBe(false)
    expect(accept(messageEvent('task-1', 4))).toBe(true)
  })

  it('不同任务独立排序，普通错误不锁定任务', () => {
    const accept = createAgentEventGuard()

    expect(accept(messageEvent('task-1', 1))).toBe(true)
    expect(accept(messageEvent('task-2', 1))).toBe(true)
    expect(accept(errorEvent('task-1', 2))).toBe(true)
    expect(accept(messageEvent('task-1', 3))).toBe(true)
  })

  it('首个终态只锁定所属 Turn，并允许同一任务进入下一 Turn', () => {
    const accept = createAgentEventGuard()
    const secondTurnMessage = {
      ...messageEvent('task-1', 1),
      turnId: 'task-1-turn-2'
    }
    const secondTurnComplete = {
      ...turnCompleteEvent('task-1', 2),
      turnId: 'task-1-turn-2'
    }

    expect(accept(messageEvent('task-1', 1))).toBe(true)
    expect(accept(turnCompleteEvent('task-1', 2))).toBe(true)
    expect(accept(secondTurnMessage)).toBe(true)
    expect(accept(messageEvent('task-1', 3))).toBe(false)
    expect(accept(turnCompleteEvent('task-1', 4))).toBe(false)
    expect(accept(secondTurnComplete)).toBe(true)
    expect(accept({ ...secondTurnMessage, sequence: 3 })).toBe(false)
    expect(accept(messageEvent('task-2', 1))).toBe(true)
  })

  it('拒绝非法 sequence，且不污染后续合法事件', () => {
    const accept = createAgentEventGuard()

    expect(accept(messageEvent('task-1', 0))).toBe(false)
    expect(accept(messageEvent('task-1', 1))).toBe(true)
  })
})

describe('Renderer AgentEvent 稳定 key', () => {
  it('消息 key 按任务、Turn、种类与 messageId 隔离', () => {
    const first = messageEvent('task-1', 1)
    const next = messageEvent('task-1', 2)
    const anotherTask = messageEvent('task-2', 1)
    const anotherTurn = { ...messageEvent('task-1', 1), turnId: 'task-1-turn-2' }
    const thought = thoughtEvent('task-1', 3)
    const stream = messageEvent('task-1', 4, null)

    expect(createAgentMessageKey(first)).toBe(createAgentMessageKey(next))
    expect(createAgentMessageKey(first)).not.toBe(createAgentMessageKey(anotherTask))
    expect(createAgentMessageKey(first)).not.toBe(createAgentMessageKey(anotherTurn))
    expect(createAgentMessageKey(first)).not.toBe(createAgentMessageKey(thought))
    expect(createAgentMessageKey(stream)).toBe('task-1:task-1-turn:agent-message:stream')
  })

  it('工具 call/update 只在同一 Turn 内合并，不同任务或 Turn 保持隔离', () => {
    const call = toolEvent('task-1', 1, 'tool-call')
    const update = toolEvent('task-1', 2, 'tool-update')
    const anotherTask = toolEvent('task-2', 1, 'tool-update')
    const anotherTurn = {
      ...toolEvent('task-1', 1, 'tool-update'),
      turnId: 'task-1-turn-2'
    }

    expect(createAgentToolKey(call)).toBe(createAgentToolKey(update))
    expect(createAgentToolKey(call)).not.toBe(createAgentToolKey(anotherTask))
    expect(createAgentToolKey(call)).not.toBe(createAgentToolKey(anotherTurn))
  })
})

function eventBase(taskId: string, sequence: number): AgentMessageEvent {
  return {
    runtimeId: 'grok',
    runtimeSessionId: 'runtime-session-1',
    capabilityState: 'native',
    taskId,
    turnId: `${taskId}-turn`,
    sequence,
    observedAt: OBSERVED_AT,
    kind: 'agent-message',
    text: '重复文本',
    messageId: 'message-1'
  }
}

function messageEvent(
  taskId: string,
  sequence: number,
  messageId: string | null = 'message-1'
): AgentMessageEvent {
  const event = eventBase(taskId, sequence)
  return messageId == null ? { ...event, messageId: undefined } : { ...event, messageId }
}

function thoughtEvent(taskId: string, sequence: number): AgentThoughtEvent {
  return {
    ...eventBase(taskId, sequence),
    kind: 'agent-thought',
    text: '思考内容',
    messageId: 'message-1'
  }
}

function errorEvent(taskId: string, sequence: number): AgentErrorEvent {
  return {
    ...eventBase(taskId, sequence),
    kind: 'error',
    message: '可恢复错误',
    recoverable: true,
    code: 'fake-error'
  }
}

function turnCompleteEvent(taskId: string, sequence: number): AgentTurnCompleteEvent {
  return {
    ...eventBase(taskId, sequence),
    kind: 'turn-complete',
    outcome: 'completed'
  }
}

function toolEvent(taskId: string, sequence: number, kind: AgentToolEvent['kind']): AgentToolEvent {
  return kind === 'tool-call'
    ? {
        ...eventBase(taskId, sequence),
        kind,
        toolCallId: 'tool-1',
        title: '执行测试',
        status: 'in_progress'
      }
    : {
        ...eventBase(taskId, sequence),
        kind,
        toolCallId: 'tool-1',
        status: 'completed'
      }
}
