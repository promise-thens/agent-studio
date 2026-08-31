import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import { AgentEventNormalizer } from '../../agent/event-normalizer'
import type {
  AgentRuntimeAdapterSink,
  AgentRuntimeSessionRef,
  AgentRuntimeTurnContext
} from '../../agent/agent-runtime-adapter'
import { AGENT_STUDIO_MODEL_ALIAS } from './grok-acp-dialect'
import type { ProviderRuntimeConfig } from '../../provider/provider-config-store'
import { GrokAcpAdapter } from './grok-acp-adapter'
import type { GrokAcpObservationRecord } from './grok-acp-protocol-observer'

/**
 * GACP-01 剩余回归：Adapter 观察器挂钩。
 * 不启动 Electron，不连真实 Grok，只验证正式 Adapter 路径记下字段名/枚举且不泄漏密钥。
 */
const FAKE_KEY = 'sk-fake-gacp01-remaining'
const WORKSPACE = '/tmp/agent-studio-gacp01-remaining'
const SESSION_ID = 'runtime-session-remaining'

describe('GACP-01 剩余 Adapter 观察挂钩', () => {
  it('initialize、set_model、权限、session/update 与 stopReason 只记脱敏字段', async () => {
    const records: GrokAcpObservationRecord[] = []
    const initialize = vi.fn().mockResolvedValue({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: 'grok-build', version: '1.0.0', _meta: { secret: FAKE_KEY } },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {}, close: {} },
        providers: { apiKey: FAKE_KEY }
      },
      authMethods: [{ id: FAKE_KEY, name: FAKE_KEY }],
      _meta: { secret: FAKE_KEY }
    })
    const newSession = vi.fn().mockResolvedValue({
      sessionId: '550e8400-e29b-41d4-a716-446655440000'
    })
    const request = vi.fn().mockResolvedValue({ modelId: AGENT_STUDIO_MODEL_ALIAS })
    const connection = {
      initialize,
      newSession,
      request,
      prompt: vi.fn()
    } as unknown as acp.ClientSideConnection
    const harness = createObservedHarness(connection, records)
    connection.prompt = vi.fn().mockImplementation(async () => {
      harness.internal.handleSessionUpdate(
        {
          sessionId: SESSION_ID,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: `思考 ${FAKE_KEY}` }
          }
        },
        connection
      )
      harness.internal.handleSessionUpdate(
        {
          sessionId: SESSION_ID,
          update: {
            sessionUpdate: 'not_a_supported_update',
            payload: FAKE_KEY
          } as unknown as acp.SessionUpdate
        },
        connection
      )
      harness.internal.handleSessionUpdate(
        {
          sessionId: SESSION_ID,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: FAKE_KEY }
          } as acp.SessionUpdate
        },
        connection
      )
      return { stopReason: 'end_turn' as const }
    })
    const child = {} as ChildProcessWithoutNullStreams
    harness.internal.process = child
    harness.internal.connection = connection
    harness.internal.connectionGeneration = 1

    await expect(
      harness.internal.initializeConnection(connection, child, WORKSPACE, 1)
    ).resolves.toBe(true)
    harness.internal.status = {
      runtimeId: 'grok',
      state: 'ready',
      message: 'Grok Build 已连接',
      workspace: WORKSPACE,
      capabilitySnapshot: harness.adapter.getCapabilitySnapshot()
    }

    harness.internal.selectedSession = null
    const created = await harness.adapter.createSession({
      workspace: WORKSPACE,
      taskId: 'task-test'
    })
    expect(created.runtimeSessionId).toBe('550e8400-e29b-41d4-a716-446655440000')

    harness.internal.selectedSession = {
      runtimeId: 'grok',
      runtimeSessionId: SESSION_ID,
      workspace: WORKSPACE
    }
    harness.internal.activeTurn = createActiveTurn(
      connection,
      harness.internal.connectionGeneration,
      harness.internal.sessionGeneration
    )
    const permission = harness.internal.requestPermission(
      {
        sessionId: SESSION_ID,
        options: [
          { optionId: `allow-${FAKE_KEY}`, name: 'Always', kind: 'allow_always' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
        ],
        toolCall: {
          toolCallId: 'tool-remaining',
          title: `执行 ${FAKE_KEY}`,
          kind: 'execute',
          rawInput: { command: `echo ${FAKE_KEY}` }
        }
      },
      connection
    )
    expect(harness.permissions[0]).toMatchObject({ executionSupported: false })
    harness.adapter.respondPermission(harness.permissions[0].requestId, 'allow-once')
    await expect(permission).resolves.toEqual({ outcome: { outcome: 'cancelled' } })

    harness.internal.activeTurn = null
    const turn = await harness.adapter.startTurn(turnContext())
    expect(turn).toEqual({ outcome: 'completed' })

    const serialized = JSON.stringify(records)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'initialize',
          protocolVersion: acp.PROTOCOL_VERSION,
          protocolVersionMatches: true,
          hasAgentInfoName: true,
          loadSession: true,
          resumeDeclared: true,
          closeDeclared: true,
          hasProviders: true,
          hasMeta: true
        }),
        expect.objectContaining({
          kind: 'set-model',
          accepted: true,
          responseShape: 'object'
        }),
        expect.objectContaining({
          kind: 'session-op',
          method: 'new',
          sessionIdShape: 'uuid',
          ok: true
        }),
        expect.objectContaining({
          kind: 'permission',
          optionKinds: ['allow_always', 'reject_once'],
          uniqueAllowOnce: false,
          uniqueRejectOnce: true,
          toolCallKind: 'execute',
          hasRawInput: true
        }),
        expect.objectContaining({
          kind: 'session-update',
          sessionUpdate: 'agent_thought_chunk',
          contentType: 'text'
        }),
        expect.objectContaining({
          kind: 'session-update',
          sessionUpdate: 'not_a_supported_update'
        }),
        expect.objectContaining({
          kind: 'session-update',
          sessionUpdate: 'user_message_chunk'
        }),
        expect.objectContaining({ kind: 'prompt-stop', stopReason: 'end_turn' })
      ])
    )
    expect(serialized).not.toContain(FAKE_KEY)
    expect(serialized).not.toContain('echo')
    expect(serialized).not.toContain('allow-sk-')
    expect(
      harness.events.some(
        (event) => event.kind === 'error' && event.code === 'unsupported-runtime-event'
      )
    ).toBe(true)
  })

  it('握手未声明恢复能力时阻断 load/resume，且不调用 Runtime method', async () => {
    const records: GrokAcpObservationRecord[] = []
    const loadSession = vi.fn()
    const resumeSession = vi.fn()
    const connection = { loadSession, resumeSession } as unknown as acp.ClientSideConnection
    const harness = createObservedHarness(connection, records)

    await expect(harness.adapter.loadSession(runtimeSession(), 'task-test')).rejects.toMatchObject({
      code: 'session-restore-unsupported'
    })
    await expect(
      harness.adapter.resumeSession(runtimeSession(), 'task-test')
    ).rejects.toMatchObject({
      code: 'session-restore-unsupported'
    })
    expect(loadSession).not.toHaveBeenCalled()
    expect(resumeSession).not.toHaveBeenCalled()
    expect(records.filter((record) => record.kind === 'session-op')).toEqual([])
  })

  it('set_model 返回 null 时拆连接，观察器只记 responseShape', async () => {
    const records: GrokAcpObservationRecord[] = []
    const newSession = vi.fn().mockResolvedValue({ sessionId: 'sess_opaque' })
    const request = vi.fn().mockResolvedValue(null)
    const connection = { newSession, request } as unknown as acp.ClientSideConnection
    const harness = createObservedHarness(connection, records, false)

    await expect(
      harness.adapter.createSession({ workspace: WORKSPACE, taskId: 'task-test' })
    ).rejects.toMatchObject({
      code: 'operation-failed'
    })
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'session-op',
          method: 'new',
          sessionIdShape: 'opaque-nonempty',
          ok: true
        }),
        expect.objectContaining({
          kind: 'set-model',
          accepted: false,
          responseShape: 'null'
        })
      ])
    )
    expect(JSON.stringify(records)).not.toContain('sess_opaque')
  })

  it('未注入观察器时正式路径不抛错，也不要求写文件', async () => {
    const connection = {
      prompt: vi.fn().mockResolvedValue({ stopReason: 'cancelled' })
    } as unknown as acp.ClientSideConnection
    const harness = createObservedHarness(connection, undefined)
    await expect(harness.adapter.startTurn(turnContext())).resolves.toEqual({
      outcome: 'cancelled'
    })
  })
})

interface ObservedHarnessAccess {
  connection: acp.ClientSideConnection | null
  connectionGeneration: number
  sessionGeneration: number
  selectedSession: AgentRuntimeSessionRef | null
  activeTurn: ReturnType<typeof createActiveTurn> | null
  process: ChildProcessWithoutNullStreams | null
  status: {
    runtimeId: 'grok'
    state: string
    message: string
    workspace?: string
    runtimeSessionId?: string
    capabilitySnapshot?: unknown
  }
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
}

function createObservedHarness(
  connection: acp.ClientSideConnection,
  records?: GrokAcpObservationRecord[],
  selected = true
): {
  adapter: GrokAcpAdapter
  internal: ObservedHarnessAccess
  events: Array<{ kind: string; code?: string }>
  permissions: Array<{ requestId: string; executionSupported?: boolean }>
} {
  const events: Array<{ kind: string; code?: string }> = []
  const permissions: Array<{ requestId: string; executionSupported?: boolean }> = []
  const sink: AgentRuntimeAdapterSink = {
    onStatus: () => undefined,
    onEvent: (event) => events.push(event),
    onPermission: (request) => permissions.push(request),
    onPermissionCancelled: () => undefined,
    onAvailableCommands: () => undefined
  }
  const adapter = new GrokAcpAdapter(sink, {
    userDataPath: '/tmp/agent-studio-gacp01-remaining',
    getProviderConfig: () => providerConfig(),
    getClientVersion: () => '0.1.0-test',
    redactText: (text) => text.replaceAll(FAKE_KEY, '[REDACTED]'),
    ...(records ? { protocolObserver: { record: (item) => records.push(item) } } : {})
  })
  const internal = adapter as unknown as ObservedHarnessAccess
  internal.connection = connection
  internal.connectionGeneration = 1
  internal.sessionGeneration = 1
  internal.selectedSession = selected ? runtimeSession() : null
  internal.status = {
    runtimeId: 'grok',
    state: 'ready',
    message: 'Grok Build 已连接',
    workspace: WORKSPACE,
    ...(selected ? { runtimeSessionId: SESSION_ID } : {}),
    capabilitySnapshot: adapter.getCapabilitySnapshot()
  }
  return { adapter, internal, events, permissions }
}

function createActiveTurn(
  connection: acp.ClientSideConnection,
  connectionGeneration = 1,
  sessionGeneration = 1
): {
  taskId: string
  turnId: string
  runtimeSessionId: string
  connection: acp.ClientSideConnection
  connectionGeneration: number
  sessionGeneration: number
  normalizer: AgentEventNormalizer
  toolCallAuthorizationSnapshots: Map<string, unknown>
  terminalToolCallIds: Set<string>
  rejectAllToolPermissions: boolean
  cancelRequested: boolean
} {
  return {
    taskId: 'task-remaining',
    turnId: 'turn-remaining',
    runtimeSessionId: SESSION_ID,
    connection,
    connectionGeneration,
    sessionGeneration,
    normalizer: new AgentEventNormalizer({ taskId: 'task-remaining', turnId: 'turn-remaining' }),
    toolCallAuthorizationSnapshots: new Map(),
    terminalToolCallIds: new Set(),
    rejectAllToolPermissions: false,
    cancelRequested: false
  }
}

function runtimeSession(): AgentRuntimeSessionRef {
  return { runtimeId: 'grok', runtimeSessionId: SESSION_ID, workspace: WORKSPACE }
}

function turnContext(): AgentRuntimeTurnContext {
  return {
    taskId: 'task-remaining',
    turnId: 'turn-remaining',
    runtimeSessionId: SESSION_ID,
    workspace: WORKSPACE,
    prompt: '执行剩余观察'
  }
}

function providerConfig(): ProviderRuntimeConfig {
  return {
    baseUrl: 'https://api.example.com/v1',
    authMode: 'bearer',
    modelId: 'test-model',
    apiKey: FAKE_KEY,
    updatedAt: '2026-08-18T00:00:00.000Z'
  }
}
