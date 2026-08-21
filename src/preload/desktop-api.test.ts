import { describe, expect, it, vi, type Mock } from 'vitest'
import { AGENT_INVOKE_CHANNELS, AGENT_PUSH_CHANNELS } from '../shared/agent-ipc'
import { APP_INVOKE_CHANNELS, APP_PUSH_CHANNELS } from '../shared/app-ipc'
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
    await agent.getAvailableCommands('task-1')
    await agent.respondPermission({
      approvalId: 'request-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      decision: 'deny'
    })
    await app.chooseProject()
    await app.revealProject('project-1')
    await app.listPlugins()
    await app.getPlugin('demo-plugin')
    await app.listMarketplacePlugins()
    await app.installPlugin('chrome-devtools', false)
    await app.uninstallPlugin('chrome-devtools-mcp')
    await app.addMarketplaceSource('https://github.com/xai-org/plugin-marketplace.git')
    await task.list('project-1')
    await task.listEvents('task-1', 'turn-1', 42, 200)
    await task.listPermissionAudits('task-1')
    await task.resume('task-1')
    await task.rename('task-1', '新标题')
    await task.archive('task-1')

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
      [AGENT_INVOKE_CHANNELS.getAvailableCommands, { taskId: 'task-1' }],
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
      [APP_INVOKE_CHANNELS.revealProject, { projectId: 'project-1' }],
      [APP_INVOKE_CHANNELS.listPlugins],
      [APP_INVOKE_CHANNELS.getPlugin, { pluginId: 'demo-plugin' }],
      [APP_INVOKE_CHANNELS.listMarketplacePlugins],
      [APP_INVOKE_CHANNELS.installPlugin, { name: 'chrome-devtools', trust: false }],
      [APP_INVOKE_CHANNELS.uninstallPlugin, { pluginId: 'chrome-devtools-mcp' }],
      [
        APP_INVOKE_CHANNELS.addMarketplaceSource,
        { gitUrl: 'https://github.com/xai-org/plugin-marketplace.git' }
      ],
      [TASK_INVOKE_CHANNELS.list, { projectId: 'project-1' }],
      [
        TASK_INVOKE_CHANNELS.listEvents,
        { taskId: 'task-1', turnId: 'turn-1', afterSequence: 42, limit: 200 }
      ],
      [TASK_INVOKE_CHANNELS.listPermissionAudits, { taskId: 'task-1' }],
      [TASK_INVOKE_CHANNELS.resume, { taskId: 'task-1' }],
      [TASK_INVOKE_CHANNELS.rename, { taskId: 'task-1', title: '新标题' }],
      [TASK_INVOKE_CHANNELS.archive, { taskId: 'task-1' }]
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

  it('五种推送各自绑定唯一固定 channel', () => {
    const ipcRenderer = createIpcRenderer()
    const agent = createAgentDesktopApi(ipcRenderer)

    agent.onStatus(vi.fn())
    agent.onEvent(vi.fn())
    agent.onPermission(vi.fn())
    agent.onPermissionCancelled(vi.fn())
    agent.onAvailableCommands(vi.fn())

    expect(ipcRenderer.on.mock.calls.map(([channel]) => channel)).toEqual([
      AGENT_PUSH_CHANNELS.status,
      AGENT_PUSH_CHANNELS.event,
      AGENT_PUSH_CHANNELS.permission,
      AGENT_PUSH_CHANNELS.permissionCancelled,
      AGENT_PUSH_CHANNELS.availableCommands
    ])
  })

  it('命令快照推送经白名单解析，失败不回调且丢弃 runtimeSessionId', () => {
    const ipcRenderer = createIpcRenderer()
    const agent = createAgentDesktopApi(ipcRenderer)
    const listener = vi.fn()
    agent.onAvailableCommands(listener)
    const handler = ipcRenderer.on.mock.calls[0]?.[1]

    handler?.(
      { hidden: 'electron-event' },
      {
        taskId: 'task-1',
        revision: 2,
        commands: [{ name: 'compact', description: '压缩', inputHint: '主题' }],
        runtimeSessionId: 'runtime-session-private'
      }
    )
    handler?.({}, null)
    handler?.({}, { taskId: '', revision: 1, commands: [] })
    handler?.({}, { taskId: 'task-1', revision: Number.NaN, commands: [] })
    handler?.({}, { revision: 1, commands: [] })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({
      taskId: 'task-1',
      revision: 2,
      commands: [{ name: 'compact', description: '压缩', inputHint: '主题' }]
    })
    expect(JSON.stringify(listener.mock.calls)).not.toContain('runtime-session-private')
  })

  it('getAvailableCommands 经白名单解析，失败返回 operation-failed 且丢掉脏字段', async () => {
    const ipcRenderer = createIpcRenderer()
    const agent = createAgentDesktopApi(ipcRenderer)

    ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      value: {
        taskId: 'task-1',
        revision: 2,
        commands: [{ name: 'compact', description: '压缩', inputHint: '主题' }],
        runtimeSessionId: 'runtime-session-private'
      }
    })
    ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      value: { taskId: 'task-1', revision: 0 }
    })
    ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      value: { taskId: '', revision: 1, commands: [] }
    })
    ipcRenderer.invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'task-not-found', message: '未找到指定 Task。' }
    })

    await expect(agent.getAvailableCommands('task-1')).resolves.toEqual({
      ok: true,
      value: {
        taskId: 'task-1',
        revision: 2,
        commands: [{ name: 'compact', description: '压缩', inputHint: '主题' }]
      }
    })
    await expect(agent.getAvailableCommands('task-1')).resolves.toEqual({
      ok: true,
      value: { taskId: 'task-1', revision: 0, commands: [] }
    })
    await expect(agent.getAvailableCommands('task-1')).resolves.toEqual({
      ok: false,
      error: { code: 'operation-failed', message: '命令快照无效。' }
    })
    await expect(agent.getAvailableCommands('task-1')).resolves.toEqual({
      ok: false,
      error: { code: 'task-not-found', message: '未找到指定 Task。' }
    })
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

  it('外观 API 走固定 channel，非法推送丢弃', async () => {
    const ipcRenderer = createIpcRenderer()
    const app = createAppDesktopApi(ipcRenderer)
    const listener = vi.fn()
    const cleanup = app.onAppearanceChanged(listener)
    const handler = ipcRenderer.on.mock.calls.find(
      ([channel]) => channel === APP_PUSH_CHANNELS.appearance
    )?.[1]

    await app.getAppearance()
    await app.setAppearance('light')
    handler?.({}, { mode: 'system', resolved: 'light' })
    handler?.({}, { mode: 'system', resolved: 'light', extra: true })
    cleanup()

    expect(ipcRenderer.invoke.mock.calls).toEqual([
      [APP_INVOKE_CHANNELS.getAppearance],
      [APP_INVOKE_CHANNELS.setAppearance, { mode: 'light' }]
    ])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({ mode: 'system', resolved: 'light' })
    expect(ipcRenderer.removeListener).toHaveBeenCalledTimes(1)
  })

  it('插件 API 解析摘要并丢掉含路径的脏项', async () => {
    const ipcRenderer = createIpcRenderer()
    ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      value: [
        {
          pluginId: 'demo-plugin',
          displayName: 'Demo',
          status: 'enabled',
          scope: 'user',
          skillCount: 1,
          mcpCount: 0,
          hookCount: 0,
          absolutePath: '/secret/plugins/demo-plugin'
        },
        {
          pluginId: 'bad/id',
          displayName: 'Bad',
          status: 'enabled',
          scope: 'user',
          skillCount: 0,
          mcpCount: 0,
          hookCount: 0
        }
      ]
    })
    ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      value: {
        pluginId: 'demo-plugin',
        displayName: 'Demo',
        status: 'enabled',
        scope: 'user',
        skillCount: 1,
        mcpCount: 0,
        hookCount: 0,
        skillNames: ['demo-skill'],
        mcpNames: [],
        hookNames: [],
        installPath: '/secret/plugins/demo-plugin'
      }
    })
    const app = createAppDesktopApi(ipcRenderer)

    const listed = await app.listPlugins()
    const detail = await app.getPlugin('demo-plugin')

    expect(listed).toEqual({
      ok: true,
      value: [
        {
          pluginId: 'demo-plugin',
          displayName: 'Demo',
          status: 'enabled',
          scope: 'user',
          skillCount: 1,
          mcpCount: 0,
          hookCount: 0
        }
      ]
    })
    expect(detail).toEqual({
      ok: true,
      value: {
        pluginId: 'demo-plugin',
        displayName: 'Demo',
        status: 'enabled',
        scope: 'user',
        skillCount: 1,
        mcpCount: 0,
        hookCount: 0,
        skillNames: ['demo-skill'],
        mcpNames: [],
        hookNames: []
      }
    })
    expect(JSON.stringify(listed)).not.toContain('/secret')
    expect(JSON.stringify(detail)).not.toContain('/secret')
  })

  it('插件详情解析失败时返回 operation-failed', async () => {
    const ipcRenderer = createIpcRenderer()
    ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      value: { pluginId: 'demo-plugin', path: '/tmp/demo' }
    })
    const app = createAppDesktopApi(ipcRenderer)

    expect(await app.getPlugin('demo-plugin')).toEqual({
      ok: false,
      error: { code: 'operation-failed', message: '插件详情无效。' }
    })
  })

  it('市场货架解析丢掉 path/sha/url，安装结果不回传 CLI 输出', async () => {
    const ipcRenderer = createIpcRenderer()
    ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      value: [
        {
          name: 'chrome-devtools',
          displayName: 'chrome-devtools',
          description: 'Connect Grok to Chrome DevTools.',
          sourceName: 'plugin-marketplace',
          installed: false,
          path: '/secret/marketplace-cache/chrome-devtools',
          sha: 'deadbeef',
          url: 'https://github.com/xai-org/plugin-marketplace.git'
        },
        {
          name: 'bad/id',
          displayName: 'Bad',
          description: '',
          sourceName: 'plugin-marketplace',
          installed: false
        }
      ]
    })
    ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      value: { stdout: '/secret/grok-home/installed-plugins/chrome-devtools' }
    })
    const app = createAppDesktopApi(ipcRenderer)

    const listed = await app.listMarketplacePlugins()
    const installed = await app.installPlugin('chrome-devtools', true)

    expect(listed).toEqual({
      ok: true,
      value: [
        {
          name: 'chrome-devtools',
          displayName: 'chrome-devtools',
          description: 'Connect Grok to Chrome DevTools.',
          sourceName: 'plugin-marketplace',
          installed: false
        }
      ]
    })
    expect(installed).toEqual({
      ok: false,
      error: { code: 'operation-failed', message: '插件安装结果无效。' }
    })
    expect(JSON.stringify(listed)).not.toContain('/secret')
    expect(JSON.stringify(listed)).not.toContain('deadbeef')
    expect(JSON.stringify(listed)).not.toContain('https://')
  })
})
