import { describe, expect, it } from 'vitest'
import type { PersistedAgentEvent, TurnHistoryRecord } from '../../shared/task-history'
import { projectTaskHistory } from './task-history-projector'

const turn: TurnHistoryRecord = {
  taskId: 'task-1',
  turnId: 'turn-1',
  promptDisplayText: '执行测试',
  model: { modelId: 'model-1', displayName: '模型一' },
  state: 'completed',
  createdAt: '2026-08-12T00:00:00.000Z',
  endedAt: '2026-08-12T00:00:01.000Z',
  eventCount: 4,
  eventBytes: 100,
  revision: 1
}

function base(sequence: number): {
  runtimeId: 'grok'
  capabilityState: 'native'
  taskId: string
  turnId: string
  sequence: number
  observedAt: string
} {
  return {
    runtimeId: 'grok' as const,
    capabilityState: 'native' as const,
    taskId: 'task-1',
    turnId: 'turn-1',
    sequence,
    observedAt: `2026-08-12T00:00:0${sequence}.000Z`
  }
}

describe('Task 历史投影', () => {
  it('按 Turn sequence 回放消息、思考、计划和工具状态', () => {
    const events: PersistedAgentEvent[] = [
      { ...base(2), kind: 'agent-message', text: '完成' },
      { ...base(1), kind: 'agent-thought', text: '分析中' },
      {
        ...base(3),
        kind: 'plan',
        entries: [{ content: '运行测试', priority: 'high', status: 'completed' }]
      },
      { ...base(4), kind: 'tool-call', toolCallId: 'tool-1', title: 'Vitest', status: 'completed' }
    ]

    const projection = projectTaskHistory([turn], { 'turn-1': events })

    expect(projection.messages.map((message) => [message.role, message.text])).toEqual([
      ['user', '执行测试'],
      ['thought', '分析中'],
      ['assistant', '完成']
    ])
    expect(projection.planEntries[0]?.content).toBe('运行测试')
    expect(projection.toolActivities[0]).toMatchObject({ title: 'Vitest', status: 'completed' })
  })
})
