import { beforeEach, describe, expect, it, vi } from 'vitest'

const exposeInMainWorld = vi.fn()
const ipcRenderer = {
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer
}))

describe('Preload 最终暴露面', () => {
  beforeEach(() => {
    vi.resetModules()
    exposeInMainWorld.mockClear()
    Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
  })

  it('只暴露业务 API 和主窗口受控浮层 API', async () => {
    await import('./index')

    expect(exposeInMainWorld.mock.calls.map(([name]) => name)).toEqual([
      'browserFocus',
      'agent',
      'app',
      'task',
      'provider'
    ])
    // 主窗不能获得子窗 dispatch，也不暴露通用 IPC。
    const owner = exposeInMainWorld.mock.calls.find(([name]) => name === 'browserFocus')?.[1]
    expect(Object.keys(owner)).toEqual(['publish', 'onIntent'])
  })

  it('发现 API 只在 app 合入一次，固定通道不泄露路径或通用 invoke', async () => {
    await import('./index')
    const app = exposeInMainWorld.mock.calls.find(([name]) => name === 'app')?.[1]
    expect(exposeInMainWorld.mock.calls.filter(([name]) => name === 'app')).toHaveLength(1)
    expect(app.invoke).toBeUndefined()
    ipcRenderer.invoke.mockResolvedValueOnce({ ok: true, value: { items: [], sources: [], path: '/private' } })
    await expect(app.listPluginDiscoveries()).resolves.toEqual({ ok: true, value: { items: [], sources: [] } })
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('app:list-plugin-discoveries')
    ipcRenderer.invoke.mockResolvedValueOnce({ ok: true, value: '/private' })
    await expect(app.revealPluginDiscovery('user:plugins:demo')).resolves.toEqual({ ok: true, value: null })
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('app:reveal-plugin-discovery', { discoveryId: 'user:plugins:demo' })
  })

  it('上下文隔离关闭时不暴露 API 并显式失败', async () => {
    Object.defineProperty(process, 'contextIsolated', { configurable: true, value: false })

    await expect(import('./index')).rejects.toThrow('Agent Studio 需要启用 contextIsolation。')
    expect(exposeInMainWorld).not.toHaveBeenCalled()
  })
})
