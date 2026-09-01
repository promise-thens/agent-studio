import { describe, expect, it } from 'vitest'
import { AgentEventNormalizer, type AgentEventDraft } from './event-normalizer'

const OBSERVED_AT = '2026-08-10T12:00:00.000Z'

describe('AgentEventNormalizer', () => {
  it('为已接受事件添加连续封套，被丢弃事件不占 sequence，重复文本不误删', () => {
    const normalizer = createNormalizer()
    const first = normalizer.normalize(messageDraft('重复文本'))
    const second = normalizer.normalize(messageDraft('重复文本'))
    const tool = normalizer.normalize(toolDraft('completed'))
    const duplicateTool = normalizer.normalize(toolDraft('completed'))
    const error = normalizer.normalize(errorDraft('继续验证'))

    expect(first).toMatchObject({
      taskId: 'task-1',
      turnId: 'turn-1',
      sequence: 1,
      observedAt: OBSERVED_AT,
      text: '重复文本'
    })
    expect(second).toMatchObject({ sequence: 2, text: '重复文本' })
    expect(tool).toMatchObject({ sequence: 3, status: 'completed' })
    expect(duplicateTool).toBeNull()
    expect(error).toMatchObject({ sequence: 4, kind: 'error' })
  })

  it('允许工具前进并拒绝终态回退和完全相同的 no-op', () => {
    const normalizer = createNormalizer()

    expect(normalizer.normalize(toolDraft('pending'))).toMatchObject({ sequence: 1 })
    expect(normalizer.normalize(toolDraft('in_progress'))).toMatchObject({ sequence: 2 })
    expect(normalizer.normalize(toolDraft('completed'))).toMatchObject({ sequence: 3 })
    expect(normalizer.normalize(toolDraft('in_progress'))).toBeNull()
    expect(normalizer.normalize(toolDraft('failed'))).toBeNull()
    expect(normalizer.normalize(errorDraft('状态回退已忽略'))).toMatchObject({ sequence: 4 })
  })

  it('普通错误不锁定 Turn，首个终态后拒绝全部晚到事件', () => {
    const normalizer = createNormalizer()

    expect(normalizer.normalize(errorDraft('可恢复错误'))).toMatchObject({ sequence: 1 })
    expect(normalizer.normalize(messageDraft('错误后仍可继续'))).toMatchObject({ sequence: 2 })
    expect(normalizer.normalize(turnCompleteDraft('completed'))).toMatchObject({ sequence: 3 })
    expect(normalizer.normalize(turnCompleteDraft('failed'))).toBeNull()
    expect(normalizer.normalize(messageDraft('晚到文本'))).toBeNull()
  })

  it('按 UTF-8 bytes 截断中文和 emoji，并剥离草稿中的未知字段', () => {
    const normalizer = createNormalizer()
    const draft = {
      ...messageDraft('你好😀'.repeat(30_000)),
      rawInput: { apiKey: 'fake-secret' },
      stack: 'fake-stack'
    } as unknown as AgentEventDraft

    const event = normalizer.normalize(draft)

    expect(event).toMatchObject({ kind: 'agent-message', truncated: true })
    if (event?.kind !== 'agent-message') throw new Error('预期得到文本事件')
    expect(Buffer.byteLength(event.text, 'utf8')).toBeLessThanOrEqual(64 * 1024)
    expect(event.text.endsWith('\uFFFD')).toBe(false)
    expect(JSON.stringify(event)).not.toContain('rawInput')
    expect(JSON.stringify(event)).not.toContain('fake-stack')
  })

  it('附件事件只保留 inbox 引用并限制展示名称', () => {
    const normalizer = createNormalizer()
    const event = normalizer.normalize({
      ...draftBase(),
      kind: 'agent-attachment',
      attachmentId: 'attachment-1',
      attachmentKind: 'image',
      originalName: '图'.repeat(5_000),
      bytes: 'private-base64',
      uri: 'file:///private/image.png'
    } as unknown as AgentEventDraft)

    expect(event).toMatchObject({
      kind: 'agent-attachment',
      attachmentId: 'attachment-1',
      attachmentKind: 'image',
      truncated: true
    })
    if (event?.kind !== 'agent-attachment') throw new Error('预期得到附件事件')
    expect(Buffer.byteLength(event.originalName, 'utf8')).toBeLessThanOrEqual(4 * 1024)
    expect(JSON.stringify(event)).not.toContain('private-base64')
    expect(JSON.stringify(event)).not.toContain('file:///')
  })

  it('限制 Plan 数量与正文，并限制 Diff 数量和共享正文预算', () => {
    const planNormalizer = createNormalizer()
    const plan = planNormalizer.normalize({
      ...draftBase(),
      kind: 'plan',
      entries: Array.from({ length: 105 }, (_, index) => ({
        content: `步骤 ${index} ${'中'.repeat(2_000)}`,
        priority: 'medium' as const,
        status: 'pending' as const
      }))
    })

    expect(plan).toMatchObject({ kind: 'plan', truncated: true })
    if (plan?.kind !== 'plan') throw new Error('预期得到计划事件')
    expect(plan.entries).toHaveLength(100)
    expect(
      plan.entries.every((entry) => Buffer.byteLength(entry.content, 'utf8') <= 2 * 1024)
    ).toBe(true)

    const diffNormalizer = createNormalizer()
    const diff = diffNormalizer.normalize({
      ...draftBase(),
      kind: 'diff',
      diffs: Array.from({ length: 25 }, (_, index) => ({
        format: 'snapshot' as const,
        path: `/tmp/file-${index}.ts`,
        before: 'a'.repeat(20_000),
        after: 'b'.repeat(20_000)
      }))
    })

    expect(diff).toMatchObject({ kind: 'diff', truncated: true })
    if (diff?.kind !== 'diff') throw new Error('预期得到 Diff 事件')
    expect(diff.diffs).toHaveLength(20)
    const bodyBytes = diff.diffs.reduce((total, item) => {
      if (item.format === 'unified') return total + Buffer.byteLength(item.patch, 'utf8')
      return (
        total + Buffer.byteLength(item.before ?? '', 'utf8') + Buffer.byteLength(item.after, 'utf8')
      )
    }, 0)
    expect(bodyBytes).toBeLessThanOrEqual(192 * 1024)
  })

  it('整体序列化仍超限时替换为不携带原载荷的安全错误', () => {
    const normalizer = createNormalizer()
    const event = normalizer.normalize({
      ...draftBase(),
      kind: 'usage',
      usage: {
        scope: 'context',
        usedTokens: 1,
        limitTokens: 2,
        cost: { amount: 0, currency: 'X'.repeat(300_000) }
      }
    })

    expect(event).toEqual({
      ...draftBase(),
      taskId: 'task-1',
      turnId: 'turn-1',
      sequence: 1,
      observedAt: OBSERVED_AT,
      truncated: true,
      kind: 'error',
      message: '事件内容过大，已安全省略。',
      recoverable: true,
      code: 'event-payload-too-large'
    })
    expect(JSON.stringify(event)).not.toContain('X'.repeat(1_000))
  })

  it('输出可 structuredClone 和 JSON 往返', () => {
    const event = createNormalizer().normalize(messageDraft('安全事件'))
    expect(event).not.toBeNull()
    expect(structuredClone(event)).toEqual(event)
    expect(JSON.parse(JSON.stringify(event))).toEqual(event)
  })

  it('无 parentId 的工具事件形状不变，标题含 subagent 不得发明父子关系', () => {
    const event = createNormalizer().normalize({
      ...draftBase(),
      kind: 'tool-call',
      toolCallId: 'tool-1',
      title: 'subagent 探查测试结构',
      status: 'in_progress'
    })

    expect(event).toEqual({
      ...draftBase(),
      taskId: 'task-1',
      turnId: 'turn-1',
      sequence: 1,
      observedAt: OBSERVED_AT,
      kind: 'tool-call',
      toolCallId: 'tool-1',
      title: 'subagent 探查测试结构',
      status: 'in_progress'
    })
    expect(event).not.toHaveProperty('parentId')
  })

  it('工具草稿未知键必须丢掉，白名单 parentId 经短文本限长后保留', () => {
    const longParent = `parent-${'中'.repeat(3_000)}`
    const event = createNormalizer().normalize({
      ...draftBase(),
      kind: 'tool-call',
      toolCallId: 'child-1',
      title: '子 Agent 改登录逻辑',
      status: 'in_progress',
      parentId: longParent,
      parentToolCallId: 'should-drop',
      rawInput: { apiKey: 'fake-secret' },
      _meta: { parentToolCallId: 'meta-parent' }
    } as unknown as AgentEventDraft)

    expect(event).toMatchObject({
      kind: 'tool-call',
      toolCallId: 'child-1',
      title: '子 Agent 改登录逻辑',
      status: 'in_progress',
      truncated: true
    })
    if (event?.kind !== 'tool-call') throw new Error('预期得到 tool-call')
    expect(event.parentId).toBeDefined()
    expect(event.parentId?.startsWith('parent-')).toBe(true)
    expect(Buffer.byteLength(event.parentId ?? '', 'utf8')).toBeLessThanOrEqual(4 * 1024)
    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain('parentToolCallId')
    expect(serialized).not.toContain('rawInput')
    expect(serialized).not.toContain('fake-secret')
    expect(serialized).not.toContain('_meta')
  })

  it('tool-update 同样只拷贝白名单 parentId，不把协议键透传出去', () => {
    const event = createNormalizer().normalize({
      ...draftBase(),
      kind: 'tool-update',
      toolCallId: 'child-1',
      status: 'completed',
      parentId: 'parent-tool-1',
      parentToolCallId: 'drop-me'
    } as unknown as AgentEventDraft)

    expect(event).toMatchObject({
      kind: 'tool-update',
      toolCallId: 'child-1',
      status: 'completed',
      parentId: 'parent-tool-1'
    })
    expect(JSON.stringify(event)).not.toContain('parentToolCallId')
  })
})

function createNormalizer(): AgentEventNormalizer {
  return new AgentEventNormalizer({
    taskId: 'task-1',
    turnId: 'turn-1',
    now: () => OBSERVED_AT
  })
}

function draftBase(): AgentEventDraftBaseForTest {
  return {
    runtimeId: 'grok',
    runtimeSessionId: 'runtime-session-1',
    capabilityState: 'native'
  }
}

function messageDraft(text: string): AgentEventDraft {
  return { ...draftBase(), kind: 'agent-message', text, messageId: 'message-1' }
}

function toolDraft(status: 'pending' | 'in_progress' | 'completed' | 'failed'): AgentEventDraft {
  return {
    ...draftBase(),
    kind: 'tool-update',
    toolCallId: 'tool-1',
    title: '执行测试',
    status
  }
}

function errorDraft(message: string): AgentEventDraft {
  return { ...draftBase(), kind: 'error', message, recoverable: true, code: 'fake-error' }
}

function turnCompleteDraft(outcome: 'completed' | 'failed'): AgentEventDraft {
  return { ...draftBase(), kind: 'turn-complete', outcome }
}

type AgentEventDraftBaseForTest = Pick<
  AgentEventDraft,
  'runtimeId' | 'runtimeSessionId' | 'capabilityState'
>
