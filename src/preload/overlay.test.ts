import { beforeEach, describe, expect, it, vi } from 'vitest'

const exposeInMainWorld = vi.fn()
const ipcRenderer = {
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer
}))

describe('Overlay Preload 暴露面', () => {
  beforeEach(() => {
    vi.resetModules()
    exposeInMainWorld.mockClear()
    Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
  })

  it('只暴露 overlay.onSnapshot、cancelTurn 与 setChipHover', async () => {
    await import('./overlay')
    expect(exposeInMainWorld.mock.calls.map(([name]) => name)).toEqual(['overlay'])
    const api = exposeInMainWorld.mock.calls[0]?.[1] as {
      onSnapshot?: unknown
      cancelTurn?: unknown
      setChipHover?: (hovered: boolean) => void
    }
    expect(Object.keys(api)).toEqual(['onSnapshot', 'cancelTurn', 'setChipHover'])
    expect(typeof api.onSnapshot).toBe('function')
    expect(typeof api.cancelTurn).toBe('function')
    expect(typeof api.setChipHover).toBe('function')
    api.setChipHover?.(true)
    expect(ipcRenderer.send).toHaveBeenCalledWith(
      'task:browser-plugin-overlay-chip-hover',
      true
    )
  })

  it('上下文隔离关闭时不暴露 API', async () => {
    Object.defineProperty(process, 'contextIsolated', { configurable: true, value: false })
    await expect(import('./overlay')).rejects.toThrow('Agent Studio 需要启用 contextIsolation。')
    expect(exposeInMainWorld).not.toHaveBeenCalled()
  })
})
