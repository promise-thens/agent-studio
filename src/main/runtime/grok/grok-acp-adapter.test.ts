import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentCapabilityId,
  AgentCapabilityMaturity,
  AgentEvent,
  AgentPermissionRequest,
  AgentRuntimeCapabilitySnapshot,
  AgentRuntimeStatus,
  AgentTurnOutcome
} from '../../../shared/agent'
import { AgentEventNormalizer, type AgentEventDraft } from '../../agent/event-normalizer'
import {
  AgentRuntimeAdapterError,
  type AgentRuntimeSessionRef,
  type AgentRuntimeTurnContext
} from '../../agent/agent-runtime-adapter'
import type { ProviderRuntimeConfig } from '../../provider/provider-config-store'
import {
  AGENT_STUDIO_MODEL_ALIAS,
  AGENT_STUDIO_MODEL_API_KEY_ENV
} from '../../provider/grok-provider-config'
import { GrokAcpAdapter, buildGrokRuntimeEnvironment } from './grok-acp-adapter'
import {
  createGrokCapabilitySnapshot,
  createGrokEventBase,
  mapGrokInitializeCapabilitySnapshot,
  mapGrokPermissionRequest,
  mapGrokSessionUpdate
} from './grok-acp-mappers'

const FAKE_SECRET = 'fake-adapter-secret'
const WORKSPACE = '/tmp/agent-studio-workspace'

describe('Grok ACP 协议投影', () => {
  it('initialize 只保留版本和 load/resume 证据，不泄漏扩展字段', () => {
    const snapshot = mapGrokInitializeCapabilitySnapshot(
      createGrokCapabilitySnapshot(redactFakeText),
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {}, close: {} },
          providers: { secret: FAKE_SECRET },
          _meta: { secret: FAKE_SECRET }
        },
        agentInfo: {
          name: 'grok-build',
          version: '1.2.3',
          _meta: { secret: FAKE_SECRET }
        },
        authMethods: [{ id: FAKE_SECRET, name: FAKE_SECRET }],
        _meta: { secret: FAKE_SECRET }
      } as unknown as acp.InitializeResponse,
      redactFakeText,
      acp.PROTOCOL_VERSION
    )

    expect(snapshot).toMatchObject({
      runtimeId: 'grok',
      runtimeVersion: '1.2.3',
      protocolVersion: String(acp.PROTOCOL_VERSION)
    })
    expect(snapshot.capabilities['session.load']).toMatchObject({
      support: 'native',
      verification: 'declared',
      source: 'protocol'
    })
    expect(snapshot.capabilities['session.resume']).toMatchObject({
      support: 'native',
      verification: 'declared',
      source: 'protocol'
    })

    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain(FAKE_SECRET)
    expect(serialized).not.toContain('_meta')
    expect(serialized).not.toContain('authMethods')
    expect(serialized).not.toContain('providers')
  })

  it('不兼容协议版本立即拒绝', () => {
    expect(() =>
      mapGrokInitializeCapabilitySnapshot(
        createGrokCapabilitySnapshot(redactFakeText),
        { protocolVersion: acp.PROTOCOL_VERSION + 1, agentCapabilities: {} },
        redactFakeText,
        acp.PROTOCOL_VERSION
      )
    ).toThrow('ACP 协议版本不兼容')
  })

  it('工具原始输入被丢弃，Diff 和文本先脱敏再进入中性事件', () => {
    const events = mapGrokSessionUpdate(
      {
        sessionId: 'runtime-session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: `修改文件 ${FAKE_SECRET}`,
          status: 'in_progress',
          rawInput: { apiKey: FAKE_SECRET },
          content: [
            {
              type: 'diff',
              path: '/tmp/test.ts',
              oldText: 'before',
              newText: `after ${FAKE_SECRET}`
            }
          ]
        } as acp.SessionUpdate
      },
      redactFakeText
    )

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      kind: 'tool-call',
      title: '修改文件 [REDACTED]'
    })
    expect(events[1]).toMatchObject({
      kind: 'diff',
      diffs: [{ after: 'after [REDACTED]' }]
    })
    expect(JSON.stringify(events)).not.toContain(FAKE_SECRET)
    expect(JSON.stringify(events)).not.toContain('rawInput')
  })

  it('权限请求使用服务层 Task/Turn 身份，整体超限时安全拒绝', () => {
    const request = mapGrokPermissionRequest(
      permissionRequest({ title: `执行命令 ${FAKE_SECRET}`, optionId: 'allow-once' }),
      'permission-1',
      'task-from-service',
      'turn-from-service',
      redactFakeText
    )

    expect(request).toMatchObject({
      id: 'permission-1',
      taskId: 'task-from-service',
      turnId: 'turn-from-service',
      title: '执行命令 [REDACTED]'
    })
    expect(
      mapGrokPermissionRequest(
        permissionRequest({ optionId: 'x'.repeat(300_000) }),
        'permission-2',
        'task-from-service',
        'turn-from-service',
        redactFakeText
      )
    ).toBeNull()
  })
})

describe('GrokAcpAdapter 会话与 Turn 生命周期', () => {
  it('握手只更新当前连接，旧连接晚到结果不覆盖新快照', async () => {
    let resolveInitialize: ((response: acp.InitializeResponse) => void) | undefined
    const initialize = vi.fn().mockImplementation(
      () =>
        new Promise<acp.InitializeResponse>((resolve) => {
          resolveInitialize = resolve
        })
    )
    const connection = { initialize } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, false)
    const child = {} as ChildProcessWithoutNullStreams
    harness.internal.process = child
    const previousSnapshot = harness.internal.capabilitySnapshot

    const initialization = harness.internal.initializeConnection(connection, child, WORKSPACE, 1)
    harness.internal.connectionGeneration = 2
    resolveInitialize?.(initializeResponse({ loadSession: true, resume: true }))

    await expect(initialization).resolves.toBe(false)
    expect(harness.internal.capabilitySnapshot).toBe(previousSnapshot)
  })

  it('创建 session 返回私有 Runtime 引用，不生成产品 Task/Turn ID', async () => {
    const newSession = vi.fn().mockResolvedValue({ sessionId: 'runtime-session-new' })
    const request = vi.fn().mockResolvedValue({})
    const connection = {
      newSession,
      request
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, false)

    const session = await harness.adapter.createSession({ workspace: WORKSPACE })

    expect(newSession).toHaveBeenCalledWith({ cwd: WORKSPACE, mcpServers: [] })
    expect(request).toHaveBeenCalledWith('session/set_model', {
      sessionId: 'runtime-session-new',
      modelId: AGENT_STUDIO_MODEL_ALIAS
    })
    expect(session).toEqual({
      runtimeId: 'grok',
      runtimeSessionId: 'runtime-session-new',
      workspace: WORKSPACE
    })
    expect(session).not.toHaveProperty('taskId')
    expect(session).not.toHaveProperty('turnId')
    expect(harness.adapter.getCapabilitySnapshot().capabilities['session.create']).toMatchObject({
      verification: 'verified',
      source: 'runtime'
    })
  })

  it('load/resume 首次允许 protocol-declared 证据，成功后才提升 verified', async () => {
    const loadSession = vi.fn().mockResolvedValue({})
    const resumeSession = vi.fn().mockResolvedValue({})
    const request = vi.fn().mockResolvedValue({})
    const connection = {
      loadSession,
      resumeSession,
      request
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    setHandshakeSnapshot(harness.internal, { loadSession: true, resume: true })
    const sessionA = runtimeSession('runtime-session-a')
    const sessionB = runtimeSession('runtime-session-b')

    await harness.adapter.loadSession(sessionA)
    expect(harness.adapter.getCapabilitySnapshot().capabilities['session.load']).toMatchObject({
      verification: 'verified',
      source: 'runtime'
    })

    await harness.adapter.resumeSession(sessionB)
    expect(harness.adapter.getCapabilitySnapshot().capabilities['session.resume']).toMatchObject({
      verification: 'verified',
      source: 'runtime'
    })
    expect(loadSession).toHaveBeenCalledWith({
      sessionId: 'runtime-session-a',
      cwd: WORKSPACE,
      mcpServers: []
    })
    expect(resumeSession).toHaveBeenCalledWith({
      sessionId: 'runtime-session-b',
      cwd: WORKSPACE,
      mcpServers: []
    })
    expect(request.mock.calls).toEqual([
      [
        'session/set_model',
        {
          sessionId: 'runtime-session-a',
          modelId: AGENT_STUDIO_MODEL_ALIAS
        }
      ],
      [
        'session/set_model',
        {
          sessionId: 'runtime-session-b',
          modelId: AGENT_STUDIO_MODEL_ALIAS
        }
      ]
    ])
  })

  it('Grok 模型绑定扩展未返回对象确认时废弃连接，不继续保留未知 Runtime 状态', async () => {
    const newSession = vi.fn().mockResolvedValue({ sessionId: 'runtime-session-new' })
    const request = vi.fn().mockResolvedValue(undefined)
    const connection = {
      newSession,
      request
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, false)

    await expect(harness.adapter.createSession({ workspace: WORKSPACE })).rejects.toMatchObject({
      code: 'operation-failed'
    })

    expect(harness.internal.connection).toBeNull()
    expect(harness.adapter.getStatus()).toMatchObject({ state: 'error', workspace: WORKSPACE })
    expect(harness.adapter.getStatus().runtimeSessionId).toBeUndefined()
  })

  it('从 B 恢复 A 的模型绑定失败时废弃连接，阻止旧 Task 与 Runtime 当前 session 错配', async () => {
    const resumeSession = vi.fn().mockResolvedValue({})
    const request = vi.fn().mockRejectedValue(new Error('model switch failed'))
    const prompt = vi.fn()
    const connection = {
      resumeSession,
      request,
      prompt
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    setHandshakeSnapshot(harness.internal, { loadSession: true, resume: true })
    harness.internal.selectedSession = runtimeSession('runtime-session-b')
    harness.internal.status = {
      ...harness.internal.status,
      runtimeSessionId: 'runtime-session-b'
    }

    await expect(
      harness.adapter.resumeSession(runtimeSession('runtime-session-a'))
    ).rejects.toMatchObject({ code: 'operation-failed' })
    expect(request).toHaveBeenCalledWith('session/set_model', {
      sessionId: 'runtime-session-a',
      modelId: AGENT_STUDIO_MODEL_ALIAS
    })
    expect(harness.internal.connection).toBeNull()
    expect(harness.internal.selectedSession).toBeNull()
    expect(harness.adapter.getStatus().state).toBe('error')
    expect(harness.adapter.getStatus().runtimeSessionId).toBeUndefined()
    expect(prompt).not.toHaveBeenCalled()
  })

  it('旧模型绑定响应晚到时只结束失效操作，不得废弃后来建立的新连接', async () => {
    let resolveRequest: ((response: unknown) => void) | undefined
    const request = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveRequest = resolve
        })
    )
    const oldConnection = {
      resumeSession: vi.fn().mockResolvedValue({}),
      request
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(oldConnection)
    setHandshakeSnapshot(harness.internal, { loadSession: true, resume: true })

    const restore = harness.adapter.resumeSession(runtimeSession('runtime-session-a'))
    const restoreExpectation = expect(restore).rejects.toMatchObject({ code: 'invalid-state' })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))

    const newConnection = { request: vi.fn() } as unknown as acp.ClientSideConnection
    harness.internal.connection = newConnection
    harness.internal.connectionGeneration += 1
    harness.internal.sessionOperationGeneration += 1
    harness.internal.selectedSession = runtimeSession('runtime-session-new')
    harness.internal.status = {
      ...harness.internal.status,
      state: 'ready',
      runtimeSessionId: 'runtime-session-new'
    }
    resolveRequest?.({})

    await restoreExpectation
    expect(harness.internal.connection).toBe(newConnection)
    expect(harness.internal.selectedSession?.runtimeSessionId).toBe('runtime-session-new')
    expect(harness.adapter.getStatus()).toMatchObject({
      state: 'ready',
      runtimeSessionId: 'runtime-session-new'
    })
  })

  it('模型绑定错误与 error 状态统一脱敏，不暴露 Runtime 原始 Secret', async () => {
    const request = vi.fn().mockRejectedValue(new Error(`model switch failed ${FAKE_SECRET}`))
    const connection = {
      resumeSession: vi.fn().mockResolvedValue({}),
      request
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    setHandshakeSnapshot(harness.internal, { loadSession: true, resume: true })

    let rejection: unknown
    try {
      await harness.adapter.resumeSession(runtimeSession('runtime-session-a'))
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(AgentRuntimeAdapterError)
    expect((rejection as Error).message).toContain('[REDACTED]')
    expect((rejection as Error).message).not.toContain(FAKE_SECRET)
    expect(harness.adapter.getStatus().message).toContain('[REDACTED]')
    expect(harness.adapter.getStatus().message).not.toContain(FAKE_SECRET)
  })

  it('握手未声明恢复能力时明确阻断，不误用当前 session', async () => {
    const connection = {
      loadSession: vi.fn(),
      resumeSession: vi.fn()
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)

    await expect(
      harness.adapter.loadSession(runtimeSession('runtime-session-old'))
    ).rejects.toMatchObject({ code: 'session-restore-unsupported' })
    expect(connection.loadSession).not.toHaveBeenCalled()
  })

  it('startTurn 使用服务层稳定 taskId/turnId，并返回与唯一终态一致的 outcome', async () => {
    const prompt = vi.fn()
    const connection = { prompt } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    const internal = harness.internal
    prompt.mockImplementation(async () => {
      internal.handleSessionUpdate(
        notification({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `你好 ${FAKE_SECRET}` }
        }),
        connection
      )
      return { stopReason: 'end_turn' as const }
    })

    const result = await harness.adapter.startTurn(turnContext('task-stable', 'turn-1'))

    expect(result).toEqual({ outcome: 'completed' })
    expect(prompt).toHaveBeenCalledWith({
      sessionId: 'runtime-session-1',
      prompt: [{ type: 'text', text: '执行测试' }]
    })
    expect(harness.events).toHaveLength(2)
    expect(harness.events[0]).toMatchObject({
      kind: 'agent-message',
      taskId: 'task-stable',
      turnId: 'turn-1',
      text: '你好 [REDACTED]'
    })
    expect(harness.events[1]).toMatchObject({
      kind: 'turn-complete',
      taskId: 'task-stable',
      turnId: 'turn-1',
      outcome: 'completed'
    })
  })

  it('同一 Task 的第二轮继续使用同一 Runtime session，但 turnId 由服务层更新', async () => {
    const prompt = vi
      .fn()
      .mockResolvedValueOnce({ stopReason: 'end_turn' })
      .mockResolvedValueOnce({ stopReason: 'refusal' })
    const connection = { prompt } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)

    await harness.adapter.startTurn(turnContext('task-a', 'turn-a-1'))
    await harness.adapter.startTurn(turnContext('task-a', 'turn-a-2'))

    expect(prompt).toHaveBeenCalledTimes(2)
    expect(prompt.mock.calls.map(([request]) => request.sessionId)).toEqual([
      'runtime-session-1',
      'runtime-session-1'
    ])
    expect(
      harness.events
        .filter((event) => event.kind === 'turn-complete')
        .map((event) => [event.taskId, event.turnId, event.outcome])
    ).toEqual([
      ['task-a', 'turn-a-1', 'completed'],
      ['task-a', 'turn-a-2', 'refused']
    ])
  })

  it('旧 connection、旧 session 与旧 Turn 代次的晚到事件均被拒绝', () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    const currentTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    const oldTurn = createActiveTurn(connection, 'task-old', 'turn-old', 1, 1)
    harness.internal.activeTurn = currentTurn

    harness.internal.emitDraft(oldTurn, {
      ...createGrokEventBase('runtime-session-1', 'native'),
      kind: 'agent-message',
      text: '旧 Turn 事件'
    })
    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '旧连接事件' }
      }),
      {} as acp.ClientSideConnection
    )
    harness.internal.handleSessionUpdate(
      {
        sessionId: 'runtime-session-old',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '旧 session 事件' }
        }
      },
      connection
    )
    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '当前事件' }
      }),
      connection
    )

    expect(harness.events).toHaveLength(1)
    expect(harness.events[0]).toMatchObject({
      kind: 'agent-message',
      taskId: 'task-current',
      turnId: 'turn-current',
      text: '当前事件'
    })
  })

  it('Prompt 失败先脱敏，再形成唯一 failed 终态并向 Service 返回 failed', async () => {
    const prompt = vi.fn().mockRejectedValue(new Error(`连接中断 ${FAKE_SECRET}`))
    const connection = { prompt } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)

    await expect(harness.adapter.startTurn(turnContext('task-1', 'turn-1'))).resolves.toEqual({
      outcome: 'failed'
    })
    expect(harness.events).toHaveLength(2)
    expect(harness.events[0]).toMatchObject({
      kind: 'error',
      message: '执行失败：连接中断 [REDACTED]',
      recoverable: false
    })
    expect(harness.events[1]).toMatchObject({ kind: 'turn-complete', outcome: 'failed' })
    expect(JSON.stringify(harness.events)).not.toContain(FAKE_SECRET)
  })

  it('取消和权限响应只命中当前完全匹配的 Turn', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const connection = { cancel } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    const activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    harness.internal.activeTurn = activeTurn

    const responsePromise = harness.internal.requestPermission(
      permissionRequest({ optionId: 'allow-once' }),
      connection
    )
    expect(harness.permissions[0]).toMatchObject({
      taskId: 'task-current',
      turnId: 'turn-current'
    })
    harness.adapter.respondPermission(harness.permissions[0].id, 'allow-once')
    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })

    await harness.adapter.cancelTurn({
      taskId: 'task-old',
      turnId: 'turn-current',
      runtimeSessionId: 'runtime-session-1'
    })
    expect(cancel).not.toHaveBeenCalled()

    await harness.adapter.cancelTurn({
      taskId: 'task-current',
      turnId: 'turn-current',
      runtimeSessionId: 'runtime-session-1'
    })
    expect(cancel).toHaveBeenCalledWith({ sessionId: 'runtime-session-1' })
  })

  it('ACP 取消失败会抛出有限错误并允许第二次重试', async () => {
    const cancel = vi.fn().mockRejectedValueOnce(new Error(`取消异常 ${FAKE_SECRET}`))
    const connection = { cancel } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    const activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    harness.internal.activeTurn = activeTurn
    const turn = {
      taskId: 'task-current',
      turnId: 'turn-current',
      runtimeSessionId: 'runtime-session-1'
    }

    await expect(harness.adapter.cancelTurn(turn)).rejects.toMatchObject({
      code: 'operation-failed',
      message: '取消失败：取消异常 [REDACTED]'
    })
    expect(activeTurn.cancelRequested).toBe(false)

    cancel.mockResolvedValueOnce(undefined)
    await expect(harness.adapter.cancelTurn(turn)).resolves.toBeUndefined()
    expect(cancel).toHaveBeenCalledTimes(2)
  })

  it('未声明 session/close 时只做本地幂等解绑，不误标原生能力', async () => {
    const closeSession = vi.fn()
    const connection = { closeSession } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)

    await harness.adapter.closeSession(runtimeSession('runtime-session-1'))

    expect(closeSession).not.toHaveBeenCalled()
    expect(harness.internal.selectedSession).toBeNull()
    expect(harness.adapter.getStatus()).toMatchObject({
      state: 'ready',
      workspace: WORKSPACE
    })
    expect(harness.adapter.getStatus().runtimeSessionId).toBeUndefined()
  })

  it('断开时收束当前 Turn、取消待处理权限并清除旧能力证据', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    const kill = vi.fn()
    harness.internal.process = { kill } as unknown as ChildProcessWithoutNullStreams
    const activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    harness.internal.activeTurn = activeTurn
    const permissionResponse = harness.internal.requestPermission(
      permissionRequest({ optionId: 'allow-once' }),
      connection
    )

    await harness.adapter.disconnect()

    await expect(permissionResponse).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(kill).toHaveBeenCalledTimes(1)
    expect(harness.events.at(-1)).toMatchObject({ kind: 'turn-complete', outcome: 'cancelled' })
    expect(harness.adapter.getStatus()).toMatchObject({ state: 'idle', runtimeId: 'grok' })
    expect(harness.adapter.getCapabilitySnapshot().capabilities['session.load']).toMatchObject({
      support: 'unknown',
      verification: 'unverified'
    })
  })
})

describe('Grok Runtime 环境隔离', () => {
  it('只继承允许的系统变量，Provider Key 不与其他宿主密钥混入', () => {
    const environment = buildGrokRuntimeEnvironment(
      providerConfig(),
      '/tmp/agent-studio-grok-home',
      {
        HOME: '/Users/tester',
        PATH: '/usr/bin',
        HTTPS_PROXY: 'http://127.0.0.1:7890',
        NPM_TOKEN: 'must-not-leak',
        XAI_API_KEY: 'must-not-leak',
        NODE_OPTIONS: '--require malicious.js'
      }
    )

    expect(environment).toMatchObject({
      HOME: '/Users/tester',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      GROK_HOME: '/tmp/agent-studio-grok-home',
      [AGENT_STUDIO_MODEL_API_KEY_ENV]: FAKE_SECRET
    })
    expect(environment.PATH).toContain('/usr/bin')
    expect(environment).not.toHaveProperty('NPM_TOKEN')
    expect(environment).not.toHaveProperty('XAI_API_KEY')
    expect(environment).not.toHaveProperty('NODE_OPTIONS')
  })
})

interface TestActiveTurn {
  taskId: string
  turnId: string
  runtimeSessionId: string
  connection: acp.ClientSideConnection
  connectionGeneration: number
  sessionGeneration: number
  normalizer: AgentEventNormalizer
  cancelRequested: boolean
  outcome?: AgentTurnOutcome
}

interface TestPendingPermission {
  activeTurn: TestActiveTurn
  optionIds: Set<string>
  resolve: (response: acp.RequestPermissionResponse) => void
}

interface GrokAcpAdapterTestAccess {
  process: ChildProcessWithoutNullStreams | null
  connection: acp.ClientSideConnection | null
  connectionGeneration: number
  sessionOperationGeneration: number
  sessionGeneration: number
  selectedSession: AgentRuntimeSessionRef | null
  activeTurn: TestActiveTurn | null
  pendingPermissions: Map<string, TestPendingPermission>
  supportsCloseSession: boolean
  capabilitySnapshot: AgentRuntimeCapabilitySnapshot
  status: AgentRuntimeStatus
  initializeConnection: (
    connection: acp.ClientSideConnection,
    child: ChildProcessWithoutNullStreams,
    workspace: string,
    connectionGeneration: number
  ) => Promise<boolean>
  requestPermission: (
    params: acp.RequestPermissionRequest,
    sourceConnection: acp.ClientSideConnection
  ) => Promise<acp.RequestPermissionResponse>
  handleSessionUpdate: (
    params: acp.SessionNotification,
    sourceConnection: acp.ClientSideConnection
  ) => void
  emitDraft: (activeTurn: TestActiveTurn, draft: AgentEventDraft) => AgentEvent | null
  verifyCapability: (
    capabilityId: AgentCapabilityId,
    maturity: AgentCapabilityMaturity,
    reason?: string,
    publish?: boolean
  ) => void
}

function createAdapterHarness(
  connection: acp.ClientSideConnection = {} as acp.ClientSideConnection,
  selected = true
): {
  adapter: GrokAcpAdapter
  internal: GrokAcpAdapterTestAccess
  events: AgentEvent[]
  permissions: AgentPermissionRequest[]
  statuses: AgentRuntimeStatus[]
} {
  const events: AgentEvent[] = []
  const permissions: AgentPermissionRequest[] = []
  const statuses: AgentRuntimeStatus[] = []
  const adapter = new GrokAcpAdapter(
    {
      onStatus: (status) => statuses.push(status),
      onEvent: (event) => events.push(event),
      onPermission: (request) => permissions.push(request)
    },
    {
      userDataPath: '/tmp/agent-studio-test',
      getProviderConfig: () => providerConfig(),
      redactText: redactFakeText
    }
  )
  const internal = adapter as unknown as GrokAcpAdapterTestAccess
  internal.connection = connection
  internal.connectionGeneration = 1
  internal.sessionGeneration = 1
  internal.selectedSession = selected ? runtimeSession('runtime-session-1') : null
  internal.status = {
    runtimeId: 'grok',
    state: 'ready',
    message: 'Grok Build 已连接',
    workspace: WORKSPACE,
    ...(selected ? { runtimeSessionId: 'runtime-session-1' } : {}),
    capabilitySnapshot: internal.capabilitySnapshot
  }

  return { adapter, internal, events, permissions, statuses }
}

function createActiveTurn(
  connection: acp.ClientSideConnection,
  taskId: string,
  turnId: string,
  connectionGeneration: number,
  sessionGeneration: number
): TestActiveTurn {
  return {
    taskId,
    turnId,
    runtimeSessionId: 'runtime-session-1',
    connection,
    connectionGeneration,
    sessionGeneration,
    normalizer: new AgentEventNormalizer({ taskId, turnId }),
    cancelRequested: false
  }
}

function setHandshakeSnapshot(
  internal: GrokAcpAdapterTestAccess,
  options: { loadSession: boolean; resume: boolean }
): void {
  internal.capabilitySnapshot = mapGrokInitializeCapabilitySnapshot(
    internal.capabilitySnapshot,
    initializeResponse(options),
    redactFakeText,
    acp.PROTOCOL_VERSION
  )
  internal.status = { ...internal.status, capabilitySnapshot: internal.capabilitySnapshot }
}

function initializeResponse({
  loadSession,
  resume
}: {
  loadSession: boolean
  resume: boolean
}): acp.InitializeResponse {
  return {
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession,
      sessionCapabilities: resume ? { resume: {} } : {}
    },
    agentInfo: { name: 'grok-build', version: '1.2.3' }
  }
}

function runtimeSession(runtimeSessionId: string): AgentRuntimeSessionRef {
  return { runtimeId: 'grok', runtimeSessionId, workspace: WORKSPACE }
}

function turnContext(taskId: string, turnId: string): AgentRuntimeTurnContext {
  return {
    taskId,
    turnId,
    runtimeSessionId: 'runtime-session-1',
    workspace: WORKSPACE,
    prompt: '执行测试'
  }
}

function notification(update: acp.SessionUpdate): acp.SessionNotification {
  return { sessionId: 'runtime-session-1', update }
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
    toolCall: { toolCallId: 'tool-1', title },
    options: [{ optionId, name: '允许一次', kind: 'allow_once' }]
  }
}

function providerConfig(): ProviderRuntimeConfig {
  return {
    baseUrl: 'https://api.example.com/v1',
    authMode: 'bearer',
    modelId: 'test-model',
    apiKey: FAKE_SECRET,
    updatedAt: '2026-08-11T00:00:00.000Z'
  }
}

function redactFakeText(text: string): string {
  return text.replaceAll(FAKE_SECRET, '[REDACTED]')
}
