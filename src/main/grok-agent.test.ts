import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentPermissionRequest } from '../shared/agent'
import { AgentEventNormalizer, type AgentEventDraft } from './agent/event-normalizer'
import {
  GrokAgentBridge,
  mapGrokPermissionRequest,
  mapGrokPromptResponse,
  mapGrokSessionUpdate
} from './grok-agent'

const FAKE_SECRET = 'fake-test-secret'

describe('Grok ACP 中性领域映射', () => {
  it('映射文本、计划与上下文 Usage，并剥离协议扩展字段', () => {
    expect(
      mapUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `你好 ${FAKE_SECRET}`,
          _meta: { secret: FAKE_SECRET }
        },
        messageId: 'message-1',
        _meta: { secret: FAKE_SECRET }
      })
    ).toEqual([
      {
        runtimeId: 'grok',
        runtimeSessionId: 'runtime-session-1',
        capabilityState: 'native',
        kind: 'agent-message',
        text: '你好 [REDACTED]',
        messageId: 'message-1'
      }
    ])

    expect(
      mapUpdate({
        sessionUpdate: 'plan',
        entries: [
          {
            content: '完成领域契约',
            priority: 'high',
            status: 'in_progress',
            _meta: { secret: FAKE_SECRET }
          }
        ],
        _meta: { secret: FAKE_SECRET }
      })
    ).toEqual([
      {
        runtimeId: 'grok',
        runtimeSessionId: 'runtime-session-1',
        capabilityState: 'native',
        kind: 'plan',
        entries: [{ content: '完成领域契约', priority: 'high', status: 'in_progress' }]
      }
    ])

    expect(
      mapUpdate({
        sessionUpdate: 'usage_update',
        used: 120,
        size: 4096,
        cost: { amount: 0.01, currency: 'USD', _meta: { secret: FAKE_SECRET } },
        _meta: { secret: FAKE_SECRET }
      })
    ).toEqual([
      {
        runtimeId: 'grok',
        runtimeSessionId: 'runtime-session-1',
        capabilityState: 'experimental',
        kind: 'usage',
        usage: {
          scope: 'context',
          usedTokens: 120,
          limitTokens: 4096,
          cost: { amount: 0.01, currency: 'USD' }
        }
      }
    ])
  })

  it('工具事件只保留展示字段，并把 Diff 显式投影为中性结构', () => {
    const events = mapUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: '修改测试文件',
      status: 'in_progress',
      rawInput: { apiKey: FAKE_SECRET },
      rawOutput: { authorization: `Bearer ${FAKE_SECRET}` },
      content: [
        {
          type: 'diff',
          path: '/tmp/test.ts',
          oldText: 'before',
          newText: `after ${FAKE_SECRET}`,
          _meta: { secret: FAKE_SECRET }
        }
      ],
      _meta: { secret: FAKE_SECRET }
    })

    expect(events).toEqual([
      {
        runtimeId: 'grok',
        runtimeSessionId: 'runtime-session-1',
        capabilityState: 'native',
        kind: 'tool-call',
        toolCallId: 'tool-1',
        title: '修改测试文件',
        status: 'in_progress'
      },
      {
        runtimeId: 'grok',
        runtimeSessionId: 'runtime-session-1',
        capabilityState: 'native',
        kind: 'diff',
        toolCallId: 'tool-1',
        diffs: [
          {
            format: 'snapshot',
            path: '/tmp/test.ts',
            before: 'before',
            after: 'after [REDACTED]'
          }
        ]
      }
    ])

    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(FAKE_SECRET)
    expect(serialized).not.toContain('rawInput')
    expect(serialized).not.toContain('rawOutput')
    expect(serialized).not.toContain('_meta')
  })

  it('权限请求逐字段复制，不把工具和选项的 _meta 送入 Renderer', () => {
    const request = mapGrokPermissionRequest(
      {
        sessionId: 'runtime-session-1',
        toolCall: {
          toolCallId: 'tool-1',
          title: `执行测试命令 ${FAKE_SECRET}`,
          rawInput: { apiKey: FAKE_SECRET },
          _meta: { secret: FAKE_SECRET }
        },
        options: [
          {
            optionId: 'allow-once',
            name: `允许一次 ${FAKE_SECRET}`,
            kind: 'allow_once',
            _meta: { secret: FAKE_SECRET }
          }
        ],
        _meta: { secret: FAKE_SECRET }
      },
      'permission-1',
      'task-1',
      'turn-1',
      redactFakeText
    )

    expect(request).toEqual({
      id: 'permission-1',
      runtimeId: 'grok',
      taskId: 'task-1',
      turnId: 'turn-1',
      runtimeSessionId: 'runtime-session-1',
      toolCallId: 'tool-1',
      title: '执行测试命令 [REDACTED]',
      options: [{ optionId: 'allow-once', name: '允许一次 [REDACTED]', kind: 'allow_once' }]
    })
    expect(JSON.stringify(request)).not.toContain(FAKE_SECRET)
    expect(JSON.stringify(request)).not.toContain('_meta')
  })

  it('权限展示文案按 UTF-8 bytes 截断，整体超限时安全拒绝', () => {
    const truncated = mapGrokPermissionRequest(
      permissionRequest({ title: '你好😀'.repeat(2_000), optionId: 'allow-once' }),
      'permission-1',
      'task-1',
      'turn-1',
      redactFakeText
    )

    expect(truncated).not.toBeNull()
    if (!truncated) throw new Error('预期得到有限权限请求')
    expect(truncated.truncated).toBe(true)
    expect(Buffer.byteLength(truncated.title, 'utf8')).toBeLessThanOrEqual(4 * 1024)
    expect(truncated.title.endsWith('\uFFFD')).toBe(false)

    expect(
      mapGrokPermissionRequest(
        permissionRequest({ optionId: 'x'.repeat(300_000) }),
        'permission-2',
        'task-1',
        'turn-1',
        redactFakeText
      )
    ).toBeNull()
  })

  it('PromptResponse 只保留中性终态和显式 Usage 数值', () => {
    const event = mapGrokPromptResponse(
      {
        stopReason: 'max_tokens',
        usage: {
          inputTokens: 80,
          outputTokens: 40,
          totalTokens: 120,
          thoughtTokens: 10,
          cachedReadTokens: 5,
          cachedWriteTokens: 3,
          _meta: { secret: FAKE_SECRET }
        },
        _meta: { secret: FAKE_SECRET }
      },
      'runtime-session-1'
    )

    expect(event).toEqual({
      runtimeId: 'grok',
      runtimeSessionId: 'runtime-session-1',
      capabilityState: 'native',
      kind: 'turn-complete',
      outcome: 'limit-reached',
      usage: {
        scope: 'turn',
        inputTokens: 80,
        outputTokens: 40,
        totalTokens: 120,
        thoughtTokens: 10,
        cachedReadTokens: 5,
        cachedWriteTokens: 3
      }
    })
    expect(JSON.stringify(event)).not.toContain(FAKE_SECRET)
    expect(JSON.stringify(event)).not.toContain('_meta')
  })

  it.each([
    ['end_turn', 'completed'],
    ['cancelled', 'cancelled'],
    ['refusal', 'refused'],
    ['max_tokens', 'limit-reached'],
    ['max_turn_requests', 'limit-reached']
  ] as const)('把 ACP stopReason %s 映射为中性终态 %s', (stopReason, outcome) => {
    expect(mapGrokPromptResponse({ stopReason }, 'runtime-session-1').outcome).toBe(outcome)
  })

  it('未支持内容与当前 schema 已知忽略项不伪造领域结果', () => {
    expect(
      mapUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: FAKE_SECRET, mimeType: 'image/png' }
      })
    ).toEqual([])

    expect(
      mapUpdate({
        sessionUpdate: 'plan_removed',
        planId: 'plan-1'
      })
    ).toEqual([])
  })

  it('测试构造的未知 ACP update 只生成不含原载荷的安全提示', () => {
    expect(
      mapGrokSessionUpdate(
        {
          sessionId: 'runtime-session-1',
          update: {
            sessionUpdate: 'future_update',
            rawInput: FAKE_SECRET,
            _meta: { secret: FAKE_SECRET }
          }
        } as unknown as acp.SessionNotification,
        redactFakeText
      )
    ).toEqual([
      {
        runtimeId: 'grok',
        runtimeSessionId: 'runtime-session-1',
        capabilityState: 'unsupported',
        kind: 'error',
        message: '收到当前版本暂不支持的 Runtime 事件，已安全忽略。',
        recoverable: true,
        code: 'unsupported-runtime-event'
      }
    ])
  })
})

describe('GrokAgentBridge Turn 生命周期', () => {
  it('首个终态统一取消当前 Turn 权限，并拒绝重复终态', () => {
    const harness = createBridgeHarness()
    let permissionResponse: acp.RequestPermissionResponse | undefined
    harness.internal.pendingPermissions.set('permission-1', {
      turnId: harness.activeTurn.turnId,
      optionIds: new Set(['allow-once']),
      resolve: (response) => {
        permissionResponse = response
      }
    })

    harness.internal.emitDraft(harness.activeTurn, turnCompleteDraft('completed'))
    harness.internal.emitDraft(harness.activeTurn, turnCompleteDraft('failed'))

    expect(permissionResponse).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(harness.internal.pendingPermissions.size).toBe(0)
    expect(harness.internal.activeTurn).toBeNull()
    expect(harness.events).toHaveLength(1)
    expect(harness.events[0]).toMatchObject({ kind: 'turn-complete', outcome: 'completed' })
  })

  it('取消后继续接收最终工具更新，并由 Runtime 终态结束 Turn', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const connection = { cancel } as unknown as acp.ClientSideConnection
    const harness = createBridgeHarness(connection)

    await harness.bridge.cancel()
    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'failed'
      }),
      connection
    )
    harness.internal.emitDraft(harness.activeTurn, turnCompleteDraft('cancelled'))

    expect(cancel).toHaveBeenCalledWith({ sessionId: 'runtime-session-1' })
    expect(harness.events.map((event) => event.kind)).toEqual(['tool-update', 'turn-complete'])
    expect(harness.internal.activeTurn).toBeNull()
  })

  it('旧连接和旧 session 的更新不会进入当前 Turn', () => {
    const harness = createBridgeHarness()
    const oldConnection = {} as acp.ClientSideConnection

    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '旧连接事件' }
      }),
      oldConnection
    )
    harness.internal.handleSessionUpdate(
      {
        sessionId: 'old-runtime-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '旧 session 事件' }
        }
      },
      harness.connection
    )
    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '当前事件' }
      }),
      harness.connection
    )

    expect(harness.events).toHaveLength(1)
    expect(harness.events[0]).toMatchObject({ kind: 'agent-message', text: '当前事件' })
  })

  it('超限权限不进入 Renderer，并生成有限的可恢复错误', async () => {
    const harness = createBridgeHarness()

    const response = await harness.internal.requestPermission(
      permissionRequest({ optionId: 'x'.repeat(300_000) }),
      harness.connection
    )

    expect(response).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(harness.permissions).toHaveLength(0)
    expect(harness.internal.pendingPermissions.size).toBe(0)
    expect(harness.events[0]).toMatchObject({
      kind: 'error',
      recoverable: true,
      code: 'permission-payload-too-large'
    })
    expect(Buffer.byteLength(JSON.stringify(harness.events[0]), 'utf8')).toBeLessThan(256 * 1024)
  })

  it('Prompt reject 形成唯一不可恢复失败终态', async () => {
    const prompt = vi.fn().mockRejectedValue(new Error(`连接中断 ${FAKE_SECRET}`))
    const connection = { prompt } as unknown as acp.ClientSideConnection
    const harness = createBridgeHarness(connection, false)

    await harness.bridge.sendPrompt('执行测试')

    expect(harness.events).toHaveLength(2)
    expect(harness.events[0]).toMatchObject({
      kind: 'error',
      message: '执行失败：连接中断 [REDACTED]',
      recoverable: false,
      code: 'prompt-failed'
    })
    expect(harness.events[1]).toMatchObject({ kind: 'turn-complete', outcome: 'failed' })
    expect(harness.internal.activeTurn).toBeNull()
  })
})

function notification(update: acp.SessionUpdate): acp.SessionNotification {
  return { sessionId: 'runtime-session-1', update }
}

function mapUpdate(update: acp.SessionUpdate): ReturnType<typeof mapGrokSessionUpdate> {
  return mapGrokSessionUpdate(notification(update), redactFakeText)
}

function redactFakeText(text: string): string {
  return text.replaceAll(FAKE_SECRET, '[REDACTED]')
}

function permissionRequest({
  title = '执行测试命令',
  optionId
}: {
  title?: string
  optionId: string
}): acp.RequestPermissionRequest {
  return {
    sessionId: 'runtime-session-1',
    toolCall: {
      toolCallId: 'tool-1',
      title
    },
    options: [{ optionId, name: '允许一次', kind: 'allow_once' }]
  }
}

function turnCompleteDraft(outcome: 'completed' | 'cancelled' | 'failed'): AgentEventDraft {
  return {
    runtimeId: 'grok',
    runtimeSessionId: 'runtime-session-1',
    capabilityState: 'native',
    kind: 'turn-complete',
    outcome
  }
}

interface TestActiveTurn {
  taskId: string
  turnId: string
  runtimeSessionId: string
  connection: acp.ClientSideConnection
  normalizer: AgentEventNormalizer
  cancelRequested: boolean
}

interface TestPendingPermission {
  turnId: string
  optionIds: Set<string>
  resolve: (response: acp.RequestPermissionResponse) => void
}

interface GrokAgentBridgeTestAccess {
  connection: acp.ClientSideConnection | null
  sessionId: string | null
  activeTurn: TestActiveTurn | null
  pendingPermissions: Map<string, TestPendingPermission>
  emitDraft: (activeTurn: TestActiveTurn, draft: AgentEventDraft) => void
  handleSessionUpdate: (
    params: acp.SessionNotification,
    sourceConnection: acp.ClientSideConnection
  ) => void
  requestPermission: (
    params: acp.RequestPermissionRequest,
    sourceConnection: acp.ClientSideConnection
  ) => Promise<acp.RequestPermissionResponse>
}

/** 构造不启动子进程的 Bridge 测试夹具，只验证 Turn 身份门禁和终态清理。 */
function createBridgeHarness(
  connection: acp.ClientSideConnection = {} as acp.ClientSideConnection,
  createActiveTurn = true
): {
  bridge: GrokAgentBridge
  internal: GrokAgentBridgeTestAccess
  connection: acp.ClientSideConnection
  activeTurn: TestActiveTurn
  events: AgentEvent[]
  permissions: AgentPermissionRequest[]
} {
  const events: AgentEvent[] = []
  const permissions: AgentPermissionRequest[] = []
  const bridge = new GrokAgentBridge(
    () => undefined,
    (event) => events.push(event),
    (request) => permissions.push(request),
    {
      userDataPath: '/tmp/agent-studio-test',
      getProviderConfig: () => null,
      redactText: redactFakeText
    }
  )
  const internal = bridge as unknown as GrokAgentBridgeTestAccess
  const activeTurn: TestActiveTurn = {
    taskId: 'task-1',
    turnId: 'turn-1',
    runtimeSessionId: 'runtime-session-1',
    connection,
    normalizer: new AgentEventNormalizer({ taskId: 'task-1', turnId: 'turn-1' }),
    cancelRequested: false
  }
  internal.connection = connection
  internal.sessionId = activeTurn.runtimeSessionId
  internal.activeTurn = createActiveTurn ? activeTurn : null

  return { bridge, internal, connection, activeTurn, events, permissions }
}
