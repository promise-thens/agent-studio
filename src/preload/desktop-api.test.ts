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
    await agent.connect('project-1')
    await agent.disconnect()
    await agent.createTask('project-1')
    await agent.startTurn('task-1', '执行测试')
    await agent.cancelTurn('task-1')
    await agent.getTaskRuntimeState('task-1')
    await agent.respondPermission('request-1')
    await agent.respondPermission('request-2', 'allow-once')
    await app.chooseProject()
    await task.list('project-1')
    await task.resume('task-1')

    expect(ipcRenderer.invoke.mock.calls).toEqual([
      [AGENT_INVOKE_CHANNELS.getStatus],
      [AGENT_INVOKE_CHANNELS.connect, { projectId: 'project-1' }],
      [AGENT_INVOKE_CHANNELS.disconnect],
      [AGENT_INVOKE_CHANNELS.createTask, { projectId: 'project-1' }],
      [AGENT_INVOKE_CHANNELS.startTurn, { taskId: 'task-1', prompt: '执行测试' }],
      [AGENT_INVOKE_CHANNELS.cancelTurn, { taskId: 'task-1' }],
      [AGENT_INVOKE_CHANNELS.getTaskRuntimeState, { taskId: 'task-1' }],
      [AGENT_INVOKE_CHANNELS.respondPermission, { requestId: 'request-1' }],
      [AGENT_INVOKE_CHANNELS.respondPermission, { requestId: 'request-2', optionId: 'allow-once' }],
      [APP_INVOKE_CHANNELS.chooseProject],
      [TASK_INVOKE_CHANNELS.list, { projectId: 'project-1' }],
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

  it('三种推送各自绑定唯一固定 channel', () => {
    const ipcRenderer = createIpcRenderer()
    const agent = createAgentDesktopApi(ipcRenderer)

    agent.onStatus(vi.fn())
    agent.onEvent(vi.fn())
    agent.onPermission(vi.fn())

    expect(ipcRenderer.on.mock.calls.map(([channel]) => channel)).toEqual([
      AGENT_PUSH_CHANNELS.status,
      AGENT_PUSH_CHANNELS.event,
      AGENT_PUSH_CHANNELS.permission
    ])
  })

  it('Provider API 保持原始 channel 和参数契约', async () => {
    const ipcRenderer = createIpcRenderer()
    const provider = createProviderDesktopApi(ipcRenderer)
    const input = { baseUrl: 'https://example.com/v1', authMode: 'none' as const }

    await provider.listModels(input)

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('provider:list-models', input)
  })
})
