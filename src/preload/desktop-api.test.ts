import { describe, expect, it, vi, type Mock } from 'vitest'
import { reactive } from 'vue'
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
  it('拖入文件只经 webUtils 路径解析器转换，并限制单轮数量', () => {
    const ipcRenderer = createIpcRenderer()
    const files = Array.from({ length: 10 }, (_, index) => ({ name: `file-${index}` }) as File)
    const getPathForFile = vi.fn((file: File) =>
      file === files[2] ? '' : `/tmp/${String((file as { name: string }).name)}`
    )
    const task = createTaskDesktopApi(ipcRenderer, getPathForFile)

    expect(task.resolveDroppedFilePaths(files)).toEqual([
      '/tmp/file-0',
      '/tmp/file-1',
      '/tmp/file-3',
      '/tmp/file-4',
      '/tmp/file-5',
      '/tmp/file-6',
      '/tmp/file-7'
    ])
    expect(getPathForFile).toHaveBeenCalledTimes(8)
    expect(ipcRenderer.invoke).not.toHaveBeenCalled()
  })

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
    await app.probeMacosFolderAccess('project-1')
    await app.openMacosFilesPrivacySettings()
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
      [APP_INVOKE_CHANNELS.probeMacosFolderAccess, { projectId: 'project-1' }],
      [APP_INVOKE_CHANNELS.openMacosFilesPrivacySettings],
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

  it('六种推送各自绑定唯一固定 channel', () => {
    const ipcRenderer = createIpcRenderer()
    const agent = createAgentDesktopApi(ipcRenderer)

    agent.onStatus(vi.fn())
    agent.onEvent(vi.fn())
    agent.onPermission(vi.fn())
    agent.onPermissionCancelled(vi.fn())
    agent.onAvailableCommands(vi.fn())
    agent.onTaskRuntimeState(vi.fn())

    expect(ipcRenderer.on.mock.calls.map(([channel]) => channel)).toEqual([
      AGENT_PUSH_CHANNELS.status,
      AGENT_PUSH_CHANNELS.event,
      AGENT_PUSH_CHANNELS.permission,
      AGENT_PUSH_CHANNELS.permissionCancelled,
      AGENT_PUSH_CHANNELS.availableCommands,
      AGENT_PUSH_CHANNELS.taskRuntimeState
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

  it('附件事件只重建 inbox 引用，缺字段或非图片类型时拒绝', () => {
    const ipcRenderer = createIpcRenderer()
    const agent = createAgentDesktopApi(ipcRenderer)
    const listener = vi.fn()
    agent.onEvent(listener)
    const eventHandler = ipcRenderer.on.mock.calls[0]?.[1]
    const base = {
      runtimeId: 'grok',
      capabilityState: 'native',
      taskId: 'task-1',
      turnId: 'turn-1',
      sequence: 1,
      observedAt: '2026-08-18T00:00:00.000Z',
      kind: 'agent-attachment',
      attachmentId: 'attachment-1',
      attachmentKind: 'image',
      originalName: 'runtime-image.png'
    }

    eventHandler?.({}, { ...base, runtimeSessionId: 'private', bytes: 'private-base64' })
    eventHandler?.({}, { ...base, sequence: 2, attachmentId: '' })
    eventHandler?.({}, { ...base, sequence: 3, attachmentKind: 'pdf' })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(base)
    expect(JSON.stringify(listener.mock.calls)).not.toContain('private')
  })

  it('工具事件只接受有界 parentId，未知键与超长值不得进入 Renderer', () => {
    const ipcRenderer = createIpcRenderer()
    const agent = createAgentDesktopApi(ipcRenderer)
    const listener = vi.fn()
    agent.onEvent(listener)
    const eventHandler = ipcRenderer.on.mock.calls[0]?.[1]
    const base = {
      runtimeId: 'grok',
      capabilityState: 'native',
      taskId: 'task-1',
      turnId: 'turn-1',
      sequence: 1,
      observedAt: '2026-08-18T00:00:00.000Z',
      kind: 'tool-call',
      toolCallId: 'child-1',
      title: '读取文件',
      status: 'in_progress'
    }

    eventHandler?.({}, { ...base, parentId: 'parent-tool-1' })
    eventHandler?.({}, { ...base, sequence: 2, title: 'subagent 探查测试结构' })
    eventHandler?.(
      {},
      {
        ...base,
        sequence: 3,
        kind: 'tool-update',
        title: '子 Agent 改登录逻辑',
        status: 'completed',
        parentId: 'parent-tool-1',
        parentToolCallId: 'should-drop',
        rawInput: { apiKey: 'fake-secret' },
        _meta: { parentToolCallId: 'meta-parent' },
        runtimeSessionId: 'runtime-private'
      }
    )
    eventHandler?.({}, { ...base, sequence: 4, parentId: 'p'.repeat(4 * 1024 + 1) })
    eventHandler?.({}, { ...base, sequence: 5, parentId: '' })

    expect(listener.mock.calls.map((call) => call[0])).toEqual([
      { ...base, parentId: 'parent-tool-1' },
      { ...base, sequence: 2, title: 'subagent 探查测试结构' },
      {
        runtimeId: 'grok',
        capabilityState: 'native',
        taskId: 'task-1',
        turnId: 'turn-1',
        sequence: 3,
        observedAt: '2026-08-18T00:00:00.000Z',
        kind: 'tool-update',
        toolCallId: 'child-1',
        title: '子 Agent 改登录逻辑',
        status: 'completed',
        parentId: 'parent-tool-1'
      }
    ])
    expect(listener).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(listener.mock.calls)).not.toContain('parentToolCallId')
    expect(JSON.stringify(listener.mock.calls)).not.toContain('rawInput')
    expect(JSON.stringify(listener.mock.calls)).not.toContain('fake-secret')
    expect(JSON.stringify(listener.mock.calls)).not.toContain('runtime-private')
    expect(JSON.stringify(listener.mock.calls)).not.toContain('_meta')
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

  it('selectModel 发送前把 Vue Proxy 摊成可克隆纯对象', async () => {
    const ipcRenderer = createIpcRenderer()
    const provider = createProviderDesktopApi(ipcRenderer)
    const model = reactive({ modelId: 'deepseek-chat', displayName: 'DeepSeek Chat' })

    await provider.selectModel(model)

    const payload = ipcRenderer.invoke.mock.calls[0]?.[1]
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('provider:select-model', payload)
    expect(payload).toEqual({ modelId: 'deepseek-chat', displayName: 'DeepSeek Chat' })
    expect(payload).not.toBe(model)
    expect(() => structuredClone(payload)).not.toThrow()
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

  it('命令证据查询只走 task:* 只读 channel，并丢掉 path/filePath', async () => {
    const ipcRenderer = createIpcRenderer()
    const task = createTaskDesktopApi(ipcRenderer)
    const evidence = {
      commandId: 'cmd-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      environmentId: 'env-1',
      source: 'runtime-tool',
      displayCommand: 'pnpm test',
      cwd: '.',
      startedAt: '2026-08-22T10:00:00.000Z',
      endedAt: '2026-08-22T10:00:01.000Z',
      exitCode: 0,
      timedOut: false,
      status: 'succeeded',
      transcriptRef: {
        transcriptId: 'transcript-1',
        availableBytes: 2,
        totalBytes: 2,
        truncated: false,
        encoding: 'utf-8',
        retentionPolicy: 'bounded',
        retentionState: 'retained'
      },
      truncated: false,
      trustLevel: 'runtime-reported',
      path: '/tmp/secret.log',
      filePath: '/tmp/secret.log'
    }
    ipcRenderer.invoke.mockResolvedValueOnce({ ok: true, value: { items: [evidence] } })
    ipcRenderer.invoke.mockResolvedValueOnce({ ok: true, value: evidence })
    ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      value: {
        taskId: 'task-1',
        commandId: 'cmd-1',
        transcriptId: 'transcript-1',
        offset: 0,
        limit: 32,
        truncated: false,
        retentionState: 'retained',
        path: '/tmp/secret.log',
        chunks: [{ stream: 'stdout', text: 'ok', filePath: '/tmp/chunk' }]
      }
    })

    const listed = await task.listCommandEvidence('task-1')
    const got = await task.getCommandEvidence('task-1', 'cmd-1')
    const transcript = await task.getCommandTranscript('task-1', 'cmd-1', 0, 32)

    expect(ipcRenderer.invoke.mock.calls).toEqual([
      [TASK_INVOKE_CHANNELS.listCommandEvidence, { taskId: 'task-1' }],
      [TASK_INVOKE_CHANNELS.getCommandEvidence, { taskId: 'task-1', commandId: 'cmd-1' }],
      [
        TASK_INVOKE_CHANNELS.getCommandTranscript,
        { taskId: 'task-1', commandId: 'cmd-1', offset: 0, limit: 32 }
      ]
    ])
    expect(listed.ok && listed.value.items[0]).toMatchObject({
      commandId: 'cmd-1',
      source: 'runtime-tool',
      trustLevel: 'runtime-reported'
    })
    expect(JSON.stringify(listed)).not.toContain('/tmp/secret.log')
    ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      value: {
        items: [evidence],
        truncated: true,
        persistIncomplete: true,
        path: '/tmp/secret.log'
      }
    })
    const incomplete = await task.listCommandEvidence('task-1')
    expect(incomplete).toMatchObject({
      ok: true,
      value: { truncated: true, persistIncomplete: true }
    })
    expect(JSON.stringify(incomplete)).not.toContain('/tmp/secret.log')
    expect(JSON.stringify(got)).not.toContain('filePath')
    expect(transcript).toEqual({
      ok: true,
      value: {
        taskId: 'task-1',
        commandId: 'cmd-1',
        transcriptId: 'transcript-1',
        offset: 0,
        limit: 32,
        truncated: false,
        retentionState: 'retained',
        chunks: [{ stream: 'stdout', text: 'ok' }]
      }
    })
  })

  it('子代理活动只接受有界回包，未知键列表不得混进 Renderer', async () => {
    const ipcRenderer = createIpcRenderer()
    const task = createTaskDesktopApi(ipcRenderer)
    ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      value: {
        source: 'grok-session',
        tools: [
          {
            toolCallId: 't-read',
            title: 'Read `index.html`',
            status: 'completed',
            rawInput: { secret: 'sk' }
          }
        ],
        result: {
          text: '最终发现：四个页面都只读分析完成。',
          truncated: false,
          rawOutput: '不得穿透'
        }
      }
    })
    const parsed = await task.getSubagentActivity('task-1', '01a05bc9')
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(TASK_INVOKE_CHANNELS.getSubagentActivity, {
      taskId: 'task-1',
      shortId: '01a05bc9'
    })
    expect(parsed).toEqual({
      ok: true,
      value: {
        source: 'grok-session',
        tools: [{ toolCallId: 't-read', title: 'Read `index.html`', status: 'completed' }],
        result: { text: '最终发现：四个页面都只读分析完成。', truncated: false }
      }
    })
    expect(JSON.stringify(parsed)).not.toContain('rawInput')
    expect(JSON.stringify(parsed)).not.toContain('rawOutput')
    ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      value: { source: 'mystery', tools: [] }
    })
    expect(await task.getSubagentActivity('task-1', '01a05bc9')).toMatchObject({
      ok: false,
      error: { code: 'operation-failed' }
    })
  })

  it('变更审阅 API 丢掉绝对路径、fingerprint 和 porcelain', async () => {
    const ipcRenderer = createIpcRenderer()
    const task = createTaskDesktopApi(ipcRenderer)
    ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      value: {
        taskId: 'task-1',
        environmentId: 'local:testenv',
        baselineStatus: 'captured',
        gitPresence: 'git',
        generatedAt: '2026-08-22T12:00:00.000Z',
        preExistingCount: 0,
        taskChangedCount: 1,
        unknownCount: 0,
        validations: [],
        paths: [{ path: 'README.md', attribution: 'task-modified' }],
        revertible: { kind: 'none', reason: '当前版本仅提供只读审阅，不支持一键撤销。' },
        executionRoot: '/Users/secret/project',
        fingerprint: '1:2:/Users/secret/project',
        porcelainSummary: '1 .M ... /Users/secret/project/README.md'
      }
    })
    ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      value: {
        taskId: 'task-1',
        path: 'README.md',
        status: 'ok',
        unifiedDiff: '--- a/README.md\n+++ b/README.md\n',
        filePath: '/Users/secret/project/README.md'
      }
    })

    const changeSet = await task.getChangeSet('task-1')
    const diff = await task.getFileDiff('task-1', 'README.md')
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      [TASK_INVOKE_CHANNELS.getChangeSet, { taskId: 'task-1' }],
      [TASK_INVOKE_CHANNELS.getFileDiff, { taskId: 'task-1', path: 'README.md' }]
    ])
    expect(changeSet.ok && changeSet.value.paths[0]?.path).toBe('README.md')
    expect(JSON.stringify(changeSet)).not.toContain('/Users/secret')
    expect(JSON.stringify(changeSet)).not.toContain('fingerprint')
    expect(JSON.stringify(changeSet)).not.toContain('porcelain')
    expect(JSON.stringify(diff)).not.toContain('/Users/secret')
    expect(diff).toMatchObject({
      ok: true,
      value: { path: 'README.md', status: 'ok' }
    })
  })

  it('Artifact API 丢掉绝对路径并拒绝混入 path 字段', async () => {
    const ipcRenderer = createIpcRenderer()
    const task = createTaskDesktopApi(ipcRenderer)
    ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      value: [
        {
          artifactId: 'art-1',
          projectId: 'project-1',
          taskId: 'task-1',
          turnId: 'turn-1',
          kind: 'markdown',
          title: 'README.md',
          mimeType: 'text/markdown',
          source: 'git-review',
          environmentId: 'local:env',
          location: { kind: 'file', relativePath: 'README.md' },
          size: 12,
          contentHash: 'abc',
          createdAt: '2026-08-28T00:00:00.000Z',
          trustLevel: 'verified',
          availability: 'ready',
          revision: 1,
          path: '/Users/secret/README.md'
        },
        {
          artifactId: 'art-2',
          projectId: 'project-1',
          taskId: 'task-1',
          turnId: 'turn-1',
          kind: 'markdown',
          title: 'README.md',
          mimeType: 'text/markdown',
          source: 'git-review',
          environmentId: 'local:env',
          location: { kind: 'file', relativePath: 'README.md' },
          size: 12,
          contentHash: 'abc',
          createdAt: '2026-08-28T00:00:00.000Z',
          trustLevel: 'verified',
          availability: 'ready',
          revision: 1
        }
      ]
    })
    ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      value: {
        kind: 'markdown',
        markdown: '# hi',
        descriptor: {
          artifactId: 'art-2',
          projectId: 'project-1',
          taskId: 'task-1',
          turnId: 'turn-1',
          kind: 'markdown',
          title: 'README.md',
          mimeType: 'text/markdown',
          source: 'git-review',
          environmentId: 'local:env',
          location: { kind: 'file', relativePath: 'README.md' },
          size: 12,
          contentHash: 'abc',
          createdAt: '2026-08-28T00:00:00.000Z',
          trustLevel: 'verified',
          availability: 'ready',
          revision: 1
        },
        filePath: '/Users/secret/README.md'
      }
    })

    const listed = await task.listArtifacts('task-1')
    const content = await task.getArtifactContent('task-1', 'art-2')
    expect(listed).toMatchObject({
      ok: true,
      value: [{ artifactId: 'art-2', location: { relativePath: 'README.md' } }]
    })
    expect(JSON.stringify(listed)).not.toContain('/Users/secret')
    expect(content).toMatchObject({
      ok: false,
      error: { code: 'operation-failed' }
    })
  })

  it('恢复预览丢掉绝对路径和文件正文', async () => {
    const ipcRenderer = createIpcRenderer()
    const task = createTaskDesktopApi(ipcRenderer)
    ipcRenderer.invoke.mockResolvedValueOnce({
      ok: true,
      value: {
        taskId: 'task-1',
        revertible: {
          kind: 'latest-turn',
          turnId: 'turn-1',
          paths: ['README.md'],
          restorePlan: [{ path: 'README.md', action: 'write', from: 'head' }]
        },
        willLosePaths: ['README.md'],
        absolutePath: '/Users/secret/README.md',
        body: 'agent-edit'
      }
    })
    const preview = await task.previewLatestTurnRestore('task-1')
    expect(preview).toMatchObject({
      ok: true,
      value: {
        taskId: 'task-1',
        willLosePaths: ['README.md']
      }
    })
    expect(JSON.stringify(preview)).not.toContain('/Users/secret')
    expect(JSON.stringify(preview)).not.toContain('agent-edit')
  })
})
