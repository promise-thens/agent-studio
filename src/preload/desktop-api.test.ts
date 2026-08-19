import { describe, expect, it, vi, type Mock } from 'vitest'
import { AGENT_INVOKE_CHANNELS, AGENT_PUSH_CHANNELS } from '../shared/agent-ipc'
import { APP_INVOKE_CHANNELS } from '../shared/app-ipc'
import { TASK_INVOKE_CHANNELS } from '../shared/task-ipc'
import {
  createAgentDesktopApi,
  createAppDesktopApi,
  createProviderDesktopApi,
  createTaskDesktopApi,
  type NarrowIpcRenderer
} from './desktop-api'

type MockIpcRenderer = {
  [Key in keyof NarrowIpcRenderer]: Mock<NarrowIpcRenderer[Key]>
}

function createIpcRenderer(): MockIpcRenderer {
  return {
    invoke: vi.fn<NarrowIpcRenderer['invoke']>(async () => ({ ok: true, value: null })),
    on: vi.fn<NarrowIpcRenderer['on']>(),
    removeListener: vi.fn<NarrowIpcRenderer['removeListener']>()
  }
}

describe('窄 Preload API', () => {
  it('Agent/App/Task 方法只调用固定 channel 并包装对象请求', async () => {
    const ipcRenderer = createIpcRenderer()
    const agent = createAgentDesktopApi(ipcRenderer)
    const app = createAppDesktopApi(ipcRenderer)
    const task = createTaskDesktopApi(ipcRenderer)

    await agent.getStatus()
    await agent.getExecutionSnapshot()
    await agent.connect('project-1')
    await agent.disconnect()
    await agent.createTask('project-1')
    await agent.enterTask('task-1')
    await agent.startTurn('task-1', '执行测试')
    await agent.cancelTurn({
      executionId: 'execution-1',
      taskId: 'task-1',
      turnId: 'turn-1'
    })
    await agent.getTaskRuntimeState('task-1')
    await agent.respondPermission({
      approvalId: 'request-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      decision: 'deny'
    })
    await app.chooseProject()
    await task.list('project-1')
    await task.listEvents('task-1', 'turn-1', 42, 200)
    await task.listPermissionAudits('task-1')
    await task.resume('task-1')

    expect(ipcRenderer.invoke.mock.calls).toEqual([
      [AGENT_INVOKE_CHANNELS.getStatus],
      [AGENT_INVOKE_CHANNELS.getExecutionSnapshot],
      [AGENT_INVOKE_CHANNELS.connect, { projectId: 'project-1' }],
      [AGENT_INVOKE_CHANNELS.disconnect],
      [AGENT_INVOKE_CHANNELS.createTask, { projectId: 'project-1' }],
      [AGENT_INVOKE_CHANNELS.enterTask, { taskId: 'task-1' }],
      [AGENT_INVOKE_CHANNELS.startTurn, { taskId: 'task-1', prompt: '执行测试' }],
      [
        AGENT_INVOKE_CHANNELS.cancelTurn,
        { executionId: 'execution-1', taskId: 'task-1', turnId: 'turn-1' }
      ],
      [AGENT_INVOKE_CHANNELS.getTaskRuntimeState, { taskId: 'task-1' }],
      [
        AGENT_INVOKE_CHANNELS.respondPermission,
        {
          approvalId: 'request-1',
          taskId: 'task-1',
          turnId: 'turn-1',
          decision: 'deny'
        }
      ],
      [APP_INVOKE_CHANNELS.chooseProject],
      [TASK_INVOKE_CHANNELS.list, { projectId: 'project-1' }],
      [
        TASK_INVOKE_CHANNELS.listEvents,
        { taskId: 'task-1', turnId: 'turn-1', afterSequence: 42, limit: 200 }
      ],
      [TASK_INVOKE_CHANNELS.listPermissionAudits, { taskId: 'task-1' }],
      [TASK_INVOKE_CHANNELS.resume, { taskId: 'task-1' }]
    ])
  })

  it('订阅只转发 payload，并精确且幂等地清理本次 handler', () => {
    const ipcRenderer = createIpcRenderer()
    const agent = createAgentDesktopApi(ipcRenderer)
    const listener = vi.fn()
    const cleanup = agent.onStatus(listener)
    const registeredHandler = ipcRenderer.on.mock.calls[0]?.[1]

    registeredHandler?.({ hidden: 'electron-event' }, { runtimeId: 'grok', state: 'idle' })
    cleanup()
    cleanup()

    expect(ipcRenderer.on).toHaveBeenCalledWith(AGENT_PUSH_CHANNELS.status, registeredHandler)
    expect(listener).toHaveBeenCalledWith({ runtimeId: 'grok', state: 'idle' })
    expect(ipcRenderer.removeListener).toHaveBeenCalledTimes(1)
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      AGENT_PUSH_CHANNELS.status,
      registeredHandler
    )
  })

  it('四种推送各自绑定唯一固定 channel', () => {
    const ipcRenderer = createIpcRenderer()
    const agent = createAgentDesktopApi(ipcRenderer)

    agent.onStatus(vi.fn())
    agent.onEvent(vi.fn())
    agent.onPermission(vi.fn())
    agent.onPermissionCancelled(vi.fn())

    expect(ipcRenderer.on.mock.calls.map(([channel]) => channel)).toEqual([
      AGENT_PUSH_CHANNELS.status,
      AGENT_PUSH_CHANNELS.event,
      AGENT_PUSH_CHANNELS.permission,
      AGENT_PUSH_CHANNELS.permissionCancelled
    ])
  })

  it('Agent 事件推送只转发公开 DTO，丢弃 Runtime 私有字段和 Diff 正文', () => {
    const ipcRenderer = createIpcRenderer()
    const agent = createAgentDesktopApi(ipcRenderer)
    const listener = vi.fn()
    agent.onEvent(listener)
    const eventHandler = ipcRenderer.on.mock.calls[0]?.[1]

    eventHandler?.(
      { hidden: 'electron-event' },
      {
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
            reason: 'git-review-not-implemented',
            patch: 'private-patch'
          }
        ],
        toolCallId: 'tool-1',
        runtimeSessionId: 'runtime-private',
        executionRoot: '/private/root',
        diffs: [{ before: 'private-before', after: 'private-after' }],
        rawPayload: { authorization: 'fake-secret' }
      }
    )

    expect(listener).toHaveBeenCalledWith({
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
        }
      ],
      toolCallId: 'tool-1'
    })
    expect(JSON.stringify(listener.mock.calls)).not.toContain('runtime-private')
    expect(JSON.stringify(listener.mock.calls)).not.toContain('private-patch')
    expect(JSON.stringify(listener.mock.calls)).not.toContain('private-before')
    expect(JSON.stringify(listener.mock.calls)).not.toContain('fake-secret')
  })

  it('进入对话只重建公开恢复状态，剥掉 runtimeSessionId', async () => {
    const ipcRenderer = createIpcRenderer()
    ipcRenderer.invoke.mockResolvedValue({
      ok: true,
      value: {
        taskId: 'task-1',
        historyReady: true,
        restore: 'degraded',
        method: 'load',
        verification: 'declared',
        reason: '可能回放旧输出，上下文完整性未核实。',
        runtimeSessionId: 'runtime-session-private'
      }
    })
    const agent = createAgentDesktopApi(ipcRenderer)
    const result = await agent.enterTask('task-1')

    expect(result).toEqual({
      ok: true,
      value: {
        taskId: 'task-1',
        historyReady: true,
        restore: 'degraded',
        method: 'load',
        verification: 'declared',
        reason: '可能回放旧输出，上下文完整性未核实。'
      }
    })
    expect(JSON.stringify(result)).not.toContain('runtime-session-private')
  })

  it('Agent 事件身份、枚举或大小越界时整条拒绝', () => {
    const ipcRenderer = createIpcRenderer()
    const agent = createAgentDesktopApi(ipcRenderer)
    const listener = vi.fn()
    agent.onEvent(listener)
    const eventHandler = ipcRenderer.on.mock.calls[0]?.[1]
    const valid = {
      runtimeId: 'grok',
      capabilityState: 'native',
      taskId: 'task-1',
      turnId: 'turn-1',
      sequence: 1,
      observedAt: '2026-08-18T00:00:00.000Z',
      kind: 'agent-message',
      text: '安全内容'
    }

    eventHandler?.({}, { ...valid, sequence: 0 })
    eventHandler?.({}, { ...valid, capabilityState: 'private' })
    eventHandler?.({}, { ...valid, observedAt: 'not-a-date' })
    eventHandler?.({}, { ...valid, text: 'x'.repeat(64 * 1024 + 1) })
    eventHandler?.({}, { ...valid, kind: 'runtime-private-event' })

    expect(listener).not.toHaveBeenCalled()
  })

  it('权限推送只转发白名单 DTO，丢弃 Runtime 私有字段和原始负载', () => {
    const ipcRenderer = createIpcRenderer()
    const agent = createAgentDesktopApi(ipcRenderer)
    const permissionListener = vi.fn()
    const cancellationListener = vi.fn()
    const cleanupPermission = agent.onPermission(permissionListener)
    const cleanupCancellation = agent.onPermissionCancelled(cancellationListener)
    const permissionHandler = ipcRenderer.on.mock.calls[0]?.[1]
    const cancellationHandler = ipcRenderer.on.mock.calls[1]?.[1]

    permissionHandler?.(
      { hidden: 'electron-event' },
      {
        approvalId: 'approval-1',
        initiator: 'runtime',
        runtimeId: 'grok',
        taskId: 'task-1',
        turnId: 'turn-1',
        projectId: 'project-1',
        environmentId: 'local:test',
        operationType: 'write-file',
        risk: 'L1',
        title: '修改文件',
        impact: '会修改 Project 文件。',
        targets: ['path: src/index.ts'],
        allowedScopes: ['once', 'task'],
        expiresAt: '2026-08-13T12:00:00.000Z',
        truncated: true,
        requestId: 'runtime-private',
        runtimeSessionId: 'runtime-session-private',
        toolCallId: 'tool-private',
        parameterFingerprint: 'private-fingerprint',
        executionSupported: true,
        executionRoot: '/private/root',
        optionId: 'allow-once-private',
        rawInput: { apiKey: 'fake-secret' }
      }
    )
    cancellationHandler?.(
      { hidden: 'electron-event' },
      {
        approvalId: 'approval-1',
        taskId: 'task-1',
        turnId: 'turn-1',
        reason: 'cancelled',
        requestId: 'runtime-private',
        rawOutput: 'fake-secret'
      }
    )

    expect(permissionListener).toHaveBeenCalledWith({
      approvalId: 'approval-1',
      initiator: 'runtime',
      runtimeId: 'grok',
      taskId: 'task-1',
      turnId: 'turn-1',
      projectId: 'project-1',
      environmentId: 'local:test',
      operationType: 'write-file',
      risk: 'L1',
      title: '修改文件',
      impact: '会修改 Project 文件。',
      targets: ['path: src/index.ts'],
      allowedScopes: ['once', 'task'],
      expiresAt: '2026-08-13T12:00:00.000Z',
      truncated: true
    })
    expect(cancellationListener).toHaveBeenCalledWith({
      approvalId: 'approval-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      reason: 'cancelled'
    })
    expect(JSON.stringify(permissionListener.mock.calls)).not.toContain('fake-secret')
    expect(JSON.stringify(permissionListener.mock.calls)).not.toContain('runtime-private')

    cleanupPermission()
    cleanupPermission()
    cleanupCancellation()
    cleanupCancellation()
    expect(ipcRenderer.removeListener.mock.calls).toEqual([
      [AGENT_PUSH_CHANNELS.permission, permissionHandler],
      [AGENT_PUSH_CHANNELS.permissionCancelled, cancellationHandler]
    ])
  })

  it('权限推送身份、枚举或大小越界时整条拒绝', () => {
    const ipcRenderer = createIpcRenderer()
    const agent = createAgentDesktopApi(ipcRenderer)
    const permissionListener = vi.fn()
    const cancellationListener = vi.fn()
    agent.onPermission(permissionListener)
    agent.onPermissionCancelled(cancellationListener)
    const permissionHandler = ipcRenderer.on.mock.calls[0]?.[1]
    const cancellationHandler = ipcRenderer.on.mock.calls[1]?.[1]
    const valid = {
      approvalId: 'approval-1',
      initiator: 'runtime',
      runtimeId: 'grok',
      taskId: 'task-1',
      turnId: 'turn-1',
      projectId: 'project-1',
      environmentId: 'local:test',
      operationType: 'write-file',
      risk: 'L1',
      title: '修改文件',
      impact: '会修改 Project 文件。',
      targets: ['path: src/index.ts'],
      allowedScopes: ['once'],
      expiresAt: '2026-08-13T12:00:00.000Z'
    }

    permissionHandler?.({}, { ...valid, risk: 'L9' })
    permissionHandler?.({}, { ...valid, targets: Array.from({ length: 33 }, () => 'path: x') })
    permissionHandler?.({}, { ...valid, approvalId: 'x'.repeat(4 * 1024 + 1) })
    permissionHandler?.({}, { ...valid, allowedScopes: ['once', 'forever'] })
    cancellationHandler?.({}, { approvalId: 'a', taskId: 't', turnId: 'u', reason: 'expired' })

    expect(permissionListener).not.toHaveBeenCalled()
    expect(cancellationListener).not.toHaveBeenCalled()
  })

  it('Provider API 保持原始 channel 和参数契约', async () => {
    const ipcRenderer = createIpcRenderer()
    const provider = createProviderDesktopApi(ipcRenderer)
    const input = { baseUrl: 'https://example.com/v1', authMode: 'none' as const }

    await provider.listModels(input)

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('provider:list-models', input)
  })
})
