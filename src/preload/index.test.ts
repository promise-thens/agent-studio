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

  it('只暴露 agent、app、task 和 provider', async () => {
    await import('./index')

    expect(exposeInMainWorld.mock.calls.map(([name]) => name)).toEqual([
      'agent',
      'app',
      'task',
      'provider'
    ])
  })

  it('上下文隔离关闭时不暴露 API 并显式失败', async () => {
    Object.defineProperty(process, 'contextIsolated', { configurable: true, value: false })

    await expect(import('./index')).rejects.toThrow('Agent Studio 需要启用 contextIsolation。')
    expect(exposeInMainWorld).not.toHaveBeenCalled()
  })
})
