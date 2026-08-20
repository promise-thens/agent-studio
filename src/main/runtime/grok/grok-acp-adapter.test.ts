import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it, vi, type MockInstance } from 'vitest'
import type {
  AgentCapabilityId,
  AgentCapabilityMaturity,
  AgentEvent,
  AgentRuntimeCapabilitySnapshot,
  AgentRuntimeStatus,
  AgentTurnOutcome
} from '../../../shared/agent'
import { AgentEventNormalizer, type AgentEventDraft } from '../../agent/event-normalizer'
import {
  AgentRuntimeAdapterError,
  type AgentRuntimeAdapterSink,
  type AgentRuntimePermissionRequest,
  type AgentRuntimeSessionRef,
  type AgentRuntimeTurnContext
} from '../../agent/agent-runtime-adapter'
import type { AgentAvailableCommandSnapshot } from '../../../shared/agent-available-command'
import { AgentService } from '../../agent/agent-service'
import { TaskExecutionController } from '../../agent/task-execution-controller'
import { TaskStore } from '../../agent/task-store'
import { ProjectRegistry } from '../../project/project-registry'
import type { ProviderRuntimeConfig } from '../../provider/provider-config-store'
import {
  AGENT_STUDIO_MODEL_ALIAS,
  AGENT_STUDIO_MODEL_API_KEY_ENV
} from '../../provider/grok-provider-config'
import { PermissionAuditStore } from '../../security/permission-audit-store'
import { PermissionBroker } from '../../security/permission-broker'
import { createLocalEnvironmentId } from '../../security/permission-policy'
import { GrokAcpAdapter, buildGrokRuntimeEnvironment } from './grok-acp-adapter'
import {
  createGrokCapabilitySnapshot,
  createGrokEventBase,
  mapGrokInitializeCapabilitySnapshot,
  mapGrokPermissionRequest,
  mapGrokSessionUpdate,
  mergeGrokToolCallAuthorizationPatch,
  type GrokToolCallAuthorizationSnapshot
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

  it('权限请求只投影可信字段并使用服务层 Task/Turn 身份', () => {
    const request = mapGrokPermissionRequest(
      permissionRequest({
        title: `修改文件 ${FAKE_SECRET}`,
        optionId: 'allow-once',
        kind: 'edit',
        path: '/tmp/project/src/index.ts'
      }),
      'permission-1',
      'task-from-service',
      'turn-from-service',
      redactFakeText,
      true
    )

    expect(request).toMatchObject({
      requestId: 'permission-1',
      taskId: 'task-from-service',
      turnId: 'turn-from-service',
      title: '修改文件 [REDACTED]',
      operationType: 'write-file',
      targets: [{ kind: 'path', value: '/tmp/project/src/index.ts' }],
      executionSupported: true
    })
    expect(JSON.stringify(request)).not.toContain('rawInput')
    expect(
      mapGrokPermissionRequest(
        {
          ...permissionRequest({ optionId: 'allow-once', kind: 'execute' }),
          toolCall: {
            ...permissionRequest({ optionId: 'allow-once' }).toolCall,
            kind: 'execute',
            rawInput: { command: 'rm -rf /tmp', apiKey: FAKE_SECRET },
            rawOutput: { secret: FAKE_SECRET },
            name: `unstable-${FAKE_SECRET}`,
            _meta: { secret: FAKE_SECRET }
          },
          _meta: { secret: FAKE_SECRET }
        },
        'permission-2',
        'task-from-service',
        'turn-from-service',
        redactFakeText,
        true
      )
    ).toMatchObject({
      operationType: 'execute-command',
      minimumRisk: 'L3',
      targets: [{ kind: 'command', value: 'Runtime 未提供可信的结构化命令。' }]
    })
  })

  it('fetch 缺少可信 origin 时固定映射为未知目标的 L3 网络外发', () => {
    const request = mapGrokPermissionRequest(
      permissionRequest({ optionId: 'allow-once', kind: 'fetch', path: '/tmp/project/input.txt' }),
      'permission-fetch',
      'task-from-service',
      'turn-from-service',
      redactFakeText,
      true
    )

    expect(request).toMatchObject({
      operationType: 'network-egress',
      minimumRisk: 'L3',
      targets: [{ kind: 'unknown', value: 'Runtime 未提供可信的目标 origin。' }],
      parameterFingerprint: 'grok-acp:fetch:unknown-origin:v1'
    })
  })

  it.each<acp.ToolKind>(['read', 'edit', 'delete'])(
    '%s 缺少可信路径时收敛为未知 L3 操作',
    (kind) => {
      const request = mapGrokPermissionRequest(
        permissionRequest({ optionId: 'allow-once', kind }),
        `permission-${kind}`,
        'task-from-service',
        'turn-from-service',
        redactFakeText,
        true
      )

      expect(request).toMatchObject({
        operationType: 'unknown',
        minimumRisk: 'L3',
        targets: [{ kind: 'unknown', value: 'Runtime 未提供可验证的操作目标。' }],
        parameterFingerprint: `grok-acp:${kind}:unknown:v1`
      })
    }
  )

  it('合并 locations 与 diff.path 时去重，并保留待 Policy 校验的越界候选', () => {
    const request = mapGrokPermissionRequest(
      {
        ...permissionRequest({ optionId: 'allow-once', kind: 'edit' }),
        toolCall: {
          ...permissionRequest({ optionId: 'allow-once', kind: 'edit' }).toolCall,
          locations: [
            { path: '/tmp/project/src/index.ts' },
            { path: '/outside/project/secret.ts' },
            { path: '/tmp/project/src/index.ts' }
          ],
          content: [
            {
              type: 'diff',
              path: '/tmp/project/src/index.ts',
              oldText: 'before',
              newText: 'after'
            },
            {
              type: 'diff',
              path: '/tmp/project/src/new.ts',
              newText: 'new file'
            }
          ]
        }
      },
      'permission-paths',
      'task-from-service',
      'turn-from-service',
      redactFakeText,
      true
    )

    // Mapper 只收集结构化候选；是否位于 executionRoot 内由 Permission Policy 统一裁决。
    expect(request?.targets).toEqual([
      { kind: 'path', value: '/tmp/project/src/index.ts' },
      { kind: 'path', value: '/outside/project/secret.ts' },
      { kind: 'path', value: '/tmp/project/src/new.ts' }
    ])
  })

  it('Diff 正文只进入不可逆摘要，rawInput、rawOutput、_meta 与 name 不影响指纹', () => {
    const untrustedMarker = `untrusted-${FAKE_SECRET}`
    const createMappedRequest = (
      newText: string,
      metadataMarker: string
    ): AgentRuntimePermissionRequest | null =>
      mapGrokPermissionRequest(
        {
          ...permissionRequest({ optionId: 'allow-once', kind: 'edit' }),
          toolCall: {
            ...permissionRequest({ optionId: 'allow-once', kind: 'edit' }).toolCall,
            name: metadataMarker,
            locations: [{ path: '/tmp/project/src/trusted.ts' }],
            rawInput: {
              command: metadataMarker,
              path: `/outside/${metadataMarker}`,
              origin: `https://${metadataMarker}.example.com`
            },
            rawOutput: { result: metadataMarker },
            _meta: { injectedOperation: metadataMarker },
            content: [
              {
                type: 'content',
                content: { type: 'text', text: metadataMarker }
              },
              {
                type: 'diff',
                path: '/tmp/project/src/trusted.ts',
                oldText: 'before',
                newText,
                _meta: { injectedTarget: metadataMarker }
              }
            ]
          },
          _meta: { injectedDecision: metadataMarker }
        },
        'permission-ignored-fields',
        'task-from-service',
        'turn-from-service',
        redactFakeText,
        true
      )
    const request = createMappedRequest('after', untrustedMarker)
    const metadataChanged = createMappedRequest('after', 'different-untrusted-metadata')
    const contentChanged = createMappedRequest('different-after', untrustedMarker)

    expect(request).toMatchObject({
      operationType: 'write-file',
      targets: [{ kind: 'path', value: '/tmp/project/src/trusted.ts' }]
    })
    expect(request?.parameterFingerprint).toMatch(/^grok-acp:edit:diff:sha256:[0-9a-f]{64}$/u)
    expect(metadataChanged?.parameterFingerprint).toBe(request?.parameterFingerprint)
    expect(contentChanged?.parameterFingerprint).not.toBe(request?.parameterFingerprint)
    expect(JSON.stringify(request)).not.toContain('untrusted-')
    expect(JSON.stringify(request)).not.toContain(FAKE_SECRET)
  })

  it('同一 kind 的后续 patch 可扩张目标集合，但缩小后保持 sticky invalid', () => {
    const base = mergeGrokToolCallAuthorizationPatch(undefined, {
      toolCallId: 'tool-monotonic',
      kind: 'edit',
      locations: [{ path: '/tmp/project/a.ts' }]
    })
    const expanded = mergeGrokToolCallAuthorizationPatch(base, {
      toolCallId: 'tool-monotonic',
      locations: [{ path: '/tmp/project/a.ts' }, { path: '/tmp/project/b.ts' }]
    })
    const narrowed = mergeGrokToolCallAuthorizationPatch(expanded, {
      toolCallId: 'tool-monotonic',
      locations: [{ path: '/tmp/project/a.ts' }]
    })
    const attemptedRecovery = mergeGrokToolCallAuthorizationPatch(narrowed, {
      toolCallId: 'tool-monotonic',
      kind: 'edit',
      locations: [{ path: '/tmp/project/a.ts' }, { path: '/tmp/project/b.ts' }]
    })

    expect(expanded).toMatchObject({
      integrity: 'valid',
      locationPaths: ['/tmp/project/a.ts', '/tmp/project/b.ts']
    })
    expect(narrowed).toEqual({
      integrity: 'invalid',
      toolCallId: 'tool-monotonic',
      reason: 'target-conflict'
    })
    expect(attemptedRecovery).toEqual(narrowed)
  })

  it.each([
    {
      scenario: 'patch 路径条目超过 32',
      patch: {
        toolCallId: 'tool-too-many-paths',
        kind: 'edit' as const,
        locations: Array.from({ length: 33 }, (_, index) => ({ path: `/tmp/project/${index}.ts` }))
      }
    },
    {
      scenario: '单路径超过 16 KiB',
      patch: {
        toolCallId: 'tool-long-path',
        kind: 'edit' as const,
        locations: [{ path: `/tmp/${'中'.repeat(6 * 1024)}` }]
      }
    },
    {
      scenario: '安全快照超过 64 KiB',
      patch: {
        toolCallId: 'tool-large-snapshot',
        kind: 'edit' as const,
        locations: Array.from({ length: 32 }, (_, index) => ({
          path: `/tmp/project/${index}-${'中'.repeat(682)}`
        }))
      }
    },
    {
      scenario: 'Diff 哈希输入超过 256 KiB',
      patch: {
        toolCallId: 'tool-large-diff',
        kind: 'edit' as const,
        content: [
          {
            type: 'diff' as const,
            path: '/tmp/project/large.ts',
            oldText: '',
            newText: '中'.repeat(90 * 1024)
          }
        ]
      }
    }
  ])('$scenario 时生成定长 budget-exceeded 墓碑', ({ patch }) => {
    const snapshot = mergeGrokToolCallAuthorizationPatch(undefined, patch)
    expect(snapshot).toEqual({
      integrity: 'invalid',
      toolCallId: patch.toolCallId,
      reason: 'budget-exceeded'
    })
    expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeLessThan(256)
  })

  it('Diff 指纹区分 oldText 缺失与空串，且后续改写正文会粘性失效', () => {
    const createSnapshot = (
      oldText: string | null | undefined,
      newText = ''
    ): GrokToolCallAuthorizationSnapshot =>
      mergeGrokToolCallAuthorizationPatch(undefined, {
        toolCallId: 'tool-diff-domain',
        kind: 'edit',
        content: [
          {
            type: 'diff',
            path: '/tmp/project/empty.ts',
            ...(oldText === undefined ? {} : { oldText }),
            newText
          }
        ]
      })
    const missing = createSnapshot(undefined)
    const empty = createSnapshot('')
    expect(missing).toMatchObject({ integrity: 'valid' })
    expect(empty).toMatchObject({ integrity: 'valid' })
    expect(
      missing.integrity === 'valid' && empty.integrity === 'valid'
        ? missing.diffFingerprint === empty.diffFingerprint
        : true
    ).toBe(false)

    const rewritten = mergeGrokToolCallAuthorizationPatch(missing, {
      toolCallId: 'tool-diff-domain',
      content: [
        {
          type: 'diff',
          path: '/tmp/project/empty.ts',
          newText: 'changed'
        }
      ]
    })
    expect(rewritten).toEqual({
      integrity: 'invalid',
      toolCallId: 'tool-diff-domain',
      reason: 'target-conflict'
    })
  })

  it('edit 缺少可信 Diff 时使用 toolCallId 的不可逆摘要隔离每次请求', () => {
    const createMappedRequest = (toolCallId: string): AgentRuntimePermissionRequest | null =>
      mapGrokPermissionRequest(
        {
          ...permissionRequest({ optionId: 'allow-once', kind: 'edit' }),
          toolCall: {
            ...permissionRequest({ optionId: 'allow-once', kind: 'edit' }).toolCall,
            toolCallId,
            locations: [{ path: '/tmp/project/src/trusted.ts' }]
          }
        },
        `permission-${toolCallId}`,
        'task-from-service',
        'turn-from-service',
        redactFakeText,
        true
      )
    const first = createMappedRequest('tool-edit-1')
    const second = createMappedRequest('tool-edit-2')

    expect(first?.parameterFingerprint).toMatch(/^grok-acp:edit:tool-call:sha256:[0-9a-f]{64}$/u)
    expect(first?.parameterFingerprint).not.toContain('tool-edit-1')
    expect(second?.parameterFingerprint).not.toBe(first?.parameterFingerprint)
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

    const session = await harness.adapter.createSession({
      workspace: WORKSPACE,
      taskId: 'task-test'
    })

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

    await harness.adapter.loadSession(sessionA, 'task-test')
    expect(harness.adapter.getCapabilitySnapshot().capabilities['session.load']).toMatchObject({
      verification: 'verified',
      source: 'runtime'
    })

    await harness.adapter.resumeSession(sessionB, 'task-test')
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

    await expect(
      harness.adapter.createSession({ workspace: WORKSPACE, taskId: 'task-test' })
    ).rejects.toMatchObject({
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
      harness.adapter.resumeSession(runtimeSession('runtime-session-a'), 'task-test')
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

    const restore = harness.adapter.resumeSession(runtimeSession('runtime-session-a'), 'task-test')
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
      await harness.adapter.resumeSession(runtimeSession('runtime-session-a'), 'task-test')
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
      harness.adapter.loadSession(runtimeSession('runtime-session-old'), 'task-test')
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
    harness.adapter.respondPermission(harness.permissions[0].requestId, 'allow-once')
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

  it('同一 toolCall 的早期结构化更新会补全稀疏权限 patch', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-edit',
        kind: 'edit',
        status: 'in_progress',
        locations: [{ path: `${WORKSPACE}/src/current.ts` }],
        content: [
          {
            type: 'diff',
            path: `${WORKSPACE}/src/current.ts`,
            oldText: 'before',
            newText: 'after'
          }
        ]
      }),
      connection
    )

    const responsePromise = harness.internal.requestPermission(
      permissionRequest({ optionId: 'allow-once', toolCallId: 'tool-edit' }),
      connection
    )

    expect(harness.permissions[0]).toMatchObject({
      operationType: 'write-file',
      targets: [{ kind: 'path', value: `${WORKSPACE}/src/current.ts` }]
    })
    expect(harness.permissions[0].parameterFingerprint).toMatch(
      /^grok-acp:edit:diff:sha256:[0-9a-f]{64}$/u
    )
    harness.adapter.respondPermission(harness.permissions[0].requestId, 'deny-once')
    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it.each([
    { scenario: 'completed', status: 'completed' as const },
    { scenario: 'failed', status: 'failed' as const }
  ])('权限等待后收到 $scenario 终态时精确取消且不可复活', async ({ status }) => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    const responsePromise = harness.internal.requestPermission(
      permissionRequest({
        optionId: 'allow-once',
        toolCallId: 'tool-terminal',
        kind: 'edit',
        path: `${WORKSPACE}/src/terminal.ts`
      }),
      connection
    )

    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-terminal',
        status
      }),
      connection
    )

    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(harness.permissionCancellations).toEqual([
      expect.objectContaining({ toolCallId: 'tool-terminal', requestId: expect.any(String) })
    ])
    const late = await harness.internal.requestPermission(
      permissionRequest({
        optionId: 'allow-once',
        toolCallId: 'tool-terminal',
        kind: 'edit',
        path: `${WORKSPACE}/src/terminal.ts`
      }),
      connection
    )
    expect(late).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(harness.permissions).toHaveLength(1)
  })

  it('终态先到时，后续稀疏或完整权限请求都不创建审批', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-finished-first',
        status: 'completed'
      }),
      connection
    )

    await expect(
      harness.internal.requestPermission(
        permissionRequest({ optionId: 'allow-once', toolCallId: 'tool-finished-first' }),
        connection
      )
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    await expect(
      harness.internal.requestPermission(
        permissionRequest({
          optionId: 'allow-once',
          toolCallId: 'tool-finished-first',
          kind: 'edit',
          path: `${WORKSPACE}/src/finished.ts`
        }),
        connection
      )
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(harness.permissions).toHaveLength(0)
  })

  it('权限请求自身携带终态时直接拒绝，不登记 Adapter pending', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    const request = permissionRequest({
      optionId: 'allow-once',
      toolCallId: 'tool-inline-terminal',
      kind: 'edit',
      path: `${WORKSPACE}/src/inline.ts`
    })
    request.toolCall.status = 'failed'

    await expect(harness.internal.requestPermission(request, connection)).resolves.toEqual({
      outcome: { outcome: 'cancelled' }
    })
    expect(harness.permissions).toHaveLength(0)
    expect(harness.internal.pendingPermissions.size).toBe(0)
  })

  it('一个 ToolCall 终态只取消对应权限，其他并发 ToolCall 仍可响应', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    const first = harness.internal.requestPermission(
      permissionRequest({ optionId: 'allow-first', toolCallId: 'tool-first' }),
      connection
    )
    const second = harness.internal.requestPermission(
      permissionRequest({ optionId: 'allow-second', toolCallId: 'tool-second' }),
      connection
    )

    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-first',
        status: 'completed'
      }),
      connection
    )
    harness.adapter.respondPermission(harness.permissions[1].requestId, 'allow-once')

    await expect(first).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    await expect(second).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-second' }
    })
    expect(harness.permissionCancellations).toHaveLength(1)
    expect(harness.permissionCancellations[0]).toMatchObject({ toolCallId: 'tool-first' })
  })

  it('等待审批时纯展示更新与相同路径重排不撤销当前请求', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    const request = permissionRequest({
      optionId: 'allow-once',
      toolCallId: 'tool-display-update',
      kind: 'edit'
    })
    request.toolCall.locations = [
      { path: `${WORKSPACE}/src/a.ts`, line: 1 },
      { path: `${WORKSPACE}/src/b.ts`, line: 2 }
    ]
    const responsePromise = harness.internal.requestPermission(request, connection)

    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-display-update',
        title: '正在更新展示进度',
        status: 'in_progress',
        name: 'untrusted-display-name',
        rawInput: { ignored: true },
        rawOutput: { ignored: true },
        _meta: { ignored: true },
        content: [{ type: 'content', content: { type: 'text', text: '仅展示进度' } }]
      }),
      connection
    )
    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-display-update',
        locations: [
          { path: `${WORKSPACE}/src/b.ts`, line: 99 },
          { path: `${WORKSPACE}/src/a.ts`, line: null }
        ]
      }),
      connection
    )

    expect(harness.permissionCancellations).toHaveLength(0)
    expect(harness.internal.pendingPermissions.size).toBe(1)
    harness.adapter.respondPermission(harness.permissions[0].requestId, 'allow-once')
    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
  })

  it('等待审批后收到非终态授权 patch 时撤销旧快照，必须由 Runtime 重新请求', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    const responsePromise = harness.internal.requestPermission(
      permissionRequest({
        optionId: 'allow-once',
        toolCallId: 'tool-revised',
        kind: 'edit',
        path: `${WORKSPACE}/src/a.ts`
      }),
      connection
    )

    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-revised',
        locations: [{ path: `${WORKSPACE}/src/a.ts` }, { path: `${WORKSPACE}/src/b.ts` }]
      }),
      connection
    )

    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(harness.permissionCancellations).toEqual([
      expect.objectContaining({ toolCallId: 'tool-revised' })
    ])
    expect(harness.internal.pendingPermissions.size).toBe(0)
  })

  it('新的权限请求扩张同一 ToolCall 授权事实时撤销旧审批并保留新请求', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    const first = harness.internal.requestPermission(
      permissionRequest({
        optionId: 'allow-first',
        toolCallId: 'tool-permission-revised',
        kind: 'edit',
        path: `${WORKSPACE}/src/a.ts`
      }),
      connection
    )
    const revised = permissionRequest({
      optionId: 'allow-second',
      toolCallId: 'tool-permission-revised',
      kind: 'edit'
    })
    revised.toolCall.locations = [
      { path: `${WORKSPACE}/src/a.ts` },
      { path: `${WORKSPACE}/src/b.ts` }
    ]
    const second = harness.internal.requestPermission(revised, connection)

    await expect(first).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(harness.permissionCancellations).toEqual([
      expect.objectContaining({
        requestId: harness.permissions[0].requestId,
        toolCallId: 'tool-permission-revised'
      })
    ])
    expect(harness.internal.pendingPermissions.size).toBe(1)
    harness.adapter.respondPermission(harness.permissions[1].requestId, 'allow-once')
    await expect(second).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-second' }
    })
  })

  it('第 2001 个授权快照触发 Turn 级熔断，当前权限也不会越过门禁', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    const activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    harness.internal.activeTurn = activeTurn
    for (let index = 0; index < 2_000; index += 1) {
      activeTurn.toolCallAuthorizationSnapshots.set(`tool-${index}`, {
        integrity: 'valid',
        toolCallId: `tool-${index}`,
        kind: 'edit',
        locationPaths: [`${WORKSPACE}/src/${index}.ts`],
        diffPaths: []
      })
    }

    await expect(
      harness.internal.requestPermission(
        permissionRequest({
          optionId: 'allow-once',
          toolCallId: 'tool-overflow',
          kind: 'edit',
          path: `${WORKSPACE}/src/overflow.ts`
        }),
        connection
      )
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(activeTurn.rejectAllToolPermissions).toBe(true)
    expect(activeTurn.toolCallAuthorizationSnapshots.size).toBe(0)
    expect(harness.permissions).toHaveLength(0)
    expect(harness.internal.pendingPermissions.size).toBe(0)
  })

  it('invalid 权限即使直接响应 allow-once 也只能向 ACP 返回 cancelled', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-invalid-direct',
        kind: 'edit',
        locations: [{ path: `${WORKSPACE}/src/a.ts` }]
      }),
      connection
    )
    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-invalid-direct',
        locations: []
      }),
      connection
    )
    const responsePromise = harness.internal.requestPermission(
      permissionRequest({ optionId: 'allow-once', toolCallId: 'tool-invalid-direct' }),
      connection
    )

    expect(harness.permissions[0]).toMatchObject({ executionSupported: false })
    harness.adapter.respondPermission(harness.permissions[0].requestId, 'allow-once')
    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('invalid 快照经真实 Adapter/Service/Broker/AuditStore 链路只审计并向 ACP 取消', async () => {
    const fixture = await createInvalidPermissionIntegrationFixture()
    try {
      const execution = fixture.startTurn('验证 invalid 权限全链路')
      await vi.waitFor(() => expect(fixture.internal.activeTurn).not.toBeNull())
      const activeTurn = fixture.internal.activeTurn!
      fixture.internal.handleSessionUpdate(
        notification({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-invalid-integration',
          kind: 'edit',
          locations: [{ path: join(fixture.workspace, 'src/a.ts') }]
        }),
        fixture.connection
      )
      fixture.internal.handleSessionUpdate(
        notification({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-invalid-integration',
          locations: []
        }),
        fixture.connection
      )
      expect(activeTurn.toolCallAuthorizationSnapshots.get('tool-invalid-integration')).toEqual({
        integrity: 'invalid',
        toolCallId: 'tool-invalid-integration',
        reason: 'target-conflict'
      })

      const acpResponse = fixture.internal.requestPermission(
        permissionRequest({
          optionId: 'allow-once',
          toolCallId: 'tool-invalid-integration'
        }),
        fixture.connection
      )
      await expect(acpResponse).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
      await vi.waitFor(() =>
        expect(fixture.broker.getPendingCount(fixture.taskId, fixture.turnId)).toBe(0)
      )
      expect(fixture.approvals).toHaveLength(0)
      expect(fixture.service.getTaskRuntimeState(fixture.taskId).state).toBe('running')
      expect(fixture.setPermissionStateSpy).not.toHaveBeenCalled()
      expect(fixture.respondPermissionSpy).toHaveBeenCalledOnce()
      expect(fixture.respondPermissionSpy).toHaveBeenCalledWith(expect.any(String), 'cancelled')
      expect(fixture.internal.pendingPermissions.size).toBe(0)
      expect(getPermissionBrokerGrantCount(fixture.broker)).toBe(0)

      const auditPage = await fixture.auditStore.list(fixture.taskId)
      expect(auditPage.items).toHaveLength(1)
      expect(auditPage.items[0]).toMatchObject({
        initiator: 'runtime',
        runtimeId: 'grok',
        operationType: 'unknown',
        risk: 'L3',
        reason: 'unsupported',
        targetSummaries: [expect.stringMatching(/^unknown: sha256:[0-9a-f]{64}$/u)]
      })
      expect(auditPage.items[0]).not.toHaveProperty('scope')

      fixture.releasePrompt.resolve({ stopReason: 'end_turn' })
      await expect(execution).resolves.toMatchObject({ outcome: 'completed' })
      expect(fixture.respondPermissionSpy).toHaveBeenCalledOnce()
    } finally {
      await fixture.dispose()
    }
  })

  it('超长 toolCallId 立即熔断当前 Turn，原文不进入快照或 tombstone', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    const activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    harness.internal.activeTurn = activeTurn
    const oversizedToolCallId = `tool-${'中'.repeat(2 * 1024)}`

    await expect(
      harness.internal.requestPermission(
        permissionRequest({ optionId: 'allow-once', toolCallId: oversizedToolCallId }),
        connection
      )
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(activeTurn.rejectAllToolPermissions).toBe(true)
    expect(activeTurn.toolCallAuthorizationSnapshots.size).toBe(0)
    expect(activeTurn.terminalToolCallIds.size).toBe(0)
    expect(harness.permissions).toHaveLength(0)
  })

  it('权限 patch 改写同 toolCall 的 kind 与目标时粘性失效并禁止执行', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-override',
        kind: 'read',
        locations: [{ path: `${WORKSPACE}/src/old.ts` }]
      }),
      connection
    )

    const responsePromise = harness.internal.requestPermission(
      permissionRequest({
        optionId: 'allow-once',
        toolCallId: 'tool-override',
        kind: 'edit',
        path: `${WORKSPACE}/src/new.ts`,
        content: [
          {
            type: 'diff',
            path: `${WORKSPACE}/src/new.ts`,
            oldText: 'old',
            newText: 'new'
          }
        ]
      }),
      connection
    )

    expect(harness.permissions[0]).toMatchObject({
      operationType: 'unknown',
      minimumRisk: 'L3',
      executionSupported: false,
      targets: [{ kind: 'unknown', value: 'Runtime 权限证据无效，已安全拒绝。' }]
    })
    harness.adapter.respondPermission(harness.permissions[0].requestId, 'deny-once')
    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it.each([
    { scenario: 'null', kind: null, locations: null, content: null },
    { scenario: '空数组', kind: null, locations: [], content: [] }
  ])('$scenario 尝试清除旧授权事实时粘性失效', async ({ kind, locations, content }) => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-clear',
        kind: 'edit',
        locations: [{ path: `${WORKSPACE}/src/clear.ts` }],
        content: [
          {
            type: 'diff',
            path: `${WORKSPACE}/src/clear.ts`,
            oldText: 'before',
            newText: 'after'
          }
        ]
      }),
      connection
    )
    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-clear',
        kind,
        locations,
        content
      }),
      connection
    )

    const responsePromise = harness.internal.requestPermission(
      permissionRequest({ optionId: 'allow-once', toolCallId: 'tool-clear' }),
      connection
    )

    expect(harness.permissions[0]).toMatchObject({
      operationType: 'unknown',
      executionSupported: false,
      targets: [{ kind: 'unknown', value: 'Runtime 权限证据无效，已安全拒绝。' }]
    })
    harness.adapter.respondPermission(harness.permissions[0].requestId, 'deny-once')
    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('工具授权快照只存在于当前 Turn，后续 Turn 不继承', async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' })
    const connection = { prompt } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    const firstTurn = createActiveTurn(connection, 'task-current', 'turn-first', 1, 1)
    harness.internal.activeTurn = firstTurn
    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-shared',
        kind: 'edit',
        locations: [{ path: `${WORKSPACE}/src/shared.ts` }]
      }),
      connection
    )
    harness.internal.activeTurn = null

    const secondTurn = createActiveTurn(connection, 'task-current', 'turn-second', 1, 1)
    harness.internal.activeTurn = secondTurn
    const responsePromise = harness.internal.requestPermission(
      permissionRequest({ optionId: 'allow-once', toolCallId: 'tool-shared' }),
      connection
    )

    expect(harness.permissions[0]).toMatchObject({ operationType: 'unknown' })
    harness.adapter.respondPermission(harness.permissions[0].requestId, 'deny-once')
    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('rawInput、rawOutput、_meta、name 与 title 永不成为授权事实', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    const injected = `${WORKSPACE}/${FAKE_SECRET}.ts`
    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-untrusted',
        title: `edit ${injected}`,
        name: 'edit',
        rawInput: { kind: 'edit', path: injected },
        rawOutput: { diff: injected },
        _meta: { locations: [{ path: injected }] }
      }),
      connection
    )

    const responsePromise = harness.internal.requestPermission(
      permissionRequest({ optionId: 'allow-once', toolCallId: 'tool-untrusted' }),
      connection
    )

    expect(harness.permissions[0]).toMatchObject({
      operationType: 'unknown',
      targets: [{ kind: 'unknown', value: 'Runtime 未提供可验证的操作目标。' }]
    })
    expect(JSON.stringify(harness.permissions[0])).not.toContain(injected)
    expect(JSON.stringify(harness.permissions[0])).not.toContain(FAKE_SECRET)
    harness.adapter.respondPermission(harness.permissions[0].requestId, 'deny-once')
    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it.each([
    {
      scenario: '只提供 allow_always',
      options: [permissionOption('allow-always', 'allow_always')]
    },
    {
      scenario: '提供重复 allow_once',
      options: [
        permissionOption('allow-once-a', 'allow_once'),
        permissionOption('allow-once-b', 'allow_once')
      ]
    },
    {
      scenario: 'allow_once optionId 超过 4 KiB',
      options: [permissionOption('x'.repeat(4 * 1024 + 1), 'allow_once')]
    },
    {
      scenario: 'allow_once optionId 包含 NUL',
      options: [permissionOption('allow\0once', 'allow_once')]
    },
    {
      scenario: 'allow_once 与 reject_once 复用相同 optionId',
      options: [
        permissionOption('shared-option', 'allow_once'),
        permissionOption('shared-option', 'reject_once')
      ]
    }
  ])('$scenario 时标记执行不受支持并安全取消', async ({ options }) => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)

    const responsePromise = harness.internal.requestPermission(
      permissionRequestWithOptions(options),
      connection
    )

    expect(harness.permissions).toHaveLength(1)
    expect(harness.permissions[0]).toMatchObject({ executionSupported: false })
    harness.adapter.respondPermission(harness.permissions[0].requestId, 'allow-once')
    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('拒绝时只选择唯一 reject_once，永不选择 always 选项', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    const responsePromise = harness.internal.requestPermission(
      permissionRequestWithOptions([
        permissionOption('allow-once', 'allow_once'),
        permissionOption('allow-always', 'allow_always'),
        permissionOption('reject-once', 'reject_once'),
        permissionOption('reject-always', 'reject_always')
      ]),
      connection
    )

    harness.adapter.respondPermission(harness.permissions[0].requestId, 'deny-once')

    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' }
    })
  })

  it('缺少 reject_once 时拒绝也只能取消，不回退到 reject_always', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    const responsePromise = harness.internal.requestPermission(
      permissionRequestWithOptions([
        permissionOption('allow-once', 'allow_once'),
        permissionOption('reject-always', 'reject_always')
      ]),
      connection
    )

    harness.adapter.respondPermission(harness.permissions[0].requestId, 'deny-once')

    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('允许时只选择唯一 allow_once，不向 Runtime 回传 allow_always', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    const responsePromise = harness.internal.requestPermission(
      permissionRequestWithOptions([
        permissionOption('allow-once', 'allow_once'),
        permissionOption('allow-always', 'allow_always')
      ]),
      connection
    )

    harness.adapter.respondPermission(harness.permissions[0].requestId, 'allow-once')

    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
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

  it('createSession 在等待 newSession 前就绑定产品 taskId', async () => {
    let boundDuringNewSession: string | null | undefined
    const newSession = vi.fn()
    const request = vi.fn().mockResolvedValue({})
    const connection = {
      newSession,
      request
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, false)
    newSession.mockImplementation(async () => {
      boundDuringNewSession = harness.internal.boundTaskId
      return { sessionId: 'runtime-session-new' }
    })

    await harness.adapter.createSession({ workspace: WORKSPACE, taskId: 'task-test' })

    expect(boundDuringNewSession).toBe('task-test')
    expect(harness.internal.boundTaskId).toBe('task-test')
  })

  it('session/new 后、startTurn 前收到命令列表会推送 sink，且不进 Timeline', async () => {
    const newSession = vi.fn().mockResolvedValue({ sessionId: 'runtime-session-new' })
    const request = vi.fn().mockResolvedValue({})
    const prompt = vi.fn()
    const connection = {
      newSession,
      request,
      prompt
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, false)

    const session = await harness.adapter.createSession({
      workspace: WORKSPACE,
      taskId: 'task-test'
    })
    expect(harness.internal.activeTurn).toBeNull()

    harness.internal.handleSessionUpdate(
      {
        sessionId: session.runtimeSessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            {
              name: 'compact',
              description: `压缩 ${FAKE_SECRET}`,
              input: { hint: `范围 ${FAKE_SECRET}` }
            }
          ]
        }
      },
      connection
    )

    expect(prompt).not.toHaveBeenCalled()
    expect(harness.events).toEqual([])
    expect(harness.availableCommands).toEqual([
      {
        taskId: 'task-test',
        revision: 1,
        commands: [
          {
            name: 'compact',
            description: '压缩 [REDACTED]',
            inputHint: '范围 [REDACTED]'
          }
        ]
      }
    ])
  })

  it('无 activeTurn 的 agent_message_chunk 仍被忽略', async () => {
    const newSession = vi.fn().mockResolvedValue({ sessionId: 'runtime-session-new' })
    const request = vi.fn().mockResolvedValue({})
    const connection = {
      newSession,
      request
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, false)

    const session = await harness.adapter.createSession({
      workspace: WORKSPACE,
      taskId: 'task-test'
    })
    expect(harness.internal.activeTurn).toBeNull()

    harness.internal.handleSessionUpdate(
      {
        sessionId: session.runtimeSessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '无 Turn 的回复' }
        }
      },
      connection
    )

    expect(harness.events).toEqual([])
    expect(harness.availableCommands).toEqual([])
  })

  it('disconnect 后快照 commands 为空', async () => {
    const newSession = vi.fn().mockResolvedValue({ sessionId: 'runtime-session-new' })
    const request = vi.fn().mockResolvedValue({})
    const connection = {
      newSession,
      request
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, false)
    harness.internal.process = { kill: vi.fn() } as unknown as ChildProcessWithoutNullStreams

    const session = await harness.adapter.createSession({
      workspace: WORKSPACE,
      taskId: 'task-test'
    })
    harness.internal.handleSessionUpdate(
      {
        sessionId: session.runtimeSessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'compact', description: '压缩上下文' }]
        }
      },
      connection
    )

    await harness.adapter.disconnect()

    expect(harness.availableCommands.at(-1)).toEqual({
      taskId: 'task-test',
      revision: 2,
      commands: []
    })
    expect(harness.internal.boundTaskId).toBeNull()
  })

  it('closeSession 当前绑定会话时清空命令快照', async () => {
    const newSession = vi.fn().mockResolvedValue({ sessionId: 'runtime-session-new' })
    const request = vi.fn().mockResolvedValue({})
    const connection = {
      newSession,
      request
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, false)

    const session = await harness.adapter.createSession({
      workspace: WORKSPACE,
      taskId: 'task-test'
    })
    harness.internal.handleSessionUpdate(
      {
        sessionId: session.runtimeSessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'compact', description: '压缩上下文' }]
        }
      },
      connection
    )

    await harness.adapter.closeSession(session)

    expect(harness.availableCommands.at(-1)).toEqual({
      taskId: 'task-test',
      revision: 2,
      commands: []
    })
    expect(harness.internal.boundTaskId).toBeNull()
  })

  it('切换到新 Task session 时先向旧 Task 推空命令列表', async () => {
    const newSession = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: 'runtime-session-a' })
      .mockResolvedValueOnce({ sessionId: 'runtime-session-b' })
    const request = vi.fn().mockResolvedValue({})
    const connection = {
      newSession,
      request
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, false)

    const sessionA = await harness.adapter.createSession({
      workspace: WORKSPACE,
      taskId: 'task-a'
    })
    harness.internal.handleSessionUpdate(
      {
        sessionId: sessionA.runtimeSessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'compact', description: '压缩上下文' }]
        }
      },
      connection
    )

    await harness.adapter.createSession({ workspace: WORKSPACE, taskId: 'task-b' })

    expect(harness.availableCommands).toEqual([
      {
        taskId: 'task-a',
        revision: 1,
        commands: [{ name: 'compact', description: '压缩上下文' }]
      },
      {
        taskId: 'task-a',
        revision: 2,
        commands: []
      }
    ])
    expect(harness.internal.boundTaskId).toBe('task-b')
  })

  it('session/new 后命令快照写入已接线的 AgentService', async () => {
    const fixture = await createInvalidPermissionIntegrationFixture()
    try {
      expect(fixture.internal.activeTurn).toBeNull()
      fixture.internal.handleSessionUpdate(
        {
          sessionId: 'runtime-session-1',
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'compact', description: '压缩上下文' }]
          }
        },
        fixture.connection
      )

      expect(fixture.service.getAvailableCommands(fixture.taskId)).toEqual({
        taskId: fixture.taskId,
        revision: 1,
        commands: [{ name: 'compact', description: '压缩上下文' }]
      })
    } finally {
      await fixture.dispose()
    }
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
  toolCallAuthorizationSnapshots: Map<string, GrokToolCallAuthorizationSnapshot>
  terminalToolCallIds: Set<string>
  rejectAllToolPermissions: boolean
  cancelRequested: boolean
  outcome?: AgentTurnOutcome
}

interface TestPendingPermission {
  request: import('../../agent/agent-runtime-adapter').AgentRuntimePermissionCancellation
  activeTurn: TestActiveTurn
  allowOnceOptionId?: string
  rejectOnceOptionId?: string
  resolve: (response: acp.RequestPermissionResponse) => void
}

interface GrokAcpAdapterTestAccess {
  process: ChildProcessWithoutNullStreams | null
  connection: acp.ClientSideConnection | null
  connectionGeneration: number
  sessionOperationGeneration: number
  sessionGeneration: number
  selectedSession: AgentRuntimeSessionRef | null
  /** 产品 Task 绑定；无 Turn 时命令快照也靠它盖章。 */
  boundTaskId: string | null
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

interface InvalidPermissionIntegrationFixture {
  service: AgentService
  broker: PermissionBroker
  auditStore: PermissionAuditStore
  internal: GrokAcpAdapterTestAccess
  connection: acp.ClientSideConnection
  taskId: string
  turnId: string
  workspace: string
  approvals: unknown[]
  setPermissionStateSpy: MockInstance<TaskStore['setPermissionState']>
  respondPermissionSpy: MockInstance<GrokAcpAdapter['respondPermission']>
  releasePrompt: Deferred<acp.PromptResponse>
  startTurn: (prompt: string) => ReturnType<AgentService['startTurn']>
  dispose: () => Promise<void>
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

/**
 * 用真实 Adapter、Service、Broker 与审计存储闭合 invalid 权限链路；
 * 只替换 ACP connection，避免测试启动外部 Grok 子进程。
 */
async function createInvalidPermissionIntegrationFixture(): Promise<InvalidPermissionIntegrationFixture> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'grok-invalid-permission-'))
  const projectPath = join(userDataPath, 'project')
  await mkdir(projectPath)

  const registry = new ProjectRegistry({
    userDataPath,
    createId: () => 'project-invalid',
    now: () => '2026-08-13T00:00:00.000Z'
  })
  await registry.initialize()
  const project = await registry.register(projectPath)
  const workspace = project.canonicalRoot
  const taskStore = new TaskStore({ projectRegistry: registry })
  await taskStore.initialize()
  const setPermissionStateSpy = vi.spyOn(taskStore, 'setPermissionState')
  const approvals: unknown[] = []
  const auditStore = new PermissionAuditStore({
    projectRegistry: registry,
    getTaskIdentity: (taskId) => {
      const task = taskStore.getTaskRecord(taskId)
      return { taskId: task.taskId, projectId: task.projectId }
    },
    ensureHistoryCapacity: (taskId, additionalBytes) =>
      taskStore.ensureAdditionalHistoryCapacity(taskId, additionalBytes),
    beginTaskHistoryMutation: (taskId) => taskStore.beginTaskHistoryMutation(taskId),
    createId: () => 'audit-storage-id',
    now: () => Date.parse('2026-08-13T00:00:00.000Z')
  })
  let brokerId = 0
  const broker = new PermissionBroker({
    auditStore,
    onApproval: (approval) => {
      approvals.push(approval)
      return true
    },
    resolveIntentContext: (taskId, turnId) => {
      try {
        const task = taskStore.getTaskRecord(taskId)
        return {
          taskId: task.taskId,
          turnId: task.activeTurnId ?? '',
          projectId: task.projectId,
          executionRoot: task.environment.rootSnapshot,
          environmentId: createLocalEnvironmentId(task.projectId, task.environment.rootSnapshot),
          runtimeId: task.runtimeId,
          environmentKind: 'local' as const,
          active:
            task.activeTurnId === turnId &&
            (task.state === 'running' || task.state === 'waiting-permission')
        }
      } catch {
        return null
      }
    },
    createId: () => `broker-invalid-${++brokerId}`,
    now: () => Date.parse('2026-08-13T00:00:00.000Z')
  })

  const releasePrompt = deferred<acp.PromptResponse>()
  const connection = {
    newSession: vi.fn(async () => ({ sessionId: 'runtime-session-1' })),
    request: vi.fn(async () => ({})),
    prompt: vi.fn(() => releasePrompt.promise)
  } as unknown as acp.ClientSideConnection
  const serviceRef: { current?: AgentService } = {}
  const sink: AgentRuntimeAdapterSink = {
    onStatus: () => undefined,
    onEvent: (event) => serviceRef.current?.handleRuntimeEvent(event),
    onPermission: (request) => serviceRef.current?.handlePermissionRequest(request),
    onPermissionCancelled: (request) => serviceRef.current?.handlePermissionCancellation(request),
    onAvailableCommands: (snapshot) => serviceRef.current?.handleAvailableCommands(snapshot)
  }
  const adapter = new GrokAcpAdapter(sink, {
    userDataPath,
    getProviderConfig: () => providerConfig(),
    redactText: redactFakeText
  })
  const internal = adapter as unknown as GrokAcpAdapterTestAccess
  internal.connection = connection
  internal.connectionGeneration = 1
  internal.sessionGeneration = 0
  internal.selectedSession = null
  internal.status = {
    runtimeId: 'grok',
    state: 'ready',
    message: 'Grok Build 已连接',
    workspace,
    capabilitySnapshot: internal.capabilitySnapshot
  }
  const respondPermissionSpy = vi.spyOn(adapter, 'respondPermission')
  const controller = new TaskExecutionController()
  let idIndex = 0
  const service = new AgentService(adapter, controller, {
    createId: () => ['task-invalid', 'turn-invalid'][idIndex++] ?? `unexpected-${idIndex}`,
    now: () => '2026-08-13T00:00:00.000Z',
    projectRegistry: registry,
    taskStore,
    permissionBroker: broker
  })
  serviceRef.current = service
  const task = await service.createTask(project.projectId)
  let activeExecution: ReturnType<AgentService['startTurn']> | undefined

  return {
    service,
    broker,
    auditStore,
    internal,
    connection,
    taskId: task.taskId,
    turnId: 'turn-invalid',
    workspace,
    approvals,
    setPermissionStateSpy,
    respondPermissionSpy,
    releasePrompt,
    startTurn: (prompt) => {
      activeExecution = service.startTurn(task.taskId, prompt)
      return activeExecution
    },
    dispose: async () => {
      // 测试失败时也必须先结束 Prompt，避免活动 Turn 或 Broker 授权悬空。
      releasePrompt.resolve({ stopReason: 'cancelled' })
      await activeExecution?.catch(() => undefined)
      await broker.shutdown()
      setPermissionStateSpy.mockRestore()
      respondPermissionSpy.mockRestore()
      await rm(userDataPath, { recursive: true, force: true })
    }
  }
}

/** 只读检查 Broker 内存 grant 数量，证明 unsupported 链路没有静默登记授权。 */
function getPermissionBrokerGrantCount(broker: PermissionBroker): number {
  return (broker as unknown as { taskGrants: Map<string, unknown> }).taskGrants.size
}

/** 构造可由测试 finally 幂等结束的 ACP Prompt。 */
function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createAdapterHarness(
  connection: acp.ClientSideConnection = {} as acp.ClientSideConnection,
  selected = true
): {
  adapter: GrokAcpAdapter
  internal: GrokAcpAdapterTestAccess
  events: AgentEvent[]
  permissions: AgentRuntimePermissionRequest[]
  statuses: AgentRuntimeStatus[]
  permissionCancellations: import('../../agent/agent-runtime-adapter').AgentRuntimePermissionCancellation[]
  availableCommands: AgentAvailableCommandSnapshot[]
} {
  const events: AgentEvent[] = []
  const permissions: AgentRuntimePermissionRequest[] = []
  const statuses: AgentRuntimeStatus[] = []
  const permissionCancellations: import('../../agent/agent-runtime-adapter').AgentRuntimePermissionCancellation[] =
    []
  const availableCommands: AgentAvailableCommandSnapshot[] = []
  const adapter = new GrokAcpAdapter(
    {
      onStatus: (status) => statuses.push(status),
      onEvent: (event) => events.push(event),
      onPermission: (request) => permissions.push(request),
      onPermissionCancelled: (request) => permissionCancellations.push(request),
      onAvailableCommands: (snapshot) => availableCommands.push(snapshot)
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

  return {
    adapter,
    internal,
    events,
    permissions,
    statuses,
    permissionCancellations,
    availableCommands
  }
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
    toolCallAuthorizationSnapshots: new Map(),
    terminalToolCallIds: new Set(),
    rejectAllToolPermissions: false,
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
  optionId,
  toolCallId = 'tool-1',
  kind,
  path,
  content
}: {
  title?: string
  optionId: string
  toolCallId?: string
  kind?: acp.ToolKind
  path?: string
  content?: acp.ToolCallContent[]
}): acp.RequestPermissionRequest {
  return {
    sessionId: 'runtime-session-1',
    toolCall: {
      toolCallId,
      title,
      ...(kind ? { kind } : {}),
      ...(path ? { locations: [{ path }] } : {}),
      ...(content ? { content } : {})
    },
    options: [{ optionId, name: '允许一次', kind: 'allow_once' }]
  }
}

/** 构造可包含多个单次或持久选项的 ACP 权限请求，用于验证安全选项筛选。 */
function permissionRequestWithOptions(
  options: acp.PermissionOption[]
): acp.RequestPermissionRequest {
  return {
    sessionId: 'runtime-session-1',
    toolCall: {
      toolCallId: 'tool-1',
      title: '执行测试命令',
      kind: 'execute'
    },
    options
  }
}

/** 显式标注 ACP 选项类型，避免测试夹具将 always 选项伪装成单次授权。 */
function permissionOption(optionId: string, kind: acp.PermissionOptionKind): acp.PermissionOption {
  return { optionId, name: `测试选项 ${kind}`, kind }
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
