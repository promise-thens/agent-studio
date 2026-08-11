import * as acp from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentCapabilityId,
  AgentCapabilityMaturity,
  AgentEvent,
  AgentPermissionRequest,
  AgentRuntimeCapabilitySnapshot,
  AgentRuntimeStatus
} from '../shared/agent'
import { AgentEventNormalizer, type AgentEventDraft } from './agent/event-normalizer'
import {
  GrokAgentBridge,
  mapGrokInitializeCapabilitySnapshot,
  mapGrokPermissionRequest,
  mapGrokPromptResponse,
  mapGrokSessionUpdate
} from './grok-agent'

const FAKE_SECRET = 'fake-test-secret'

describe('Grok ACP 中性领域映射', () => {
  it('initialize 只投影标准版本与 load/resume 能力，不透传协议扩展字段', () => {
    const baseline = createBridgeHarness().bridge.getStatus().capabilitySnapshot!
    const snapshot = mapGrokInitializeCapabilitySnapshot(
      baseline,
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {} },
          providers: { secret: FAKE_SECRET },
          _meta: { instanceId: FAKE_SECRET }
        },
        agentInfo: {
          name: 'grok-build',
          version: '1.2.3',
          _meta: { agentVersion: FAKE_SECRET }
        },
        authMethods: [{ id: FAKE_SECRET, name: FAKE_SECRET }],
        _meta: {
          agentVersion: FAKE_SECRET,
          modelState: FAKE_SECRET,
          deviceId: FAKE_SECRET
        }
      } as unknown as acp.InitializeResponse,
      redactFakeText
    )

    expect(snapshot.runtimeVersion).toBe('1.2.3')
    expect(snapshot.protocolVersion).toBe(String(acp.PROTOCOL_VERSION))
    expect(snapshot.capabilities['session.load']).toMatchObject({
      support: 'native',
      maturity: 'stable',
      verification: 'declared',
      source: 'protocol'
    })
    expect(snapshot.capabilities['session.resume']).toMatchObject({
      support: 'native',
      maturity: 'stable',
      verification: 'declared',
      source: 'protocol'
    })

    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain(FAKE_SECRET)
    expect(serialized).not.toContain('_meta')
    expect(serialized).not.toContain('authMethods')
    expect(serialized).not.toContain('providers')
    expect(serialized).not.toContain('instanceId')
  })

  it('initialize 未声明 load/resume 时记录协议负证据，agentInfo 缺失时不编造版本', () => {
    const baseline = createBridgeHarness().bridge.getStatus().capabilitySnapshot!
    const snapshot = mapGrokInitializeCapabilitySnapshot(
      baseline,
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {}
      },
      redactFakeText
    )

    expect(snapshot.runtimeVersion).toBeUndefined()
    expect(snapshot.capabilities['session.load']).toMatchObject({
      support: 'unsupported',
      verification: 'declared',
      source: 'protocol'
    })
    expect(snapshot.capabilities['session.load'].maturity).toBeUndefined()
    expect(snapshot.capabilities['session.resume']).toMatchObject({
      support: 'unsupported',
      verification: 'declared',
      source: 'protocol'
    })
    expect(snapshot.capabilities['session.resume'].maturity).toBeUndefined()
  })

  it('initialize 返回不兼容协议版本时立即拒绝', () => {
    const baseline = createBridgeHarness().bridge.getStatus().capabilitySnapshot!

    expect(() =>
      mapGrokInitializeCapabilitySnapshot(
        baseline,
        { protocolVersion: acp.PROTOCOL_VERSION + 1, agentCapabilities: {} },
        redactFakeText
      )
    ).toThrow('ACP 协议版本不兼容')
  })

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
  it('初始与断开状态始终携带静态能力矩阵，并清除旧握手版本和运行验证', async () => {
    const harness = createBridgeHarness()
    const initialSnapshot = harness.bridge.getStatus().capabilitySnapshot!

    expect(initialSnapshot.capabilities['session.load']).toMatchObject({
      support: 'unknown',
      verification: 'unverified',
      source: 'fallback'
    })
    harness.internal.capabilitySnapshot = mapGrokInitializeCapabilitySnapshot(
      initialSnapshot,
      initializeResponse({ loadSession: true, resume: true, runtimeVersion: '1.2.3' }),
      redactFakeText
    )
    harness.internal.verifyCapability('event.agent-message', 'stable', undefined, false)

    await harness.bridge.disconnect()

    const disconnected = harness.bridge.getStatus()
    expect(disconnected.state).toBe('idle')
    expect(disconnected.capabilitySnapshot?.runtimeVersion).toBeUndefined()
    expect(disconnected.capabilitySnapshot?.protocolVersion).toBeUndefined()
    expect(disconnected.capabilitySnapshot?.capabilities['event.agent-message']).toMatchObject({
      verification: 'declared',
      source: 'static'
    })
    expect(disconnected.capabilitySnapshot?.capabilities['session.load']).toMatchObject({
      support: 'unknown',
      verification: 'unverified',
      source: 'fallback'
    })
  })

  it('协议版本不匹配时不会创建 Runtime session', async () => {
    const initialize = vi.fn().mockResolvedValue({
      protocolVersion: acp.PROTOCOL_VERSION + 1,
      agentCapabilities: {}
    })
    const newSession = vi.fn()
    const connection = { initialize, newSession } as unknown as acp.ClientSideConnection
    const harness = createBridgeHarness(connection, false)
    const child = {} as ChildProcessWithoutNullStreams
    harness.internal.process = child

    await expect(
      harness.internal.initializeRuntimeSession(connection, child, '/tmp/workspace')
    ).rejects.toThrow('ACP 协议版本不兼容')
    expect(newSession).not.toHaveBeenCalled()
  })

  it('握手与新会话成功后保存标准摘要，并验证连接和会话创建能力', async () => {
    const initialize = vi
      .fn()
      .mockResolvedValue(
        initializeResponse({ loadSession: true, resume: true, runtimeVersion: '1.2.3' })
      )
    const newSession = vi.fn().mockResolvedValue({ sessionId: 'runtime-session-2' })
    const connection = { initialize, newSession } as unknown as acp.ClientSideConnection
    const harness = createBridgeHarness(connection, false)
    const child = {} as ChildProcessWithoutNullStreams
    harness.internal.process = child

    await expect(
      harness.internal.initializeRuntimeSession(connection, child, '/tmp/workspace')
    ).resolves.toBe('runtime-session-2')
    expect(newSession).toHaveBeenCalledWith({ cwd: '/tmp/workspace', mcpServers: [] })
    expect(harness.internal.capabilitySnapshot).toMatchObject({
      runtimeVersion: '1.2.3',
      protocolVersion: String(acp.PROTOCOL_VERSION)
    })
    expect(harness.internal.capabilitySnapshot.capabilities['runtime.connect']).toMatchObject({
      verification: 'verified',
      source: 'runtime'
    })
    expect(harness.internal.capabilitySnapshot.capabilities['session.create']).toMatchObject({
      verification: 'verified',
      source: 'runtime'
    })
  })

  it('旧连接晚到的 initialize 结果不能覆盖新连接或继续创建 session', async () => {
    let resolveInitialize: ((response: acp.InitializeResponse) => void) | undefined
    const initialize = vi.fn().mockImplementation(
      () =>
        new Promise<acp.InitializeResponse>((resolve) => {
          resolveInitialize = resolve
        })
    )
    const newSession = vi.fn()
    const oldConnection = { initialize, newSession } as unknown as acp.ClientSideConnection
    const harness = createBridgeHarness(oldConnection, false)
    const oldChild = {} as ChildProcessWithoutNullStreams
    harness.internal.process = oldChild
    const oldSnapshot = harness.internal.capabilitySnapshot

    const initialization = harness.internal.initializeRuntimeSession(
      oldConnection,
      oldChild,
      '/tmp/workspace'
    )
    harness.internal.connection = {} as acp.ClientSideConnection
    resolveInitialize?.(initializeResponse({ loadSession: true, resume: true }))

    await expect(initialization).resolves.toBeNull()
    expect(newSession).not.toHaveBeenCalled()
    expect(harness.internal.capabilitySnapshot).toBe(oldSnapshot)
  })

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
    expect(
      harness.bridge.getStatus().capabilitySnapshot?.capabilities['session.cancel']
    ).toMatchObject({
      verification: 'verified',
      source: 'runtime'
    })
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
    expect(
      harness.bridge.getStatus().capabilitySnapshot?.capabilities['event.agent-message']
    ).toMatchObject({ verification: 'verified', source: 'runtime' })
  })

  it('思考、计划、工具、Diff 与 Context Usage 首次到达后提升对应能力', () => {
    const harness = createBridgeHarness()

    for (const update of [
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: '正在分析' }
      },
      {
        sessionUpdate: 'plan',
        entries: [{ content: '执行测试', priority: 'high', status: 'in_progress' }]
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: '修改文件',
        content: [{ type: 'diff', path: '/tmp/test.ts', oldText: null, newText: 'after' }]
      },
      {
        sessionUpdate: 'usage_update',
        used: 120,
        size: 4096
      }
    ] satisfies acp.SessionUpdate[]) {
      harness.internal.handleSessionUpdate(notification(update), harness.connection)
    }

    for (const capabilityId of [
      'event.agent-thought',
      'event.plan',
      'event.tool',
      'event.diff',
      'usage.context'
    ] as const) {
      expect(
        harness.bridge.getStatus().capabilitySnapshot?.capabilities[capabilityId]
      ).toMatchObject({ verification: 'verified', source: 'runtime' })
    }
    expect(
      harness.bridge.getStatus().capabilitySnapshot?.capabilities['usage.context']
    ).toMatchObject({ maturity: 'experimental' })
  })

  it('有效权限请求到达后提升权限能力，响应仍按原有 pending 门禁回传', async () => {
    const harness = createBridgeHarness()
    const responsePromise = harness.internal.requestPermission(
      permissionRequest({ optionId: 'allow-once' }),
      harness.connection
    )

    expect(harness.permissions).toHaveLength(1)
    expect(
      harness.bridge.getStatus().capabilitySnapshot?.capabilities['permission.request']
    ).toMatchObject({ verification: 'verified', source: 'runtime' })

    harness.bridge.respondPermission(harness.permissions[0].id, 'allow-once')
    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
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

  it('Prompt 成功后提升文本与 Turn Usage 能力，busy/ready 保留同一握手摘要', async () => {
    const prompt = vi.fn().mockResolvedValue({
      stopReason: 'end_turn',
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
    })
    const connection = { prompt } as unknown as acp.ClientSideConnection
    const harness = createBridgeHarness(connection, false)
    harness.internal.capabilitySnapshot = mapGrokInitializeCapabilitySnapshot(
      harness.internal.capabilitySnapshot,
      initializeResponse({ loadSession: true, resume: true, runtimeVersion: '1.2.3' }),
      redactFakeText
    )
    harness.internal.updateStatus({
      state: 'ready',
      message: 'Grok Build 已连接',
      workspace: '/tmp/workspace',
      runtimeSessionId: 'runtime-session-1'
    })

    await harness.bridge.sendPrompt('执行测试')

    const busyStatus = harness.statuses.find((status) => status.state === 'busy')
    expect(busyStatus?.capabilitySnapshot?.runtimeVersion).toBe('1.2.3')
    expect(busyStatus?.capabilitySnapshot?.protocolVersion).toBe(String(acp.PROTOCOL_VERSION))
    expect(harness.bridge.getStatus()).toMatchObject({
      state: 'ready',
      workspace: '/tmp/workspace',
      runtimeSessionId: 'runtime-session-1'
    })
    expect(
      harness.bridge.getStatus().capabilitySnapshot?.capabilities['session.prompt.text']
    ).toMatchObject({ verification: 'verified', source: 'runtime' })
    expect(harness.bridge.getStatus().capabilitySnapshot?.capabilities['usage.turn']).toMatchObject(
      {
        maturity: 'experimental',
        verification: 'verified',
        source: 'runtime'
      }
    )
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

/** 只构造测试需要的 ACP 标准握手字段，扩展字段由具体用例单独注入。 */
function initializeResponse({
  loadSession,
  resume,
  runtimeVersion
}: {
  loadSession: boolean
  resume: boolean
  runtimeVersion?: string
}): acp.InitializeResponse {
  return {
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession,
      sessionCapabilities: resume ? { resume: {} } : {}
    },
    ...(runtimeVersion ? { agentInfo: { name: 'grok-build', version: runtimeVersion } } : {})
  }
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
  process: ChildProcessWithoutNullStreams | null
  connection: acp.ClientSideConnection | null
  sessionId: string | null
  activeTurn: TestActiveTurn | null
  capabilitySnapshot: AgentRuntimeCapabilitySnapshot
  pendingPermissions: Map<string, TestPendingPermission>
  initializeRuntimeSession: (
    connection: acp.ClientSideConnection,
    child: ChildProcessWithoutNullStreams,
    workspace: string
  ) => Promise<string | null>
  updateStatus: (status: Omit<AgentRuntimeStatus, 'runtimeId' | 'capabilitySnapshot'>) => void
  verifyCapability: (
    capabilityId: AgentCapabilityId,
    maturity: AgentCapabilityMaturity,
    reason?: string,
    publish?: boolean
  ) => void
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
  statuses: AgentRuntimeStatus[]
} {
  const events: AgentEvent[] = []
  const permissions: AgentPermissionRequest[] = []
  const statuses: AgentRuntimeStatus[] = []
  const bridge = new GrokAgentBridge(
    (status) => statuses.push(status),
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

  return { bridge, internal, connection, activeTurn, events, permissions, statuses }
}
