import { describe, expect, it } from 'vitest'
import type { PublicAgentEvent } from '../../shared/agent-event'
import type { TaskExecutionSnapshot } from '../../shared/task-execution'
import type { PermissionAuditRecord, TurnHistoryRecord } from '../../shared/task-history'
import {
  createTaskTimelineFacts,
  reduceTaskTimelineFacts,
  selectTaskTimeline
} from './task-timeline-reducer'

const TURN: TurnHistoryRecord = {
  taskId: 'task-1',
  turnId: 'turn-1',
  promptDisplayText: '执行测试',
  model: { modelId: 'model-1' },
  state: 'completed',
  createdAt: '2026-08-18T00:00:00.000Z',
  endedAt: '2026-08-18T00:00:03.000Z',
  eventCount: 5,
  eventBytes: 100,
  revision: 1
}
const BASE = {
  runtimeId: 'grok' as const,
  capabilityState: 'native' as const,
  taskId: 'task-1',
  turnId: 'turn-1',
  observedAt: '2026-08-18T00:00:01.000Z'
}
const EVENTS: PublicAgentEvent[] = [
  { ...BASE, sequence: 1, kind: 'agent-thought', text: '分析' },
  { ...BASE, sequence: 2, kind: 'tool-update', toolCallId: 'tool-1', status: 'in_progress' },
  {
    ...BASE,
    sequence: 3,
    kind: 'tool-call',
    toolCallId: 'tool-1',
    title: 'Vitest',
    status: 'completed'
  },
  { ...BASE, sequence: 4, kind: 'agent-message', text: '完成' },
  {
    ...BASE,
    sequence: 5,
    kind: 'turn-complete',
    outcome: 'completed',
    usage: { scope: 'turn', inputTokens: 1, outputTokens: 2, totalTokens: 3 }
  }
]

function snapshot(state: 'completed' | 'running' = 'completed'): TaskExecutionSnapshot {
  const execution =
    state === 'completed'
      ? {
          executionId: 'execution-1',
          taskId: 'task-1',
          turnId: 'turn-1',
          projectId: 'project-1',
          runtimeId: 'grok' as const,
          model: { modelId: 'model-1' },
          environment: { kind: 'local' as const, version: 1 as const, environmentId: 'local:test' },
          state,
          acceptedAt: '2026-08-18T00:00:00.000Z',
          stateChangedAt: '2026-08-18T00:00:03.000Z',
          dispatchedAt: '2026-08-18T00:00:01.000Z',
          endedAt: '2026-08-18T00:00:03.000Z'
        }
      : {
          executionId: 'execution-1',
          taskId: 'task-1',
          turnId: 'turn-1',
          projectId: 'project-1',
          runtimeId: 'grok' as const,
          model: { modelId: 'model-1' },
          environment: { kind: 'local' as const, version: 1 as const, environmentId: 'local:test' },
          state,
          acceptedAt: '2026-08-18T00:00:00.000Z',
          stateChangedAt: '2026-08-18T00:00:01.000Z',
          dispatchedAt: '2026-08-18T00:00:01.000Z'
        }
  return { executorEpoch: 'epoch-1', executionRevision: 2, execution }
}

describe('Task Timeline reducer', () => {
  it('仅有实时事件时显示用户指令不可用，admission 到达后恢复 Prompt', () => {
    const withEvents = reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
      type: 'events/ingest-public',
      events: EVENTS
    })
    expect(selectTaskTimeline(withEvents, { executionSnapshot: snapshot('running') }).turns[0]).toMatchObject({
      prompt: '用户指令不可用'
    })

    const withAdmission = reduceTaskTimelineFacts(withEvents, {
      type: 'turn/admitted',
      admission: {
        taskId: 'task-1',
        turnId: 'turn-1',
        executionId: 'execution-1',
        promptDisplayText: '实时用户指令',
        model: { modelId: 'model-1' },
        acceptedAt: '2026-08-18T00:00:00.000Z'
      }
    })
    const liveView = selectTaskTimeline(withAdmission, { executionSnapshot: snapshot('running') })
    expect(liveView.turns[0]?.prompt).toBe('实时用户指令')
    expect(liveView.turns[0]?.nodes[0]).toMatchObject({
      kind: 'user-prompt',
      text: '实时用户指令',
      source: 'admission'
    })

    const withHistory = reduceTaskTimelineFacts(withAdmission, {
      type: 'turns/upsert',
      turns: [TURN]
    })
    expect(selectTaskTimeline(withHistory, { executionSnapshot: snapshot() }).turns[0]?.prompt).toBe(
      TURN.promptDisplayText
    )
  })

  it('实时与历史任意顺序输入收敛为同一投影', () => {
    const first = reduceTaskTimelineFacts(
      reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
        type: 'turns/upsert',
        turns: [TURN]
      }),
      { type: 'events/ingest-public', events: EVENTS }
    )
    const second = reduceTaskTimelineFacts(
      reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
        type: 'events/ingest-public',
        events: [...EVENTS].reverse()
      }),
      { type: 'turns/upsert', turns: [TURN] }
    )
    expect(second).toEqual(first)
    const view = selectTaskTimeline(first, { executionSnapshot: snapshot() })
    expect(view.turns[0]?.nodes.map((node) => node.kind)).toEqual([
      'user-prompt',
      'thought',
      'tool',
      'message',
      'turn-complete'
    ])
    expect(view.turns[0]?.nodes.find((node) => node.kind === 'tool')).toMatchObject({
      title: 'Vitest',
      status: 'completed'
    })
    expect(view.turns[0]?.usage.turnUsage).toMatchObject({
      source: 'turn-complete',
      value: { totalTokens: 3 }
    })
  })

  it('相同 sequence 冲突不保留争议正文并生成有限 issue', () => {
    const first = { ...BASE, sequence: 1, kind: 'agent-message' as const, text: 'A' }
    const second = { ...first, text: 'B' }
    const state = reduceTaskTimelineFacts(
      reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
        type: 'events/ingest-public',
        events: [first]
      }),
      { type: 'events/ingest-public', events: [second] }
    )
    expect(state.turnsById['turn-1']?.eventsBySequence[1]).toEqual({
      kind: 'conflict',
      sequence: 1,
      observedKinds: ['agent-message']
    })
    expect(JSON.stringify(state)).not.toContain('"A"')
    expect(JSON.stringify(state)).not.toContain('"B"')
    expect(Object.values(state.integrityIssuesByKey)).toContainEqual(
      expect.objectContaining({ code: 'event-sequence-conflict', sequence: 1 })
    )
  })

  it('持久化终态优先于陈旧 execution，并明确状态冲突', () => {
    const state = reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
      type: 'turns/upsert',
      turns: [TURN]
    })
    const view = selectTaskTimeline(state, { executionSnapshot: snapshot('running') })
    expect(view.turns[0]).toMatchObject({
      status: 'completed',
      statusConflict: true,
      statusProvisional: false
    })
  })

  it('权限审计按 auditId 幂等归并，不产生可操作审批', () => {
    const audit: PermissionAuditRecord = {
      auditId: 'audit-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      projectId: 'project-1',
      environmentId: 'local:test',
      initiator: 'runtime',
      runtimeId: 'grok',
      operationType: 'write-file',
      risk: 'L1',
      targetSummaries: ['path: src/a.ts'],
      title: '修改文件',
      impact: '写入文件',
      reason: 'user-allowed',
      scope: 'once',
      createdAt: '2026-08-18T00:00:02.000Z'
    }
    const state = reduceTaskTimelineFacts(
      reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
        type: 'permission-audits/merge',
        audits: [audit]
      }),
      { type: 'permission-audits/merge', audits: [audit] }
    )
    const view = selectTaskTimeline(state, {
      executionSnapshot: { executorEpoch: 'epoch', executionRevision: 0, execution: null }
    })
    expect(view.turns[0]?.nodes.filter((node) => node.kind === 'permission-audit')).toHaveLength(1)
  })

  it('合并连续的无 messageId 文本片段，但不跨越事件边界', () => {
    const messageChunks: Extract<PublicAgentEvent, { kind: 'agent-message' }>[] = Array.from(
      { length: 1000 },
      (_, index) => ({
        ...BASE,
        sequence: index + 1,
        kind: 'agent-message' as const,
        text: String(index)
      })
    )
    const state = reduceTaskTimelineFacts(
      reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
        type: 'turns/upsert',
        turns: [TURN]
      }),
      {
        type: 'events/ingest-public',
        events: [
          ...messageChunks,
          { ...BASE, sequence: 1001, kind: 'agent-thought', text: '先' },
          { ...BASE, sequence: 1002, kind: 'agent-thought', text: '后' },
          {
            ...BASE,
            sequence: 1003,
            kind: 'tool-call',
            toolCallId: 'tool-boundary',
            title: '边界工具'
          },
          { ...BASE, sequence: 1004, kind: 'agent-thought', text: '分隔后' },
          { ...BASE, sequence: 1005, kind: 'agent-message', text: '尾部回复' }
        ]
      }
    )
    const nodes = selectTaskTimeline(state, { executionSnapshot: snapshot() }).turns[0]?.nodes ?? []
    const textNodes = nodes.filter(
      (node): node is Extract<(typeof nodes)[number], { kind: 'message' | 'thought' }> =>
        node.kind === 'message' || node.kind === 'thought'
    )

    expect(textNodes).toEqual([
      expect.objectContaining({
        kind: 'message',
        text: messageChunks.map((event) => event.text).join('')
      }),
      expect.objectContaining({ kind: 'thought', text: '先后' }),
      expect.objectContaining({ kind: 'thought', text: '分隔后' }),
      expect.objectContaining({ kind: 'message', text: '尾部回复' })
    ])
    expect(nodes.filter((node) => node.kind === 'tool')).toHaveLength(1)
  })
})
