import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const preloadDir = dirname(fileURLToPath(import.meta.url))

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

  it('宿主快照保留 pointer；插件路径丢掉 pointer；computer-use 拒收', async () => {
    await import('./overlay')
    const api = exposeInMainWorld.mock.calls[0]?.[1] as {
      onSnapshot: (listener: (snapshot: unknown) => void) => () => void
    }
    const listener = vi.fn()
    api.onSnapshot(listener)
    const handler = ipcRenderer.on.mock.calls.at(-1)?.[1] as (
      event: unknown,
      payload: unknown
    ) => void

    handler(
      {},
      {
        visible: true,
        surface: 'host-browser',
        persistWhenUnfocused: false,
        pointer: { x: 310, y: 130 },
        taskId: 'task-1',
        turnId: 'turn-1',
        executionId: 'execution-1'
      }
    )
    expect(listener).toHaveBeenCalledWith({
      visible: true,
      surface: 'host-browser',
      persistWhenUnfocused: false,
      pointer: { x: 310, y: 130 },
      taskId: 'task-1',
      turnId: 'turn-1',
      executionId: 'execution-1'
    })

    listener.mockClear()
    handler(
      {},
      {
        visible: true,
        kind: 'browser',
        pointer: { x: 1, y: 2 },
        taskId: 'task-1'
      }
    )
    expect(listener).toHaveBeenCalledWith({
      visible: true,
      surface: 'browser-plugin',
      persistWhenUnfocused: false,
      taskId: 'task-1'
    })
    expect(listener.mock.calls[0]?.[0]).not.toHaveProperty('pointer')

    listener.mockClear()
    handler(
      {},
      {
        visible: true,
        surface: 'computer-use',
        persistWhenUnfocused: true,
        pointer: { x: 1, y: 1 }
      }
    )
    expect(listener).not.toHaveBeenCalled()
  })

  it('上下文隔离关闭时不暴露 API', async () => {
    Object.defineProperty(process, 'contextIsolated', { configurable: true, value: false })
    await expect(import('./overlay')).rejects.toThrow('Agent Studio 需要启用 contextIsolation。')
    expect(exposeInMainWorld).not.toHaveBeenCalled()
  })
})

describe('Overlay Preload 沙箱打包', () => {
  it('双入口必须 isolatedEntries，避免 sandbox_bundle 无法加载共享 chunk', () => {
    const config = readFileSync(join(preloadDir, '../../electron.vite.config.ts'), 'utf8')
    expect(config).toContain("overlay: resolve('src/preload/overlay.ts')")
    expect(config).toMatch(/isolatedEntries:\s*true/)
    expect(config).toMatch(/externalizeDeps:\s*false/)
    expect(config).toContain('ensureStdoutCursorApis')
  })
})
