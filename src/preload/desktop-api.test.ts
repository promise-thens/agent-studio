import { describe, expect, it, vi, type Mock } from 'vitest'
import { AGENT_INVOKE_CHANNELS, AGENT_PUSH_CHANNELS } from '../shared/agent-ipc'
import { APP_INVOKE_CHANNELS } from '../shared/app-ipc'
import {
  createAgentDesktopApi,
  createAppDesktopApi,
  createProviderDesktopApi,
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
  it('Agent/App 方法只调用固定 channel 并包装对象请求', async () => {
    const ipcRenderer = createIpcRenderer()
    const agent = createAgentDesktopApi(ipcRenderer)
    const app = createAppDesktopApi(ipcRenderer)

    await agent.getStatus()
    await agent.connect('/tmp/project')
    await agent.disconnect()
    await agent.sendPrompt('执行测试')
    await agent.cancel()
    await agent.respondPermission('request-1')
    await agent.respondPermission('request-2', 'allow-once')
    await app.chooseWorkspace()

    expect(ipcRenderer.invoke.mock.calls).toEqual([
      [AGENT_INVOKE_CHANNELS.getStatus],
      [AGENT_INVOKE_CHANNELS.connect, { workspace: '/tmp/project' }],
      [AGENT_INVOKE_CHANNELS.disconnect],
      [AGENT_INVOKE_CHANNELS.sendPrompt, { prompt: '执行测试' }],
      [AGENT_INVOKE_CHANNELS.cancel],
      [AGENT_INVOKE_CHANNELS.respondPermission, { requestId: 'request-1' }],
      [AGENT_INVOKE_CHANNELS.respondPermission, { requestId: 'request-2', optionId: 'allow-once' }],
      [APP_INVOKE_CHANNELS.chooseWorkspace]
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
