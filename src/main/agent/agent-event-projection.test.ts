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
})
