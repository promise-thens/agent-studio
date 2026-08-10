import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  AgentCapability,
  AgentCapabilityState,
  AgentContextUsage,
  AgentEvent,
  AgentPermissionRequest,
  AgentRuntimeStatus,
  AgentSessionSummary,
  AgentTaskSummary,
  AgentTurnSummary,
  AgentTurnUsage,
  AgentUsage
} from './agent'

const timestamp = '2026-08-10T10:00:00.000Z'

describe('Agent 领域契约', () => {
  it('Runtime、Task、Session、Turn 与 Permission 摘要可安全序列化', () => {
    const runtimeStatus: AgentRuntimeStatus = {
      runtimeId: 'grok',
      state: 'ready',
      message: '已连接',
      workspace: '/tmp/agent-studio',
      runtimeSessionId: 'runtime-session-1'
    }
    const task: AgentTaskSummary = {
      taskId: 'task-1',
      runtimeId: 'grok',
      state: 'running',
      title: '验证领域契约',
      workspace: '/tmp/agent-studio',
      sessionId: 'session-1',
      createdAt: timestamp,
      updatedAt: timestamp
    }
    const session: AgentSessionSummary = {
      sessionId: 'session-1',
      runtimeId: 'grok',
      state: 'running',
      runtimeSessionId: 'runtime-session-1',
      workspace: '/tmp/agent-studio',
      createdAt: timestamp,
      updatedAt: timestamp
    }
    const turn: AgentTurnSummary = {
      turnId: 'turn-1',
      taskId: 'task-1',
      sessionId: 'session-1',
      state: 'completed',
      startedAt: timestamp,
      completedAt: timestamp
    }
    const permission: AgentPermissionRequest = {
      id: 'permission-1',
      runtimeId: 'grok',
      taskId: 'task-1',
      turnId: 'turn-1',
      runtimeSessionId: 'runtime-session-1',
      toolCallId: 'tool-1',
      title: '允许读取测试目录吗？',
      options: [{ optionId: 'allow', name: '允许一次', kind: 'allow_once' }],
      truncated: true
    }

    for (const value of [runtimeStatus, task, session, turn, permission]) {
      expectSerializable(value)
    }
  })

  it('Usage 使用非空判别联合，并保留 unsupported 能力状态', () => {
    const contextUsage: AgentContextUsage = {
      scope: 'context',
      usedTokens: 120,
      limitTokens: 4096,
      cost: { amount: 0.01, currency: 'USD' }
    }
    const turnUsage: AgentTurnUsage = {
      scope: 'turn',
      inputTokens: 80,
      outputTokens: 40,
      totalTokens: 120,
      thoughtTokens: 10
    }
    const capabilityState: AgentCapabilityState = 'unsupported'
    const unsupportedCapability: AgentCapability = {
      capabilityId: 'terminal-resume',
      state: capabilityState,
      reason: '当前 Runtime 未声明恢复能力'
    }

    expectTypeOf<AgentUsage>().toEqualTypeOf<AgentContextUsage | AgentTurnUsage>()
    expectSerializable(contextUsage)
    expectSerializable(turnUsage)
    expectSerializable(unsupportedCapability)
    expect(JSON.parse(JSON.stringify(unsupportedCapability))).toEqual({
      capabilityId: 'terminal-resume',
      state: 'unsupported',
      reason: '当前 Runtime 未声明恢复能力'
    })
  })

  it('全部中性事件均可克隆和 JSON 往返，且不包含协议兜底字段', () => {
    const base = {
      runtimeId: 'grok' as const,
      runtimeSessionId: 'runtime-session-1',
      capabilityState: 'native' as const,
      taskId: 'task-1',
      turnId: 'turn-1',
      sequence: 1,
      observedAt: timestamp
    }
    const events: AgentEvent[] = [
      { ...base, kind: 'agent-message', text: '完成了', messageId: 'message-1' },
      { ...base, kind: 'agent-thought', text: '正在分析', messageId: 'thought-1' },
      {
        ...base,
        kind: 'tool-call',
        toolCallId: 'tool-1',
        title: '读取文件',
        status: 'in_progress'
      },
      { ...base, kind: 'tool-update', toolCallId: 'tool-1', status: 'completed' },
      {
        ...base,
        kind: 'plan',
        entries: [{ content: '建立契约', priority: 'high', status: 'completed' }]
      },
      {
        ...base,
        kind: 'diff',
        toolCallId: 'tool-1',
        diffs: [
          { format: 'snapshot', path: '/tmp/a.ts', before: null, after: 'export {}' },
          { format: 'unified', paths: ['/tmp/b.ts'], patch: '--- a\n+++ b' }
        ]
      },
      {
        ...base,
        kind: 'usage',
        capabilityState: 'experimental',
        usage: { scope: 'context', usedTokens: 120, limitTokens: 4096 }
      },
      {
        ...base,
        kind: 'turn-complete',
        outcome: 'completed',
        usage: { scope: 'turn', inputTokens: 80, outputTokens: 40, totalTokens: 120 }
      },
      { ...base, kind: 'error', message: '测试错误', recoverable: true, code: 'fake-error' }
    ]

    for (const event of events) expectSerializable(event)

    const serialized = JSON.stringify(events)
    for (const forbiddenKey of [
      'payload',
      'rawInput',
      'rawOutput',
      '_meta',
      'headers',
      'environment',
      'stack'
    ]) {
      expect(serialized).not.toContain(`"${forbiddenKey}"`)
    }
  })
})

function expectSerializable<T>(value: T): void {
  expect(structuredClone(value)).toEqual(value)
  expect(JSON.parse(JSON.stringify(value))).toEqual(value)
}
