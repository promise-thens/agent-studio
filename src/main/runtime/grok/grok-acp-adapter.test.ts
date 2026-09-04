import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
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
  type AgentRuntimeQuestionRequest,
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
import { AGENT_STUDIO_MODEL_API_KEY_ENV } from '../../provider/grok-provider-config'
import { PermissionAuditStore } from '../../security/permission-audit-store'
import { PermissionBroker } from '../../security/permission-broker'
import { parseCommandExecutionEvidence } from '../../../shared/command'
import { CommandEvidenceStore } from '../../command/command-evidence-store'
import { createLocalEnvironmentId } from '../../security/permission-policy'
import {
  AGENT_STUDIO_MODEL_ALIAS,
  GROK_PRODUCTION_AGENT_ARGV,
  GROK_SET_MODEL_METHOD,
  buildGrokControlledE2ESpawnArgs
} from './grok-acp-dialect'
import {
  CONTROLLED_ACP_E2E_DIRECTORIES,
  CONTROLLED_ACP_E2E_FIXTURE_FILE,
  type ControlledAcpFixtureLaunch
} from './controlled-acp-fixture'
import {
  GrokAcpAdapter,
  GROK_CONTEXT_USAGE_POLL_MS,
  buildGrokRuntimeEnvironment
} from './grok-acp-adapter'
import { deriveGrokRuntimeCommandId } from './grok-command-evidence-mapper'
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

  it.each<acp.ToolKind>(['read', 'search'])(
    '%s 带可信路径时映射为项目内读取，不得落到 unknown',
    (kind) => {
      const request = mapGrokPermissionRequest(
        permissionRequest({
          optionId: 'allow-once',
          kind,
          path: '/tmp/project/src/notes.ts'
        }),
        `permission-${kind}-path`,
        'task-from-service',
        'turn-from-service',
        redactFakeText,
        true
      )

      expect(request).toMatchObject({
        operationType: 'read-project',
        targets: [{ kind: 'path', value: '/tmp/project/src/notes.ts' }],
        executionSupported: true
      })
      expect(request?.minimumRisk).toBeUndefined()
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
  it('initialize 使用 Main 注入的 clientInfo.version，不写死常量', async () => {
    const initialize = vi
      .fn()
      .mockResolvedValue(initializeResponse({ loadSession: true, resume: true }))
    const connection = { initialize } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, false, {
      getClientVersion: () => '0.1.0-test'
    })
    const child = {} as ChildProcessWithoutNullStreams
    harness.internal.process = child
    harness.internal.connectionGeneration = 1

    await expect(
      harness.internal.initializeConnection(connection, child, WORKSPACE, 1)
    ).resolves.toBe(true)

    expect(initialize).toHaveBeenCalledWith({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: {
        name: 'agent-studio',
        version: '0.1.0-test'
      }
    })
  })

  it('spawn ENOENT 状态文案归类为未安装 CLI，不含路径与 Node 原文', () => {
    const harness = createAdapterHarness(undefined, false)
    const child = {} as ChildProcessWithoutNullStreams
    harness.internal.process = child
    harness.internal.connectionGeneration = 1
    const spawnError = Object.assign(new Error('spawn /Users/tester/.grok/bin/grok ENOENT'), {
      code: 'ENOENT'
    })

    harness.internal.handleRuntimeProcessError(child, 1, WORKSPACE, spawnError)

    expect(harness.adapter.getStatus()).toMatchObject({
      state: 'error',
      workspace: WORKSPACE,
      message: '还没有安装 Grok Build CLI。'
    })
    expect(harness.adapter.getStatus().message).not.toContain('ENOENT')
    expect(harness.adapter.getStatus().message).not.toContain('/Users/tester')
    expect(harness.adapter.getStatus().message).not.toContain(FAKE_SECRET)
  })

  it('connect：握手流错误先于 spawn ENOENT 时仍抛出未安装 CLI（runtime-unavailable）', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'grok-cli-missing-race-'))
    const workspace = join(userDataPath, 'workspace')
    await mkdir(workspace)
    const child = createFakeSpawnChild()

    try {
      const adapter = new GrokAcpAdapter(
        {
          onStatus: () => undefined,
          onEvent: () => undefined,
          onPermission: () => undefined,
          onPermissionCancelled: () => undefined,
          onAvailableCommands: () => undefined
        },
        {
          userDataPath,
          getProviderConfig: () => providerConfig(),
          getClientVersion: () => '0.1.0-test',
          redactText: redactFakeText,
          // 备注：测试注入 spawn，避免 ESM 下无法 spy node:child_process.spawn。
          spawnProductionProcess: () => child
        }
      )
      const internal = adapter as unknown as GrokAcpAdapterTestAccess

      // 备注：握手先失败并进入 connect catch；ENOENT 用 setImmediate 晚到，复现竞态。
      vi.spyOn(internal, 'initializeConnection').mockImplementation(async () => {
        setImmediate(() => {
          child.emit(
            'error',
            Object.assign(new Error('spawn /Users/tester/.grok/bin/grok ENOENT'), {
              code: 'ENOENT'
            })
          )
        })
        throw new Error('NDJSON stream closed before initialize response')
      })

      await expect(adapter.connect(workspace)).rejects.toMatchObject({
        code: 'runtime-unavailable',
        message: '还没有安装 Grok Build CLI。'
      })
      expect(adapter.getStatus().message).toBe('还没有安装 Grok Build CLI。')
      expect(adapter.getStatus().message).not.toContain('连接失败')
      expect(adapter.getStatus().message).not.toContain('ENOENT')
      expect(adapter.getStatus().message).not.toContain('/Users/tester')
    } finally {
      await rm(userDataPath, { recursive: true, force: true })
    }
  })

  it('协议版本不兼容时状态与抛错保留协议语义，不再包成无法区分的连接失败', async () => {
    const initialize = vi.fn().mockResolvedValue({
      protocolVersion: acp.PROTOCOL_VERSION + 1,
      agentCapabilities: {}
    } as acp.InitializeResponse)
    const connection = { initialize } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, false, {
      getClientVersion: () => '0.1.0-test'
    })
    const child = {
      kill: vi.fn(),
      stdin: { destroyed: true },
      stdout: { destroyed: true },
      stderr: { destroyed: true, setEncoding: vi.fn(), on: vi.fn() }
    } as unknown as ChildProcessWithoutNullStreams
    harness.internal.process = child
    harness.internal.connection = connection
    harness.internal.connectionGeneration = 1

    await expect(
      harness.internal.initializeConnection(connection, child, WORKSPACE, 1)
    ).rejects.toThrow(/ACP 协议版本不兼容/)

    // 备注：connect() 捕获后应直接透出协议文案；此处验证 resolve 路径与产品常量一致。
    const connectFailure = harness.internal.resolveConnectFailure(
      new Error(
        `ACP 协议版本不兼容：Runtime 返回 ${acp.PROTOCOL_VERSION + 1}，客户端支持 ${acp.PROTOCOL_VERSION}。`
      )
    )
    expect(connectFailure.code).toBe('operation-failed')
    expect(connectFailure.message).toContain('ACP 协议版本不兼容')
    expect(connectFailure.message).not.toMatch(/^连接失败/)
  })

  it('Provider 缺失与 set_model 失败文案保持可区分', async () => {
    const missingProvider = createAdapterHarness(undefined, false, {
      getProviderConfig: () => null
    })
    // 备注：harness 默认会塞假 connection；connect 早退前必须清掉，才能走到 Provider 校验。
    missingProvider.internal.connection = null
    missingProvider.internal.status = {
      ...missingProvider.internal.status,
      state: 'idle',
      message: '尚未连接 Grok Build',
      workspace: undefined,
      runtimeSessionId: undefined
    }
    await expect(missingProvider.adapter.connect(WORKSPACE)).rejects.toMatchObject({
      code: 'runtime-unavailable',
      message: '模型服务配置不可用，请重新配置 URL、Key 和模型。'
    })

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
    expect(harness.adapter.getStatus().message).toMatch(
      /绑定 Agent Studio 模型失败|未确认 Agent Studio 模型绑定/
    )
    expect(harness.adapter.getStatus().message).not.toBe(
      '模型服务配置不可用，请重新配置 URL、Key 和模型。'
    )
    expect(harness.adapter.getStatus().message).not.toBe('还没有安装 Grok Build CLI。')
  })

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
    expect(request).toHaveBeenCalledWith(GROK_SET_MODEL_METHOD, {
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

  it('newSession 收到非空 mcpServers；默认无配置时仍是空数组', async () => {
    const newSession = vi.fn().mockResolvedValue({ sessionId: 'runtime-session-mcp' })
    const request = vi.fn().mockResolvedValue({})
    const connection = {
      newSession,
      request
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, false)
    await harness.adapter.createSession({
      workspace: WORKSPACE,
      taskId: 'task-mcp',
      mcpServers: [
        {
          name: 'docs',
          transport: 'http',
          url: 'https://example.com/mcp',
          headers: []
        }
      ]
    })
    expect(newSession).toHaveBeenCalledWith({
      cwd: WORKSPACE,
      mcpServers: [
        {
          type: 'http',
          name: 'docs',
          url: 'https://example.com/mcp',
          headers: []
        }
      ]
    })
  })

  it('接管 Task 的 newSession 才带且仅带 _meta.yoloMode: true', async () => {
    const newSession = vi.fn().mockResolvedValue({ sessionId: 'runtime-session-yolo' })
    const request = vi.fn().mockResolvedValue({})
    const connection = {
      newSession,
      request
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, false)

    await harness.adapter.createSession({
      workspace: WORKSPACE,
      taskId: 'task-takeover',
      takeoverEnabled: true
    })

    expect(newSession).toHaveBeenCalledWith({
      cwd: WORKSPACE,
      mcpServers: [],
      _meta: { yoloMode: true }
    })
    const params = newSession.mock.calls[0]?.[0] as { _meta?: Record<string, unknown> }
    expect(Object.keys(params._meta ?? {})).toEqual(['yoloMode'])
  })

  it('takeoverEnabled 为 false 或省略时 newSession 不得出现 _meta', async () => {
    const newSession = vi.fn().mockResolvedValue({ sessionId: 'runtime-session-plain' })
    const request = vi.fn().mockResolvedValue({})
    const connection = {
      newSession,
      request
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, false)

    await harness.adapter.createSession({
      workspace: WORKSPACE,
      taskId: 'task-false',
      takeoverEnabled: false
    })
    expect(newSession).toHaveBeenCalledWith({ cwd: WORKSPACE, mcpServers: [] })
    expect(newSession.mock.calls[0]?.[0]).not.toHaveProperty('_meta')

    await harness.adapter.createSession({
      workspace: WORKSPACE,
      taskId: 'task-omit'
    })
    expect(newSession).toHaveBeenLastCalledWith({ cwd: WORKSPACE, mcpServers: [] })
    expect(newSession.mock.calls[1]?.[0]).not.toHaveProperty('_meta')
  })

  it('mcp 非空时普通 Task 仍无 _meta，接管 Task 只多 yoloMode', async () => {
    const mcpServers = [
      {
        name: 'docs',
        transport: 'http' as const,
        url: 'https://example.com/mcp',
        headers: []
      }
    ]
    const expectedMcp = [
      {
        type: 'http',
        name: 'docs',
        url: 'https://example.com/mcp',
        headers: []
      }
    ]

    const plainNewSession = vi.fn().mockResolvedValue({ sessionId: 'runtime-session-mcp-plain' })
    const plainHarness = createAdapterHarness(
      {
        newSession: plainNewSession,
        request: vi.fn().mockResolvedValue({})
      } as unknown as acp.ClientSideConnection,
      false
    )
    await plainHarness.adapter.createSession({
      workspace: WORKSPACE,
      taskId: 'task-mcp-plain',
      mcpServers
    })
    expect(plainNewSession).toHaveBeenCalledWith({
      cwd: WORKSPACE,
      mcpServers: expectedMcp
    })
    expect(plainNewSession.mock.calls[0]?.[0]).not.toHaveProperty('_meta')

    const yoloNewSession = vi.fn().mockResolvedValue({ sessionId: 'runtime-session-mcp-yolo' })
    const yoloHarness = createAdapterHarness(
      {
        newSession: yoloNewSession,
        request: vi.fn().mockResolvedValue({})
      } as unknown as acp.ClientSideConnection,
      false
    )
    await yoloHarness.adapter.createSession({
      workspace: WORKSPACE,
      taskId: 'task-mcp-yolo',
      mcpServers,
      takeoverEnabled: true
    })
    expect(yoloNewSession).toHaveBeenCalledWith({
      cwd: WORKSPACE,
      mcpServers: expectedMcp,
      _meta: { yoloMode: true }
    })
    const yoloParams = yoloNewSession.mock.calls[0]?.[0] as { _meta?: Record<string, unknown> }
    expect(Object.keys(yoloParams._meta ?? {})).toEqual(['yoloMode'])
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
        GROK_SET_MODEL_METHOD,
        {
          sessionId: 'runtime-session-a',
          modelId: AGENT_STUDIO_MODEL_ALIAS
        }
      ],
      [
        GROK_SET_MODEL_METHOD,
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
    expect(request).toHaveBeenCalledWith(GROK_SET_MODEL_METHOD, {
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

  it('ACP 没有 usage_update 时从当前 session signals 补发 context usage', async () => {
    const signalsRoot = await mkdtemp(join(tmpdir(), 'grok-session-signals-adapter-'))
    const signalsDirectory = join(
      signalsRoot,
      'sessions',
      encodeURIComponent(WORKSPACE),
      'runtime-session-1'
    )
    await mkdir(signalsDirectory, { recursive: true })
    await writeFile(
      join(signalsDirectory, 'signals.json'),
      JSON.stringify({
        contextTokensUsed: 18941,
        contextWindowTokens: 32768,
        contextWindowUsage: 57
      })
    )
    const prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' as const })
    const connection = { prompt } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, true, {
      grokSessionSignalsRoot: signalsRoot
    })

    await expect(
      harness.adapter.startTurn(turnContext('task-usage', 'turn-usage'))
    ).resolves.toEqual({ outcome: 'completed' })

    expect(harness.events.map((event) => event.kind)).toEqual(['usage', 'turn-complete'])
    expect(harness.events[0]).toMatchObject({
      kind: 'usage',
      taskId: 'task-usage',
      turnId: 'turn-usage',
      capabilityState: 'experimental',
      usage: { scope: 'context', usedTokens: 18941, limitTokens: 32768 }
    })
    await rm(signalsRoot, { recursive: true, force: true })
  })

  it('Turn 进行中会轮询 signals.json，用量变化必须在 prompt 返回前发出', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const signalsRoot = await mkdtemp(join(tmpdir(), 'grok-session-signals-poll-'))
    const signalsDirectory = join(
      signalsRoot,
      'sessions',
      encodeURIComponent(WORKSPACE),
      'runtime-session-1'
    )
    await mkdir(signalsDirectory, { recursive: true })
    const signalsPath = join(signalsDirectory, 'signals.json')
    await writeFile(
      signalsPath,
      JSON.stringify({
        contextTokensUsed: 100,
        contextWindowTokens: 1000,
        contextWindowUsage: 10
      })
    )
    let releasePrompt: (() => void) | undefined
    const prompt = vi.fn().mockImplementation(
      () =>
        new Promise<{ stopReason: 'end_turn' }>((resolve) => {
          releasePrompt = () => resolve({ stopReason: 'end_turn' })
        })
    )
    const connection = { prompt } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, true, {
      grokSessionSignalsRoot: signalsRoot
    })

    try {
      const turnPromise = harness.adapter.startTurn(
        turnContext('task-usage-poll', 'turn-usage-poll')
      )
      await vi.waitFor(() => {
        expect(harness.events.some((event) => event.kind === 'usage')).toBe(true)
      })
      expect(harness.events[0]).toMatchObject({
        kind: 'usage',
        usage: { scope: 'context', usedTokens: 100, limitTokens: 1000 }
      })

      await writeFile(
        signalsPath,
        JSON.stringify({
          contextTokensUsed: 420,
          contextWindowTokens: 1000,
          contextWindowUsage: 42
        })
      )
      await vi.advanceTimersByTimeAsync(GROK_CONTEXT_USAGE_POLL_MS)
      await vi.waitFor(() => {
        expect(
          harness.events.filter(
            (event) =>
              event.kind === 'usage' &&
              event.usage.scope === 'context' &&
              event.usage.usedTokens === 420
          )
        ).toHaveLength(1)
      })

      releasePrompt?.()
      await expect(turnPromise).resolves.toEqual({ outcome: 'completed' })
    } finally {
      vi.useRealTimers()
      await rm(signalsRoot, { recursive: true, force: true })
    }
  })

  it('原生 usage_update 与 signals 同值时只发布一条 context usage', async () => {
    const signalsRoot = await mkdtemp(join(tmpdir(), 'grok-session-signals-dedupe-'))
    const signalsDirectory = join(
      signalsRoot,
      'sessions',
      encodeURIComponent(WORKSPACE),
      'runtime-session-1'
    )
    await mkdir(signalsDirectory, { recursive: true })
    await writeFile(
      join(signalsDirectory, 'signals.json'),
      JSON.stringify({ contextTokensUsed: 10, contextWindowTokens: 20, contextWindowUsage: 50 })
    )
    const prompt = vi.fn()
    const connection = { prompt } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, true, {
      grokSessionSignalsRoot: signalsRoot
    })
    prompt.mockImplementation(async () => {
      harness.internal.handleSessionUpdate(
        notification({
          sessionUpdate: 'usage_update',
          used: 10,
          size: 20,
          cost: { amount: 0, currency: 'USD' }
        } as acp.SessionUpdate),
        connection
      )
      return { stopReason: 'end_turn' as const }
    })

    await expect(
      harness.adapter.startTurn(turnContext('task-usage', 'turn-dedupe'))
    ).resolves.toEqual({ outcome: 'completed' })
    expect(harness.events.filter((event) => event.kind === 'usage')).toHaveLength(1)
    expect(harness.events.at(-1)).toMatchObject({ kind: 'turn-complete', outcome: 'completed' })
    await rm(signalsRoot, { recursive: true, force: true })
  })

  it('signals 缺失或损坏不阻断 Turn，也不产生伪造 usage 事件', async () => {
    const signalsRoot = await mkdtemp(join(tmpdir(), 'grok-session-signals-missing-'))
    const prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' as const })
    const connection = { prompt } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, true, {
      grokSessionSignalsRoot: signalsRoot
    })

    await expect(
      harness.adapter.startTurn(turnContext('task-usage', 'turn-missing'))
    ).resolves.toEqual({ outcome: 'completed' })
    expect(harness.events.map((event) => event.kind)).toEqual(['turn-complete'])
    await rm(signalsRoot, { recursive: true, force: true })
  })

  it('Runtime 图片落盘后按 text → attachment → text → terminal 顺序发布', async () => {
    const prompt = vi.fn()
    const stored = deferred<{
      attachmentId: string
      attachmentKind: 'image'
      originalName: string
    }>()
    const storeRuntimeImage = vi.fn(() => stored.promise)
    const connection = { prompt } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, true, { storeRuntimeImage })
    prompt.mockImplementation(async () => {
      harness.internal.handleSessionUpdate(
        notification({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'message-1',
          content: { type: 'text', text: '前' }
        }),
        connection
      )
      harness.internal.handleSessionUpdate(
        notification({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'message-1',
          content: {
            type: 'image',
            data: 'iVBORw0KGgoBAgME',
            mimeType: 'image/png',
            uri: 'file:///private/secret.png'
          }
        }),
        connection
      )
      harness.internal.handleSessionUpdate(
        notification({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'message-1',
          content: { type: 'text', text: '后' }
        }),
        connection
      )
      return { stopReason: 'end_turn' as const }
    })

    const execution = harness.adapter.startTurn(turnContext('task-image', 'turn-image'))
    await vi.waitFor(() => expect(storeRuntimeImage).toHaveBeenCalledTimes(1))
    expect(harness.events.map((event) => event.kind)).toEqual(['agent-message'])
    stored.resolve({
      attachmentId: 'attachment-runtime-1',
      attachmentKind: 'image',
      originalName: 'runtime-image.png'
    })
    await expect(execution).resolves.toEqual({ outcome: 'completed' })

    expect(storeRuntimeImage).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-image',
        turnId: 'turn-image',
        originalName: 'runtime-image.png',
        mimeType: 'image/png'
      })
    )
    expect(harness.events.map((event) => [event.sequence, event.kind])).toEqual([
      [1, 'agent-message'],
      [2, 'agent-attachment'],
      [3, 'agent-message'],
      [4, 'turn-complete']
    ])
    expect(JSON.stringify(harness.events)).not.toContain('private/secret')
    expect(JSON.stringify(harness.events)).not.toContain('iVBOR')
  })

  it('Runtime 图片入库失败只产生一次可恢复错误，不阻断 Turn 终态', async () => {
    const prompt = vi.fn()
    const connection = { prompt } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, true, {
      storeRuntimeImage: vi.fn(async () => {
        throw new Error(`private ${FAKE_SECRET}`)
      })
    })
    prompt.mockImplementation(async () => {
      for (let index = 0; index < 2; index += 1) {
        harness.internal.handleSessionUpdate(
          notification({
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'image',
              data: 'iVBORw0KGgoBAgME',
              mimeType: 'image/png'
            }
          }),
          connection
        )
      }
      return { stopReason: 'end_turn' as const }
    })

    await expect(
      harness.adapter.startTurn(turnContext('task-image', 'turn-image'))
    ).resolves.toEqual({ outcome: 'completed' })
    expect(harness.events.filter((event) => event.kind === 'error')).toEqual([
      expect.objectContaining({
        code: 'runtime-attachment-rejected',
        recoverable: true
      })
    ])
    expect(harness.events.at(-1)).toMatchObject({ kind: 'turn-complete', outcome: 'completed' })
    expect(JSON.stringify(harness.events)).not.toContain(FAKE_SECRET)
  })

  it('Grok 生图 tool_call 把 session 图片入库，事件不含绝对路径', async () => {
    const mediaRoot = await mkdtemp(join(tmpdir(), 'grok-session-media-'))
    const relative = join('sess-1', 'images', '1.png')
    const filePath = join(mediaRoot, relative)
    await mkdir(join(mediaRoot, 'sess-1', 'images'), { recursive: true })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    await writeFile(filePath, png)
    const prompt = vi.fn()
    const storeRuntimeImage = vi.fn(async () => ({
      attachmentId: 'attachment-session-1',
      attachmentKind: 'image' as const,
      originalName: '1.png'
    }))
    const connection = { prompt } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, true, {
      storeRuntimeImage,
      grokSessionMediaRoot: mediaRoot
    })
    prompt.mockImplementation(async () => {
      harness.internal.handleSessionUpdate(
        notification({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-image-1',
          title: 'image_gen',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: JSON.stringify({
                  path: filePath,
                  filename: '1.png',
                  session_folder: 'images',
                  message: `Image generated and saved to ${filePath}.`
                })
              }
            }
          ]
        }),
        connection
      )
      harness.internal.handleSessionUpdate(
        notification({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'images/1.png' }
        }),
        connection
      )
      return { stopReason: 'end_turn' as const }
    })

    await expect(
      harness.adapter.startTurn(turnContext('task-image', 'turn-image'))
    ).resolves.toEqual({ outcome: 'completed' })
    expect(storeRuntimeImage).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-image',
        turnId: 'turn-image',
        originalName: '1.png',
        mimeType: 'image/png'
      })
    )
    expect(harness.events.map((event) => event.kind)).toEqual([
      'tool-update',
      'agent-attachment',
      'agent-message',
      'turn-complete'
    ])
    const serialized = JSON.stringify(harness.events)
    expect(serialized).not.toContain(filePath)
    expect(serialized).not.toContain(mediaRoot)
    await rm(mediaRoot, { recursive: true, force: true })
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

  it('接住 Grok x.ai/ask_user_question，并把回答映射回 accepted outcome', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)

    const responsePromise = harness.internal.handleExtensionMethod(
      'x.ai/ask_user_question',
      {
        sessionId: 'runtime-session-1',
        toolCallId: 'tool-question',
        mode: 'plan',
        questions: [
          {
            id: 'scope',
            question: '选择范围',
            options: [{ id: 'frontend', label: '前端', description: '只改界面' }]
          }
        ]
      },
      connection
    )

    expect(harness.questions[0]).toMatchObject({
      taskId: 'task-current',
      turnId: 'turn-current',
      questions: [{ id: 'scope', kind: 'single', options: [{ value: 'frontend' }] }]
    })
    harness.adapter.respondQuestion(harness.questions[0].requestId, {
      action: 'accept',
      answers: { scope: 'frontend' }
    })
    await expect(responsePromise).resolves.toEqual({
      outcome: 'accepted',
      answers: { 选择范围: ['前端'] },
      annotations: {}
    })
  })

  it('兼容 Grok ACP 的 `_x.ai/ask_user_question` 扩展方法前缀，并返回 outcome', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)

    const responsePromise = harness.internal.handleExtensionMethod(
      '_x.ai/ask_user_question',
      {
        sessionId: 'runtime-session-1',
        questions: [
          {
            question: '选择范围',
            options: [{ label: '前端', description: '只改界面' }]
          }
        ]
      },
      connection
    )

    expect(harness.questions).toHaveLength(1)
    harness.adapter.respondQuestion(harness.questions[0].requestId, {
      action: 'accept',
      answers: { 'question-1': '前端' }
    })
    await expect(responsePromise).resolves.toMatchObject({
      outcome: 'accepted',
      answers: { 选择范围: ['前端'] }
    })
  })

  it('ACP JSON-RPC 方法 ext_method 要拆出内部 x.ai/ask_user_question 再弹出问答卡', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)

    const responsePromise = harness.internal.handleExtensionMethod(
      'ext_method',
      {
        method: 'x.ai/ask_user_question',
        params: {
          sessionId: 'runtime-session-1',
          toolCallId: 'call-ask-1',
          mode: 'default',
          questions: [
            {
              question: '你现在最想先解决哪一件事?',
              options: [{ label: '改代码', description: '修改现有实现' }]
            }
          ]
        }
      },
      connection
    )

    expect(harness.questions).toHaveLength(1)
    expect(harness.questions[0].questions[0]).toMatchObject({
      question: '你现在最想先解决哪一件事?',
      kind: 'single'
    })
    harness.adapter.respondQuestion(harness.questions[0].requestId, {
      action: 'accept',
      answers: { 'question-1': '改代码' }
    })
    // Grok 把 JSON-RPC result 直接当成 AskUserQuestionExtResponse；Accepted 必须带 answers + annotations。
    await expect(responsePromise).resolves.toEqual({
      outcome: 'accepted',
      answers: { '你现在最想先解决哪一件事?': ['改代码'] },
      annotations: {}
    })
  })

  it('ACP 把 Grok AskUserQuestion 参数当成 JSON 字符串时仍弹出问答卡', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)

    const payload = {
      sessionId: 'runtime-session-1',
      toolCallId: 'call-ask-1',
      mode: 'default',
      questions: [
        {
          question: '你现在最想先解决哪一件事?',
          options: [
            { label: '改代码', description: '修改现有实现' },
            { label: '查 bug', description: '定位失败原因' }
          ]
        }
      ]
    }
    const responsePromise = harness.internal.handleExtensionMethod(
      'x.ai/ask_user_question',
      JSON.stringify(payload) as unknown as Record<string, unknown>,
      connection
    )

    expect(harness.questions).toHaveLength(1)
    expect(harness.questions[0].questions[0]).toMatchObject({
      question: '你现在最想先解决哪一件事?',
      kind: 'single'
    })
    harness.adapter.respondQuestion(harness.questions[0].requestId, {
      action: 'accept',
      answers: { 'question-1': '改代码' }
    })
    await expect(responsePromise).resolves.toMatchObject({
      outcome: 'accepted',
      answers: { '你现在最想先解决哪一件事?': ['改代码'] }
    })
  })

  it('兼容 Grok 1.0.13 的 askUserQuestion 方法名，缺 label 的选项不能整卡取消', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)

    const responsePromise = harness.internal.handleExtensionMethod(
      'askUserQuestion',
      {
        sessionId: 'runtime-session-1',
        toolCallId: 'call-ask-2',
        mode: 'default',
        questions: [
          {
            question: '你现在最想先解决哪一件事?',
            options: [
              { description: '没有 label 的坏选项' },
              { label: '改代码', description: '修改现有实现' }
            ]
          }
        ]
      },
      connection
    )

    expect(harness.questions).toHaveLength(1)
    expect(harness.questions[0].questions[0].options).toEqual([
      expect.objectContaining({ label: '改代码', value: '改代码' })
    ])
    harness.adapter.respondQuestion(harness.questions[0].requestId, {
      action: 'accept',
      answers: { 'question-1': '改代码' }
    })
    await expect(responsePromise).resolves.toMatchObject({
      outcome: 'accepted',
      answers: { '你现在最想先解决哪一件事?': ['改代码'] }
    })
  })

  it('兼容 Grok 真实版本使用的裸 `ask_user_question` 扩展方法名', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)

    const responsePromise = harness.internal.handleExtensionMethod(
      'ask_user_question',
      {
        sessionId: 'runtime-session-1',
        questions: [{ question: '选择范围', options: [{ label: '前端' }] }]
      },
      connection
    )

    expect(harness.questions).toHaveLength(1)
    harness.adapter.respondQuestion(harness.questions[0].requestId, {
      action: 'accept',
      answers: { 'question-1': '前端' }
    })
    await expect(responsePromise).resolves.toMatchObject({
      outcome: 'accepted',
      answers: { 选择范围: ['前端'] }
    })
  })

  it('代次漂移但仍是同一 logical Turn 时，accept 不能被强制改写成 cancel', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    const activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    harness.internal.activeTurn = activeTurn

    const responsePromise = harness.internal.handleExtensionMethod(
      '_x.ai/ask_user_question',
      {
        sessionId: 'runtime-session-1',
        questions: [
          {
            question: '选择范围',
            options: [{ label: '前端' }, { label: '后端' }]
          }
        ]
      },
      connection
    )
    expect(harness.questions).toHaveLength(1)

    // 模拟 sessionGeneration 漂移：activeTurn 对象仍在，但 isActiveTurnCurrent 会失败。
    ;(harness.internal as { sessionGeneration: number }).sessionGeneration += 1
    harness.adapter.respondQuestion(harness.questions[0].requestId, {
      action: 'accept',
      answers: { 'question-1': '前端' },
      annotations: { 'question-1': { notes: '仍要前端优先' } }
    })
    // 必须仍是 accepted+annotations；绝不能被映射成 cancel→skip_interview。
    await expect(responsePromise).resolves.toEqual({
      outcome: 'accepted',
      answers: { 选择范围: ['前端'] },
      annotations: { 选择范围: { notes: '仍要前端优先' } }
    })
  })

  it('chat-about-this / skip / cancel 只使用 AskUserQuestionExtResponse 合法变体', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)

    const chatPromise = harness.internal.handleExtensionMethod(
      'x.ai/ask_user_question',
      {
        sessionId: 'runtime-session-1',
        questions: [{ question: '选择范围', options: [{ label: '前端' }, { label: '后端' }] }]
      },
      connection
    )
    harness.adapter.respondQuestion(harness.questions[0].requestId, {
      action: 'chat-about-this',
      partialAnswers: { 'question-1': '前端' }
    })
    await expect(chatPromise).resolves.toEqual({
      outcome: 'chat_about_this',
      partial_answers: { 选择范围: '前端' }
    })

    const skipPromise = harness.internal.handleExtensionMethod(
      'ask_user_question',
      {
        sessionId: 'runtime-session-1',
        questions: [{ question: '下一步?', options: [{ label: '继续' }] }]
      },
      connection
    )
    const skipRequest = harness.questions.at(-1)
    expect(skipRequest).toBeTruthy()
    harness.adapter.respondQuestion(skipRequest!.requestId, {
      action: 'skip',
      partialAnswers: { 'question-1': '继续' }
    })
    await expect(skipPromise).resolves.toEqual({
      outcome: 'skip_interview',
      partial_answers: { '下一步?': '继续' }
    })

    // Grok 二进制无 cancelled 变体；用户取消必须投影成 skip_interview。
    const cancelPromise = harness.internal.handleExtensionMethod(
      '_x.ai/ask_user_question',
      {
        sessionId: 'runtime-session-1',
        questions: [{ question: '还要继续吗?', options: [{ label: '是' }, { label: '否' }] }]
      },
      connection
    )
    const cancelRequest = harness.questions.at(-1)
    expect(cancelRequest).toBeTruthy()
    harness.adapter.respondQuestion(cancelRequest!.requestId, { action: 'cancel' })
    await expect(cancelPromise).resolves.toEqual({
      outcome: 'skip_interview',
      partial_answers: {}
    })
  })

  it('方法名未知但 params 带 questions 时仍弹出问答卡，绝不能回裸 {}', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)

    const responsePromise = harness.internal.handleExtensionMethod(
      'ext_method',
      {
        sessionId: 'runtime-session-1',
        questions: [
          {
            question: '你现在最想先解决哪一件事?',
            options: [{ label: '改代码', description: '修改现有实现' }]
          }
        ]
      },
      connection
    )

    expect(harness.questions).toHaveLength(1)
    harness.adapter.respondQuestion(harness.questions[0].requestId, {
      action: 'accept',
      answers: { 'question-1': '改代码' },
      annotations: { 'question-1': { notes: '优先修卡死' } }
    })
    await expect(responsePromise).resolves.toEqual({
      outcome: 'accepted',
      answers: { '你现在最想先解决哪一件事?': ['改代码'] },
      annotations: { '你现在最想先解决哪一件事?': { notes: '优先修卡死' } }
    })
  })

  it('sessionGeneration 漂移但同一 Turn 仍活动时，accept 不得被改写成 cancel', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    const activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    harness.internal.activeTurn = activeTurn

    const responsePromise = harness.internal.handleExtensionMethod(
      'ask_user_question',
      {
        sessionId: 'runtime-session-1',
        questions: [{ question: '选择范围', options: [{ label: '前端' }] }]
      },
      connection
    )
    expect(harness.questions).toHaveLength(1)

    // 模拟 activateSession / HMR 代次漂移；Turn 对象与身份仍在。
    harness.internal.sessionGeneration = 99

    harness.adapter.respondQuestion(harness.questions[0].requestId, {
      action: 'accept',
      answers: { 'question-1': '前端' }
    })
    await expect(responsePromise).resolves.toMatchObject({
      outcome: 'accepted',
      answers: { 选择范围: ['前端'] }
    })
  })

  it('Turn 对象已消失时，accept 强制 skip_interview，并标记 cancelReason=stale-turn', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    const traces: Record<string, unknown>[] = []
    vi.spyOn(
      harness.adapter as unknown as { traceAskProtocol: (event: Record<string, unknown>) => void },
      'traceAskProtocol'
    ).mockImplementation((event) => {
      traces.push(event)
    })

    const responsePromise = harness.internal.handleExtensionMethod(
      'ask_user_question',
      {
        sessionId: 'runtime-session-1',
        questions: [{ question: '选择范围', options: [{ label: '前端' }] }]
      },
      connection
    )
    expect(harness.questions).toHaveLength(1)
    harness.internal.activeTurn = null

    harness.adapter.respondQuestion(harness.questions[0].requestId, {
      action: 'accept',
      answers: { 'question-1': '前端' }
    })
    await expect(responsePromise).resolves.toEqual({
      outcome: 'skip_interview',
      partial_answers: {}
    })
    expect(
      traces.some(
        (event) => event.stage === 'ext-out' && event.cancelReason === 'stale-turn'
      )
    ).toBe(true)
  })

  it('提问挂起后 cancelRequested + 代次漂移时，accept 强制 stale-turn cancel', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    const activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    harness.internal.activeTurn = activeTurn
    const traces: Record<string, unknown>[] = []
    vi.spyOn(
      harness.adapter as unknown as { traceAskProtocol: (event: Record<string, unknown>) => void },
      'traceAskProtocol'
    ).mockImplementation((event) => {
      traces.push(event)
    })

    const responsePromise = harness.internal.handleExtensionMethod(
      'ask_user_question',
      {
        sessionId: 'runtime-session-1',
        questions: [{ question: '选择范围', options: [{ label: '前端' }] }]
      },
      connection
    )
    expect(harness.questions).toHaveLength(1)

    activeTurn.cancelRequested = true
    harness.internal.sessionGeneration = 42

    harness.adapter.respondQuestion(harness.questions[0].requestId, {
      action: 'accept',
      answers: { 'question-1': '前端' }
    })
    await expect(responsePromise).resolves.toEqual({
      outcome: 'skip_interview',
      partial_answers: {}
    })
    expect(
      traces.some(
        (event) => event.stage === 'ext-out' && event.cancelReason === 'stale-turn'
      )
    ).toBe(true)
  })

  it('ask 挂起时 emit turn-complete 不得 pending-clear，accept 仍可兑现', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    const activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    harness.internal.activeTurn = activeTurn
    const traces: Record<string, unknown>[] = []
    vi.spyOn(
      harness.adapter as unknown as { traceAskProtocol: (event: Record<string, unknown>) => void },
      'traceAskProtocol'
    ).mockImplementation((event) => {
      traces.push(event)
    })

    const responsePromise = harness.internal.handleExtensionMethod(
      'ask_user_question',
      {
        sessionId: 'runtime-session-1',
        questions: [{ question: '选择范围', options: [{ label: '前端' }] }]
      },
      connection
    )
    expect(harness.questions).toHaveLength(1)
    expect(harness.internal.pendingQuestions.size).toBe(1)

    const emitted = harness.internal.emitDraft(activeTurn, {
      ...createGrokEventBase('runtime-session-1', 'native'),
      kind: 'turn-complete',
      outcome: 'completed'
    })
    expect(emitted).toBeNull()
    expect(harness.events.filter((event) => event.kind === 'turn-complete')).toHaveLength(0)
    expect(harness.internal.pendingQuestions.size).toBe(1)
    expect(harness.internal.activeTurn).toBe(activeTurn)
    expect(
      traces.some(
        (event) => event.stage === 'turn-complete-deferred' && event.outcome === 'completed'
      )
    ).toBe(true)
    expect(traces.some((event) => event.cancelReason === 'pending-clear')).toBe(false)

    harness.adapter.respondQuestion(harness.questions[0].requestId, {
      action: 'accept',
      answers: { 'question-1': '前端' }
    })
    await expect(responsePromise).resolves.toEqual({
      outcome: 'accepted',
      answers: { 选择范围: ['前端'] },
      annotations: {}
    })
    expect(harness.events.some((event) => event.kind === 'turn-complete')).toBe(true)
    expect(harness.events.at(-1)).toMatchObject({
      kind: 'turn-complete',
      outcome: 'completed'
    })
    expect(harness.internal.activeTurn).toBeNull()
    expect(traces.some((event) => event.cancelReason === 'pending-clear')).toBe(false)
  })

  it('cancelTurn 仍以 cancelReason=cancel-turn 收束挂起问答', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const connection = { cancel } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    const activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    harness.internal.activeTurn = activeTurn
    const traces: Record<string, unknown>[] = []
    vi.spyOn(
      harness.adapter as unknown as { traceAskProtocol: (event: Record<string, unknown>) => void },
      'traceAskProtocol'
    ).mockImplementation((event) => {
      traces.push(event)
    })

    const responsePromise = harness.internal.handleExtensionMethod(
      'ask_user_question',
      {
        sessionId: 'runtime-session-1',
        questions: [{ question: '选择范围', options: [{ label: '前端' }] }]
      },
      connection
    )
    expect(harness.questions).toHaveLength(1)

    await harness.adapter.cancelTurn({
      taskId: 'task-current',
      turnId: 'turn-current',
      runtimeSessionId: 'runtime-session-1'
    })

    await expect(responsePromise).resolves.toEqual({
      outcome: 'skip_interview',
      partial_answers: {}
    })
    expect(harness.internal.pendingQuestions.size).toBe(0)
    expect(
      traces.some(
        (event) =>
          event.stage === 'ext-out' &&
          event.cancelReason === 'cancel-turn' &&
          event.clearSource === 'cancel-turn'
      )
    ).toBe(true)
    expect(cancel).toHaveBeenCalled()
  })

  it('prompt 先返回但 ask 仍挂起时，startTurn 等到 accept 后再 turn-complete', async () => {
    let askPromise: Promise<Record<string, unknown>> | undefined
    const prompt = vi.fn().mockImplementation(async () => {
      askPromise = harness.internal.handleExtensionMethod(
        'ask_user_question',
        {
          sessionId: 'runtime-session-1',
          questions: [{ question: '选择范围', options: [{ label: '前端' }] }]
        },
        connection
      )
      await Promise.resolve()
      return { stopReason: 'end_turn' as const }
    })
    const connection = { prompt } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    const traces: Record<string, unknown>[] = []
    vi.spyOn(
      harness.adapter as unknown as { traceAskProtocol: (event: Record<string, unknown>) => void },
      'traceAskProtocol'
    ).mockImplementation((event) => {
      traces.push(event)
    })

    const turnPromise = harness.adapter.startTurn(turnContext('task-hold', 'turn-hold'))
    await vi.waitFor(() => {
      expect(harness.questions.length).toBe(1)
    })
    expect(harness.events.some((event) => event.kind === 'turn-complete')).toBe(false)
    expect(traces.some((event) => event.stage === 'ask-hold-terminal')).toBe(true)

    harness.adapter.respondQuestion(harness.questions[0].requestId, {
      action: 'accept',
      answers: { 'question-1': '前端' }
    })
    await expect(turnPromise).resolves.toEqual({ outcome: 'completed' })
    await expect(askPromise!).resolves.toMatchObject({
      outcome: 'accepted',
      answers: { 选择范围: ['前端'] }
    })
    expect(traces.some((event) => event.cancelReason === 'pending-clear')).toBe(false)
    expect(harness.events.at(-1)).toMatchObject({
      kind: 'turn-complete',
      outcome: 'completed',
      taskId: 'task-hold',
      turnId: 'turn-hold'
    })
  })

    it('接住 Grok x.ai/exit_plan_mode，并把批准/放弃映射为计划终态', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)

    const responsePromise = harness.internal.handleExtensionMethod(
      'x.ai/exit_plan_mode',
      { sessionId: 'runtime-session-1', toolCallId: 'tool-exit', planContent: '1. 修改设置页' },
      connection
    )
    expect(harness.questions[0]).toMatchObject({
      kind: 'plan-approval',
      planContent: '1. 修改设置页'
    })
    harness.adapter.respondQuestion(harness.questions[0].requestId, { action: 'approve-plan' })
    await expect(responsePromise).resolves.toEqual({ outcome: 'approved' })
  })

  it('兼容 Grok 真实版本使用的裸 `exit_plan_mode` 扩展方法名', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)

    const responsePromise = harness.internal.handleExtensionMethod(
      'exit_plan_mode',
      { sessionId: 'runtime-session-1', planContent: '1. 修改设置页' },
      connection
    )
    expect(harness.questions[0]).toMatchObject({ kind: 'plan-approval' })
    harness.adapter.respondQuestion(harness.questions[0].requestId, { action: 'approve-plan' })
    await expect(responsePromise).resolves.toEqual({ outcome: 'approved' })
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

  it('只有 allow_always 时项目内读取不会 auto-allowed 或 grant-reused', async () => {
    const fixture = await createInvalidPermissionIntegrationFixture()
    try {
      const execution = fixture.startTurn('验证缺少 allow_once 不能假装自动过')
      await vi.waitFor(() => expect(fixture.internal.activeTurn).not.toBeNull())
      const acpResponse = fixture.internal.requestPermission(
        {
          sessionId: 'runtime-session-1',
          toolCall: {
            toolCallId: 'tool-read-always-only',
            title: '读取项目文件',
            kind: 'read',
            locations: [{ path: join(fixture.workspace, 'src/notes.ts') }]
          },
          options: [permissionOption('allow-always', 'allow_always')]
        },
        fixture.connection
      )

      await expect(acpResponse).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
      await vi.waitFor(() =>
        expect(fixture.broker.getPendingCount(fixture.taskId, fixture.turnId)).toBe(0)
      )
      expect(fixture.approvals).toHaveLength(0)
      expect(getPermissionBrokerGrantCount(fixture.broker)).toBe(0)
      expect(fixture.respondPermissionSpy).toHaveBeenCalledWith(expect.any(String), 'cancelled')

      const auditPage = await fixture.auditStore.list(fixture.taskId)
      expect(auditPage.items).toHaveLength(1)
      expect(auditPage.items[0]).toMatchObject({
        operationType: 'read-project',
        reason: 'unsupported',
        detail: 'Runtime 没提供一次性允许。'
      })
      expect(auditPage.items[0].reason).not.toBe('auto-allowed')
      expect(auditPage.items[0].reason).not.toBe('grant-reused')
      expect(JSON.stringify(auditPage.items[0])).not.toContain('allow_always')

      fixture.releasePrompt.resolve({ stopReason: 'end_turn' })
      await expect(execution).resolves.toMatchObject({ outcome: 'completed' })
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

  it('只有 allow_always 的项目内读取仍标记不可执行，且不回传 always', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    const responsePromise = harness.internal.requestPermission(
      permissionRequestWithOptions(
        [permissionOption('allow-always', 'allow_always')],
        'read',
        `${WORKSPACE}/src/notes.ts`
      ),
      connection
    )

    expect(harness.permissions[0]).toMatchObject({
      operationType: 'read-project',
      executionSupported: false,
      targets: [{ kind: 'path', value: `${WORKSPACE}/src/notes.ts` }]
    })
    expect(JSON.stringify(harness.permissions[0])).not.toContain('allow_always')
    harness.adapter.respondPermission(harness.permissions[0].requestId, 'allow-once')
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

  it('set_model 挂起时仍接受新 session 的 available_commands_update', async () => {
    let releaseSetModel: ((value: unknown) => void) | undefined
    const newSession = vi.fn().mockResolvedValue({ sessionId: 'runtime-session-new' })
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseSetModel = resolve
        })
    )
    const connection = {
      newSession,
      request
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection, false)

    const createPromise = harness.adapter.createSession({
      workspace: WORKSPACE,
      taskId: 'task-test'
    })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))

    harness.internal.handleSessionUpdate(
      {
        sessionId: 'runtime-session-new',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'compact', description: '压缩上下文' }]
        }
      },
      connection
    )

    expect(harness.availableCommands).toEqual([
      {
        taskId: 'task-test',
        revision: 1,
        commands: [{ name: 'compact', description: '压缩上下文' }]
      }
    ])
    expect(harness.events).toEqual([])

    releaseSetModel?.({})
    await createPromise
    expect(harness.internal.boundTaskId).toBe('task-test')
    expect(harness.internal.selectedSession?.runtimeSessionId).toBe('runtime-session-new')
  })

  it('load 返回后、set_model 完成前接受该 session 的命令快照', async () => {
    let releaseSetModel: ((value: unknown) => void) | undefined
    const loadSession = vi.fn().mockResolvedValue({})
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseSetModel = resolve
        })
    )
    const connection = {
      loadSession,
      request
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    setHandshakeSnapshot(harness.internal, { loadSession: true, resume: true })
    harness.internal.boundTaskId = 'task-old'
    harness.internal.selectedSession = runtimeSession('runtime-session-old')

    const loadPromise = harness.adapter.loadSession(
      runtimeSession('runtime-session-new'),
      'task-new'
    )
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))

    harness.internal.handleSessionUpdate(
      {
        sessionId: 'runtime-session-new',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'dream', description: '整理记忆' }]
        }
      },
      connection
    )

    expect(harness.availableCommands.at(-1)).toEqual({
      taskId: 'task-new',
      revision: expect.any(Number),
      commands: [{ name: 'dream', description: '整理记忆' }]
    })
    expect(harness.events).toEqual([])

    releaseSetModel?.({})
    await loadPromise
    expect(harness.internal.boundTaskId).toBe('task-new')
  })

  it('load 失败且未断开时回滚 boundTaskId，不把新 Task 绑到旧 session', async () => {
    const loadSession = vi.fn().mockRejectedValue(new Error('load exploded'))
    const request = vi.fn()
    const connection = {
      loadSession,
      request
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    setHandshakeSnapshot(harness.internal, { loadSession: true, resume: true })
    harness.internal.boundTaskId = 'task-a'
    harness.internal.selectedSession = runtimeSession('runtime-session-a')

    await expect(
      harness.adapter.loadSession(runtimeSession('runtime-session-b'), 'task-b')
    ).rejects.toMatchObject({ code: 'operation-failed' })

    expect(request).not.toHaveBeenCalled()
    expect(harness.internal.connection).toBe(connection)
    expect(harness.internal.boundTaskId).toBe('task-a')
    expect(harness.internal.selectedSession?.runtimeSessionId).toBe('runtime-session-a')

    harness.internal.handleSessionUpdate(
      {
        sessionId: 'runtime-session-a',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'compact', description: '压缩上下文' }]
        }
      },
      connection
    )
    expect(harness.availableCommands.at(-1)).toMatchObject({
      taskId: 'task-a',
      commands: [{ name: 'compact', description: '压缩上下文' }]
    })

    harness.internal.handleSessionUpdate(
      {
        sessionId: 'runtime-session-b',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'dream', description: '整理记忆' }]
        }
      },
      connection
    )
    expect(harness.availableCommands.map((snapshot) => snapshot.taskId)).not.toContain('task-b')
  })

  it('resume 失败且未断开时回滚 boundTaskId，不把新 Task 绑到旧 session', async () => {
    const resumeSession = vi.fn().mockRejectedValue(new Error('resume exploded'))
    const request = vi.fn()
    const connection = {
      resumeSession,
      request
    } as unknown as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    setHandshakeSnapshot(harness.internal, { loadSession: true, resume: true })
    harness.internal.boundTaskId = 'task-a'
    harness.internal.selectedSession = runtimeSession('runtime-session-a')

    await expect(
      harness.adapter.resumeSession(runtimeSession('runtime-session-b'), 'task-b')
    ).rejects.toMatchObject({ code: 'operation-failed' })

    expect(request).not.toHaveBeenCalled()
    expect(harness.internal.connection).toBe(connection)
    expect(harness.internal.boundTaskId).toBe('task-a')
    expect(harness.internal.selectedSession?.runtimeSessionId).toBe('runtime-session-a')
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
        NODE_OPTIONS: '--require malicious.js',
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_ENABLE_LOGGING: '1'
      }
    )

    expect(environment).toMatchObject({
      HOME: '/Users/tester',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      GROK_HOME: '/tmp/agent-studio-grok-home',
      GROK_MEMORY: '1',
      [AGENT_STUDIO_MODEL_API_KEY_ENV]: FAKE_SECRET
    })
    expect(environment.PATH).toContain('/usr/bin')
    expect(environment).not.toHaveProperty('NPM_TOKEN')
    expect(environment).not.toHaveProperty('XAI_API_KEY')
    expect(environment).not.toHaveProperty('NODE_OPTIONS')
    // 备注：生产 Runtime env 不得带入 Electron 调试变量；受控 E2E 才自行设置 ELECTRON_RUN_AS_NODE。
    expect(environment).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(environment).not.toHaveProperty('ELECTRON_ENABLE_LOGGING')
  })

  it('不继承宿主 GROK_MEMORY=0，关闭记忆时才显式传 0', () => {
    const inherited = buildGrokRuntimeEnvironment(providerConfig(), '/tmp/home', {
      PATH: '/usr/bin',
      GROK_MEMORY: '0'
    })
    expect(inherited.GROK_MEMORY).toBe('1')
    const disabled = buildGrokRuntimeEnvironment(
      providerConfig(),
      '/tmp/home',
      { PATH: '/usr/bin', GROK_MEMORY: '1' },
      { memoryEnabled: false }
    )
    expect(disabled.GROK_MEMORY).toBe('0')
  })

  it('生图 Base URL 跟 Provider 同源，不继承宿主 GROK_XAI_API_BASE_URL', () => {
    const environment = buildGrokRuntimeEnvironment(
      providerConfig(),
      '/tmp/agent-studio-grok-home',
      {
        PATH: '/usr/bin',
        GROK_XAI_API_BASE_URL: 'https://hostile.example/v1'
      }
    )

    expect(environment.GROK_XAI_API_BASE_URL).toBe('https://api.example.com/v1')
    expect(JSON.stringify(environment)).not.toContain('hostile.example')
  })
})

describe('Grok Runtime 受控 E2E fixture spawn', () => {
  it('fixture spawn 使用独立 argv 与 ELECTRON_RUN_AS_NODE，不含生产 --no-auto-update', async () => {
    const userDataPath = await realpath(
      await mkdtemp(join(tmpdir(), 'grok-controlled-fixture-spawn-'))
    )
    const workspace = join(userDataPath, CONTROLLED_ACP_E2E_DIRECTORIES.workspace)
    const traceDirectory = join(userDataPath, CONTROLLED_ACP_E2E_DIRECTORIES.trace)
    const barrierDirectory = join(userDataPath, CONTROLLED_ACP_E2E_DIRECTORIES.barriers)
    const runtimeHomeDirectory = join(userDataPath, CONTROLLED_ACP_E2E_DIRECTORIES.runtimeHome)
    await Promise.all(
      [workspace, traceDirectory, barrierDirectory, runtimeHomeDirectory].map((dir) =>
        mkdir(dir, { recursive: true })
      )
    )

    const repositoryRootPath = await realpath(process.cwd())
    const fixturePath = join(repositoryRootPath, 'tests', 'e2e', CONTROLLED_ACP_E2E_FIXTURE_FILE)
    const launch: ControlledAcpFixtureLaunch = {
      scenario: 'E2E:FIFO',
      repositoryRootPath,
      userDataPath,
      fixturePath,
      traceDirectory,
      barrierDirectory,
      runtimeHomeDirectory
    }

    const child = createFakeSpawnChild()
    let captured:
      | {
          command: string
          args: readonly string[]
          options: { cwd?: string; env?: NodeJS.ProcessEnv }
        }
      | undefined

    try {
      const adapter = new GrokAcpAdapter(
        {
          onStatus: () => undefined,
          onEvent: () => undefined,
          onPermission: () => undefined,
          onPermissionCancelled: () => undefined,
          onAvailableCommands: () => undefined
        },
        {
          userDataPath,
          getProviderConfig: () => providerConfig(),
          getClientVersion: () => '0.1.0-test',
          redactText: redactFakeText,
          controlledFixture: launch,
          // 备注：测试注入 spawn，避免 ESM 下无法 spy node:child_process.spawn。
          spawnControlledProcess: (command, args, options) => {
            captured = {
              command,
              args,
              options: options as { cwd?: string; env?: NodeJS.ProcessEnv }
            }
            return child
          }
        }
      )
      const internal = adapter as unknown as GrokAcpAdapterTestAccess
      vi.spyOn(internal, 'initializeConnection').mockResolvedValue(true)

      await adapter.connect(workspace)

      expect(captured).toBeDefined()
      expect(captured!.command).toBe(process.execPath)
      expect(captured!.args).toEqual(
        buildGrokControlledE2ESpawnArgs({
          fixturePath,
          scenario: 'E2E:FIFO',
          userDataPath
        })
      )
      expect(captured!.args).toContain('--scenario')
      expect(captured!.args).toContain('--user-data')
      expect(captured!.args).not.toContain('--no-auto-update')
      expect(captured!.args).not.toEqual([...GROK_PRODUCTION_AGENT_ARGV])
      expect(captured!.options.cwd).toBe(workspace)
      expect(captured!.options.env).toMatchObject({
        ELECTRON_RUN_AS_NODE: '1',
        HOME: runtimeHomeDirectory
      })
      expect(captured!.options.env).not.toHaveProperty(AGENT_STUDIO_MODEL_API_KEY_ENV)
      expect(captured!.options.env).not.toHaveProperty('PATH')
    } finally {
      await rm(userDataPath, { recursive: true, force: true })
    }
  })
})

describe('Grok Runtime 命令证据持久化', () => {
  const evidenceRoots: string[] = []

  afterEach(async () => {
    await Promise.all(
      evidenceRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    )
  })

  async function createEvidenceHarness(
    connection: acp.ClientSideConnection
  ): Promise<ReturnType<typeof createAdapterHarness> & { store: CommandEvidenceStore }> {
    const rootDir = await realpath(await mkdtemp(join(tmpdir(), 'grok-runtime-command-evidence-')))
    evidenceRoots.push(rootDir)
    const store = new CommandEvidenceStore({ rootDir })
    const harness = createAdapterHarness(connection, true, {
      commandEvidenceStore: store,
      resolveCommandEvidenceContext: () => ({ environmentId: 'env-1' })
    })
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    return { ...harness, store }
  }

  it('把成功的 execute 工具写入 runtime-tool 证据，且不经 AppCommandRunner', async () => {
    const connection = {} as acp.ClientSideConnection
    const { adapter, internal, store } = await createEvidenceHarness(connection)
    internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-bash-1',
        title: 'Run tests',
        kind: 'execute',
        status: 'completed',
        rawInput: { command: 'pnpm test' },
        rawOutput: { exit_code: 0, timed_out: false, output: 'ok' }
      }),
      connection
    )
    await adapter.waitForCommandEvidenceWrites()

    const commandId = deriveGrokRuntimeCommandId('task-current', 'turn-current', 'tool-bash-1')
    const evidence = await store.readEvidence('task-current', commandId)
    expect(parseCommandExecutionEvidence(evidence)).toMatchObject({
      source: 'runtime-tool',
      trustLevel: 'runtime-reported',
      status: 'succeeded',
      exitCode: 0,
      displayCommand: 'pnpm test',
      toolCallId: 'tool-bash-1'
    })
    expect(evidence?.approvalId).toBeUndefined()
  })

  it('自动过路径下 execute 仍写 runtime-tool 证据，不等用户点审批卡', async () => {
    const connection = {} as acp.ClientSideConnection
    const { adapter, internal, store, permissions } = await createEvidenceHarness(connection)
    const responsePromise = internal.requestPermission(
      permissionRequest({
        optionId: 'allow-once',
        toolCallId: 'tool-auto-allowed',
        kind: 'execute'
      }),
      connection
    )
    internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-auto-allowed',
        kind: 'execute',
        status: 'completed',
        rawInput: { command: 'pnpm test' },
        rawOutput: { exit_code: 0, timed_out: false, output: 'ok' }
      }),
      connection
    )
    await adapter.waitForCommandEvidenceWrites()

    const commandId = deriveGrokRuntimeCommandId(
      'task-current',
      'turn-current',
      'tool-auto-allowed'
    )
    const evidence = await store.readEvidence('task-current', commandId)
    expect(parseCommandExecutionEvidence(evidence)).toMatchObject({
      source: 'runtime-tool',
      trustLevel: 'runtime-reported',
      status: 'succeeded',
      displayCommand: 'pnpm test',
      toolCallId: 'tool-auto-allowed',
      approvalId: permissions[0]?.requestId
    })
    adapter.respondPermission(permissions[0].requestId, 'allow-once')
    await responsePromise
  })

  it('未见 ACP permission request 时不发明 approvalId', async () => {
    const connection = {} as acp.ClientSideConnection
    const { adapter, internal, store } = await createEvidenceHarness(connection)
    internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-no-permission',
        kind: 'execute',
        status: 'completed',
        rawInput: { command: 'ls' },
        rawOutput: { exit_code: 1, timed_out: false }
      }),
      connection
    )
    await adapter.waitForCommandEvidenceWrites()
    const commandId = deriveGrokRuntimeCommandId(
      'task-current',
      'turn-current',
      'tool-no-permission'
    )
    const evidence = await store.readEvidence('task-current', commandId)
    expect(evidence?.status).toBe('failed')
    expect(evidence?.approvalId).toBeUndefined()
    expect(JSON.stringify(evidence)).not.toContain('approvalId')
  })

  it('见过 ACP permission request 后把 requestId 记为 approvalId', async () => {
    const connection = {} as acp.ClientSideConnection
    const { adapter, internal, store, permissions } = await createEvidenceHarness(connection)
    const responsePromise = internal.requestPermission(
      permissionRequest({
        optionId: 'allow-once',
        toolCallId: 'tool-approved',
        kind: 'execute'
      }),
      connection
    )
    expect(permissions[0]?.requestId).toBeTruthy()
    internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-approved',
        kind: 'execute',
        status: 'completed',
        rawInput: { command: 'ls' },
        rawOutput: { exit_code: 0, timed_out: false, output: '' }
      }),
      connection
    )
    adapter.respondPermission(permissions[0].requestId, 'allow-once')
    await responsePromise
    await adapter.waitForCommandEvidenceWrites()

    const commandId = deriveGrokRuntimeCommandId('task-current', 'turn-current', 'tool-approved')
    const evidence = await store.readEvidence('task-current', commandId)
    expect(evidence).toMatchObject({
      approvalId: permissions[0].requestId,
      source: 'runtime-tool',
      status: 'succeeded'
    })
  })

  it('output_file 不作为路径写入 transcript 引用', async () => {
    const connection = {} as acp.ClientSideConnection
    const { adapter, internal, store } = await createEvidenceHarness(connection)
    const leakedPath = '/tmp/grok-output-file-must-not-appear.log'
    internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-output-file',
        title: 'Run tests',
        kind: 'execute',
        status: 'completed',
        rawInput: { command: 'pnpm test' },
        rawOutput: { exit_code: 0, timed_out: false, output_file: leakedPath }
      }),
      connection
    )
    await adapter.waitForCommandEvidenceWrites()
    const commandId = deriveGrokRuntimeCommandId('task-current', 'turn-current', 'tool-output-file')
    const evidence = await store.readEvidence('task-current', commandId)
    const transcript = evidence
      ? await store.readTranscript('task-current', evidence.transcriptRef.transcriptId)
      : null
    expect(evidence).toMatchObject({ truncated: true, outputFileNotIngested: true })
    expect(JSON.stringify(evidence)).not.toContain(leakedPath)
    expect(JSON.stringify(transcript)).not.toContain(leakedPath)
    expect(evidence?.transcriptRef).not.toHaveProperty('path')
  })

  it('终态写盘失败会留下 persistIncomplete，不得静默丢弃', async () => {
    const connection = {} as acp.ClientSideConnection
    const { adapter, internal, store } = await createEvidenceHarness(connection)
    vi.spyOn(store, 'writeEvidence').mockRejectedValueOnce(new Error('disk-full'))
    internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-persist-fail',
        title: 'Run tests',
        kind: 'execute',
        status: 'completed',
        rawInput: { command: 'pnpm test' },
        rawOutput: { exit_code: 2, timed_out: false, output: 'failed' }
      }),
      connection
    )
    await adapter.waitForCommandEvidenceWrites()
    expect(store.hasPersistIncomplete('task-current')).toBe(true)
    const commandId = deriveGrokRuntimeCommandId(
      'task-current',
      'turn-current',
      'tool-persist-fail'
    )
    expect(await store.readEvidence('task-current', commandId)).toBeNull()
  })

  it('落盘未完成时 waitForCommandEvidenceWrites 不会提前结束', async () => {
    const connection = {} as acp.ClientSideConnection
    const { adapter, internal, store } = await createEvidenceHarness(connection)
    const originalWrite = store.writeEvidence.bind(store)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(store, 'writeEvidence').mockImplementation(async (evidence) => {
      await gate
      return originalWrite(evidence)
    })
    internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-slow-write',
        title: 'ls',
        kind: 'execute',
        status: 'completed',
        rawInput: { command: 'ls' },
        rawOutput: { exit_code: 0, timed_out: false }
      }),
      connection
    )
    let settled = false
    const waiting = adapter.waitForCommandEvidenceWrites().then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await waiting
    const commandId = deriveGrokRuntimeCommandId('task-current', 'turn-current', 'tool-slow-write')
    expect(await store.readEvidence('task-current', commandId)).toMatchObject({
      status: 'succeeded',
      exitCode: 0
    })
  })

  it('未注入 store 时跳过持久化，既有协议路径不受影响', async () => {
    const connection = {} as acp.ClientSideConnection
    const harness = createAdapterHarness(connection)
    harness.internal.activeTurn = createActiveTurn(connection, 'task-current', 'turn-current', 1, 1)
    harness.internal.handleSessionUpdate(
      notification({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-no-store',
        title: 'ls',
        kind: 'execute',
        status: 'completed',
        rawInput: { command: 'ls' },
        rawOutput: { exit_code: 0, timed_out: false }
      }),
      connection
    )
    await harness.adapter.waitForCommandEvidenceWrites()
    expect(harness.events.some((event) => event.kind === 'tool-call')).toBe(true)
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
  sessionUpdateQueue: Promise<void>
  sessionUpdateQueueActive: boolean
  runtimeAttachmentErrorReported: boolean
  ingestedRuntimeMediaKeys: Set<string>
  lastContextUsageFingerprint?: string
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
  pendingQuestions: Map<string, unknown>
  supportsCloseSession: boolean
  capabilitySnapshot: AgentRuntimeCapabilitySnapshot
  status: AgentRuntimeStatus
  initializeConnection: (
    connection: acp.ClientSideConnection,
    child: ChildProcessWithoutNullStreams,
    workspace: string,
    connectionGeneration: number
  ) => Promise<boolean>
  handleRuntimeProcessError: (
    child: ChildProcessWithoutNullStreams,
    connectionGeneration: number,
    workspace: string,
    error: unknown
  ) => void
  resolveConnectFailure: (error: unknown) => AgentRuntimeAdapterError
  requestPermission: (
    params: acp.RequestPermissionRequest,
    sourceConnection: acp.ClientSideConnection
  ) => Promise<acp.RequestPermissionResponse>
  handleExtensionMethod: (
    method: string,
    params: unknown,
    sourceConnection: acp.ClientSideConnection
  ) => Promise<Record<string, unknown>>
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
    getClientVersion: () => '0.1.0-test',
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

/** 供 connect 缺 CLI 竞态测试注入的假子进程。 */
function createFakeSpawnChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & EventEmitter
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4242,
    kill: vi.fn()
  })
  return child
}

function createAdapterHarness(
  connection: acp.ClientSideConnection = {} as acp.ClientSideConnection,
  selected = true,
  extraOptions: {
    getClientVersion?: () => string
    getProviderConfig?: () => ProviderRuntimeConfig | null
    commandEvidenceStore?: CommandEvidenceStore
    resolveCommandEvidenceContext?: () => { environmentId: string } | null
    storeRuntimeImage?: (input: {
      taskId: string
      turnId: string
      originalName: string
      mimeType: string
      bytes: Buffer
    }) => Promise<{ attachmentId: string; attachmentKind: 'image'; originalName: string }>
    grokSessionMediaRoot?: string
    grokSessionSignalsRoot?: string
  } = {}
): {
  adapter: GrokAcpAdapter
  internal: GrokAcpAdapterTestAccess
  events: AgentEvent[]
  permissions: AgentRuntimePermissionRequest[]
  statuses: AgentRuntimeStatus[]
  permissionCancellations: import('../../agent/agent-runtime-adapter').AgentRuntimePermissionCancellation[]
  availableCommands: AgentAvailableCommandSnapshot[]
  questions: AgentRuntimeQuestionRequest[]
} {
  const events: AgentEvent[] = []
  const permissions: AgentRuntimePermissionRequest[] = []
  const statuses: AgentRuntimeStatus[] = []
  const permissionCancellations: import('../../agent/agent-runtime-adapter').AgentRuntimePermissionCancellation[] =
    []
  const availableCommands: AgentAvailableCommandSnapshot[] = []
  const questions: AgentRuntimeQuestionRequest[] = []
  const adapter = new GrokAcpAdapter(
    {
      onStatus: (status) => statuses.push(status),
      onEvent: (event) => events.push(event),
      onPermission: (request) => permissions.push(request),
      onPermissionCancelled: (request) => permissionCancellations.push(request),
      onQuestion: (request) => questions.push(request),
      onAvailableCommands: (snapshot) => availableCommands.push(snapshot)
    },
    {
      userDataPath: '/tmp/agent-studio-test',
      getProviderConfig: () => providerConfig(),
      // 备注：测试注入明确假版本，禁止依赖 Adapter 内写死常量。
      getClientVersion: () => '0.1.0-test',
      redactText: redactFakeText,
      ...extraOptions
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
    availableCommands,
    questions
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
    cancelRequested: false,
    sessionUpdateQueue: Promise.resolve(),
    sessionUpdateQueueActive: false,
    runtimeAttachmentErrorReported: false,
    ingestedRuntimeMediaKeys: new Set()
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
  options: acp.PermissionOption[],
  kind: acp.ToolKind = 'execute',
  path?: string
): acp.RequestPermissionRequest {
  return {
    sessionId: 'runtime-session-1',
    toolCall: {
      toolCallId: 'tool-1',
      title: '执行测试命令',
      kind,
      ...(path ? { locations: [{ path }] } : {})
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
