import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  AgentCapability,
  AgentCapabilityId,
  AgentCapabilityState,
  AgentContextUsage,
  AgentEvent,
  AgentPermissionRequest,
  AgentRuntimeCapabilitySnapshot,
  AgentRuntimeStatus,
  AgentSessionSummary,
  AgentTaskSummary,
  AgentTurnSummary,
  AgentTurnUsage,
  AgentUsage
} from './agent'
import { AGENT_CAPABILITY_IDS } from './agent'

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
      approvalId: 'permission-1',
      initiator: 'runtime',
      runtimeId: 'grok',
      taskId: 'task-1',
      turnId: 'turn-1',
      projectId: 'project-1',
      environmentId: 'local:environment-1',
      operationType: 'read-project',
      risk: 'L0',
      title: '允许读取测试目录吗？',
      impact: '读取当前 Project 的有限元信息。',
      targets: ['project: project-1'],
      allowedScopes: ['once'],
      expiresAt: timestamp,
      truncated: true
    }

    for (const value of [runtimeStatus, task, session, turn, permission]) {
      expectSerializable(value)
    }
  })

  it('Usage 使用非空判别联合，并保持事件能力成熟度与 Runtime 能力矩阵相互独立', () => {
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
      capabilityId: 'session.resume',
      support: 'unsupported',
      verification: 'declared',
      source: 'protocol',
      reason: '当前 Runtime 未声明恢复能力'
    }

    expectTypeOf<AgentUsage>().toEqualTypeOf<AgentContextUsage | AgentTurnUsage>()
    expectTypeOf<AgentCapabilityId>().toEqualTypeOf<(typeof AGENT_CAPABILITY_IDS)[number]>()
    expect(capabilityState).toBe('unsupported')
    expectSerializable(contextUsage)
    expectSerializable(turnUsage)
    expectSerializable(unsupportedCapability)
    expect(JSON.parse(JSON.stringify(unsupportedCapability))).toEqual({
      capabilityId: 'session.resume',
      support: 'unsupported',
      verification: 'declared',
      source: 'protocol',
      reason: '当前 Runtime 未声明恢复能力'
    })
  })

  it('固定能力 ID 完整且唯一，完整快照可克隆和 JSON 往返', () => {
    expect(AGENT_CAPABILITY_IDS).toHaveLength(14)
    expect(new Set(AGENT_CAPABILITY_IDS).size).toBe(AGENT_CAPABILITY_IDS.length)

    const capabilities = Object.fromEntries(
      AGENT_CAPABILITY_IDS.map((capabilityId) => [
        capabilityId,
        {
          capabilityId,
          support: 'unknown',
          verification: 'unverified',
          source: 'fallback',
          reason: '当前 Runtime 尚未验证此能力'
        }
      ])
    ) as AgentRuntimeCapabilitySnapshot['capabilities']
    const snapshot: AgentRuntimeCapabilitySnapshot = {
      runtimeId: 'grok',
      runtimeVersion: '1.2.3',
      protocolVersion: '1',
      observedAt: timestamp,
      capabilities
    }

    expect(Object.keys(snapshot.capabilities)).toEqual(AGENT_CAPABILITY_IDS)
    expectSerializable(snapshot)
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
