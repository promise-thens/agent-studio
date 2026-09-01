import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../shared/agent'
import { projectPublicAgentEvent } from './agent-event-projection'

const BASE_EVENT = {
  runtimeId: 'grok' as const,
  capabilityState: 'native' as const,
  taskId: 'task-1',
  turnId: 'turn-1',
  sequence: 1,
  observedAt: '2026-08-18T00:00:00.000Z',
  runtimeSessionId: 'runtime-session-private'
}

describe('projectPublicAgentEvent', () => {
  it('逐字段投影文本事件并移除 Runtime 私有字段与未知字段', () => {
    const event = {
      ...BASE_EVENT,
      kind: 'agent-message',
      text: 'Bearer fake-secret',
      messageId: 'message-1',
      rawPayload: { authorization: 'fake-secret' }
    } as unknown as AgentEvent

    const projected = projectPublicAgentEvent(event, (text) =>
      text.replace('fake-secret', '[REDACTED]')
    )

    expect(projected).toEqual({
      runtimeId: 'grok',
      capabilityState: 'native',
      taskId: 'task-1',
      turnId: 'turn-1',
      sequence: 1,
      observedAt: '2026-08-18T00:00:00.000Z',
      kind: 'agent-message',
      text: 'Bearer [REDACTED]',
      messageId: 'message-1'
    })
    expect(JSON.stringify(projected)).not.toContain('runtime-session-private')
    expect(JSON.stringify(projected)).not.toContain('rawPayload')
  })

  it('附件事件只公开 inbox 引用并脱敏展示名称', () => {
    const event = {
      ...BASE_EVENT,
      kind: 'agent-attachment',
      attachmentId: 'attachment-1',
      attachmentKind: 'image',
      originalName: 'fake-secret.png',
      bytes: 'private-base64',
      uri: 'file:///private/image.png'
    } as unknown as AgentEvent

    const projected = projectPublicAgentEvent(event, (text) =>
      text.replace('fake-secret', '[REDACTED]')
    )

    expect(projected).toEqual({
      runtimeId: 'grok',
      capabilityState: 'native',
      taskId: 'task-1',
      turnId: 'turn-1',
      sequence: 1,
      observedAt: '2026-08-18T00:00:00.000Z',
      kind: 'agent-attachment',
      attachmentId: 'attachment-1',
      attachmentKind: 'image',
      originalName: '[REDACTED].png'
    })
    expect(JSON.stringify(projected)).not.toContain('runtime-session-private')
    expect(JSON.stringify(projected)).not.toContain('private-base64')
    expect(JSON.stringify(projected)).not.toContain('file:///')
  })

  it('Diff 只生成有限审阅摘要，不公开正文', () => {
    const event: AgentEvent = {
      ...BASE_EVENT,
      kind: 'diff',
      diffs: [
        {
          format: 'snapshot',
          path: 'src/example.ts',
          before: 'const secret = "before"',
          after: 'const secret = "after"'
        },
        {
          format: 'unified',
          paths: ['src/a.ts', 'src/b.ts'],
          patch: '@@ fake patch body @@'
        }
      ],
      toolCallId: 'tool-1'
    }

    const projected = projectPublicAgentEvent(event, (text) => text)

    expect(projected).toEqual({
      runtimeId: 'grok',
      capabilityState: 'native',
      taskId: 'task-1',
      turnId: 'turn-1',
      sequence: 1,
      observedAt: '2026-08-18T00:00:00.000Z',
      kind: 'diff',
      references: [
        {
          kind: 'diff-review',
          availability: 'unavailable',
          changedPathCount: 1,
          pathSummaries: ['src/example.ts'],
          reason: 'git-review-not-implemented'
        },
        {
          kind: 'diff-review',
          availability: 'unavailable',
          changedPathCount: 2,
          pathSummaries: ['src/a.ts', 'src/b.ts'],
          reason: 'git-review-not-implemented'
        }
      ],
      toolCallId: 'tool-1'
    })
    expect(JSON.stringify(projected)).not.toContain('before')
    expect(JSON.stringify(projected)).not.toContain('after')
    expect(JSON.stringify(projected)).not.toContain('fake patch body')
  })

  it('工具事件无 parentId 时形状不变，未知键与 parentToolCallId 丢弃', () => {
    const event = {
      ...BASE_EVENT,
      kind: 'tool-call',
      toolCallId: 'child-1',
      title: 'subagent 探查测试结构',
      status: 'in_progress',
      parentToolCallId: 'should-drop',
      rawInput: { apiKey: 'fake-secret' },
      _meta: { parent: 'x' }
    } as unknown as AgentEvent

    const projected = projectPublicAgentEvent(event, (text) =>
      text.replace('fake-secret', '[REDACTED]')
    )

    expect(projected).toEqual({
      runtimeId: 'grok',
      capabilityState: 'native',
      taskId: 'task-1',
      turnId: 'turn-1',
      sequence: 1,
      observedAt: '2026-08-18T00:00:00.000Z',
      kind: 'tool-call',
      toolCallId: 'child-1',
      title: 'subagent 探查测试结构',
      status: 'in_progress'
    })
    expect(projected).not.toHaveProperty('parentId')
    expect(JSON.stringify(projected)).not.toContain('runtime-session-private')
    expect(JSON.stringify(projected)).not.toContain('parentToolCallId')
    expect(JSON.stringify(projected)).not.toContain('rawInput')
  })

  it('白名单 parentId 脱敏限长后进入公开工具事件', () => {
    const event = {
      ...BASE_EVENT,
      kind: 'tool-update',
      toolCallId: 'child-1',
      title: '子 Agent 改登录逻辑',
      status: 'completed',
      parentId: `parent-fake-secret-${'中'.repeat(3_000)}`
    } as unknown as AgentEvent

    const projected = projectPublicAgentEvent(event, (text) =>
      text.replaceAll('fake-secret', '[REDACTED]')
    )

    expect(projected).toMatchObject({
      kind: 'tool-update',
      toolCallId: 'child-1',
      title: '子 Agent 改登录逻辑',
      status: 'completed'
    })
    if (projected.kind !== 'tool-update') throw new Error('预期得到 tool-update')
    expect(projected.parentId).toContain('parent-[REDACTED]-')
    expect(projected.parentId).not.toContain('fake-secret')
    expect(Buffer.byteLength(projected.parentId ?? '', 'utf8')).toBeLessThanOrEqual(4 * 1024)
    expect(JSON.stringify(projected)).not.toContain('runtime-session-private')
  })
})
