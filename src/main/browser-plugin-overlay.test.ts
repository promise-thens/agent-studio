import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const overlayWindowMocks = vi.hoisted(() => ({
  windows: [] as Array<{ setIgnoreMouseEvents: ReturnType<typeof vi.fn> }>
}))

vi.mock('electron', () => {
  class BrowserWindow {
    webContents = { send: vi.fn(), once: vi.fn(), on: vi.fn() }
    setIgnoreMouseEvents = vi.fn()
    constructor() {
      overlayWindowMocks.windows.push(this)
    }
    setAlwaysOnTop(): void {
      // electron mock
    }
    setVisibleOnAllWorkspaces(): void {
      // electron mock
    }
    showInactive(): void {
      // electron mock
    }
    hide(): void {
      // electron mock
    }
    destroy(): void {
      // electron mock
    }
    isDestroyed(): boolean {
      return false
    }
    isVisible(): boolean {
      return true
    }
    setBounds(): void {
      // electron mock
    }
    loadURL(): Promise<void> {
      return Promise.resolve()
    }
    loadFile(): Promise<void> {
      return Promise.resolve()
    }
    on(): void {
      // electron mock
    }
  }
  return {
    BrowserWindow,
    ipcMain: { on: vi.fn(), removeListener: vi.fn() },
    screen: {
      getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 } })
    }
  }
})
import type { AgentPermissionRequest } from '../shared/agent'
import {
  createBrowserPluginOverlaySnapshot,
  projectBrowserPluginPointer
} from '../shared/browser-plugin-overlay'
import type { TaskExecutionSnapshot } from '../shared/task-execution'
import {
  BrowserPluginOverlayHost,
  BrowserPluginOverlaySession,
  createBrowserPluginOverlayWindowOptions,
  resolveBrowserPluginOverlayIgnoreMouseEvents,
  shouldRenderMovingOverlayCursor
} from './browser-plugin-overlay'

const mainDir = dirname(fileURLToPath(import.meta.url))
const overlayDir = join(mainDir, '../renderer/src/overlay')

const runningExecution: TaskExecutionSnapshot = {
  executorEpoch: 'epoch-1',
  executionRevision: 1,
  execution: {
    executionId: 'execution-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    projectId: 'project-1',
    runtimeId: 'grok',
    model: { modelId: 'model-1' },
    environment: { environmentId: 'env-1', kind: 'local', version: 1 },
    acceptedAt: '2026-09-07T00:00:00.000Z',
    stateChangedAt: '2026-09-07T00:00:00.000Z',
    state: 'running',
    dispatchedAt: '2026-09-07T00:00:00.000Z'
  }
}

function createBrowserPermission(
  overrides: Partial<AgentPermissionRequest> = {}
): AgentPermissionRequest {
  return {
    approvalId: 'approval-1',
    initiator: 'runtime',
    runtimeId: 'grok',
    taskId: 'task-1',
    turnId: 'turn-1',
    projectId: 'project-1',
    environmentId: 'env-1',
    operationType: 'browser',
    risk: 'L3',
    title: '打开网页',
    impact: 'Runtime 请求操作浏览器页面。',
    targets: ['https://example.com'],
    allowedScopes: ['once'],
    expiresAt: '2026-09-07T00:02:00.000Z',
    ...overrides
  }
}

describe('overlay 源码纪律', () => {
  it('overlay 主进程与渲染源不含系统鼠标注入', () => {
    const sources = [
      readFileSync(join(mainDir, 'browser-plugin-overlay.ts'), 'utf8'),
      readFileSync(join(overlayDir, 'OverlayApp.vue'), 'utf8')
    ].join('\n')
    expect(sources).not.toMatch(/CGEvent|AXUIElement|robotjs|nut-js|ScreenCaptureKit/)
  })

  it('无 pointer 时快照不得带 pointer 字段', () => {
    const snapshot = createBrowserPluginOverlaySnapshot({
      visible: true,
      taskId: 'task-1',
      pointer: undefined
    })
    expect(snapshot.pointer).toBeUndefined()
    expect(snapshot.kind).toBe('browser')
    expect(shouldRenderMovingOverlayCursor(snapshot)).toBe(false)
  })

  it('overlay 入口只暴露停止芯片与快照，不注入完整桌面 API', () => {
    const overlayPreload = readFileSync(join(mainDir, '../preload/overlay.ts'), 'utf8')
    const overlayApp = readFileSync(join(overlayDir, 'OverlayApp.vue'), 'utf8')
    const indexSource = readFileSync(join(mainDir, 'index.ts'), 'utf8')
    expect(overlayPreload).toContain('AGENT_INVOKE_CHANNELS.cancelTurn')
    expect(overlayPreload).toContain('TASK_PUSH_CHANNELS.browserPluginOverlay')
    expect(overlayPreload).not.toContain("exposeInMainWorld('agent'")
    expect(overlayPreload).not.toContain("exposeInMainWorld('app'")
    expect(overlayPreload).not.toContain("exposeInMainWorld('electron'")
    expect(overlayApp).toContain('停止浏览器控制')
    expect(overlayApp).toContain('v-if="snapshot.pointer"')
    expect(overlayApp).toContain('-webkit-app-region: no-drag')
    expect(overlayApp).toContain('@mouseenter')
    expect(overlayApp).toContain('@mouseleave')
    expect(overlayApp).toContain('setChipHover')
    expect(indexSource).toContain('createBrowserPluginOverlayHostInstance')
    expect(indexSource).toContain('onBrowserPluginTool')
    expect(indexSource).toContain('TASK_PUSH_CHANNELS.browserPluginOverlay')
    expect(indexSource).not.toContain('grok:browser')
  })

  it('macOS 关主窗不拆 overlay host；activate 按主窗重建，host 跟 app 退出走', () => {
    const indexSource = readFileSync(join(mainDir, 'index.ts'), 'utf8')
    const closedStart = indexSource.indexOf("mainWindow.on('closed'")
    const closedEnd = indexSource.indexOf('})', closedStart)
    const closedHandler = indexSource.slice(closedStart, closedEnd + 2)
    expect(closedHandler).toContain("mainWindow.on('closed'")
    expect(closedHandler).not.toContain('browserPluginOverlayHost?.destroy()')
    expect(indexSource).toContain('if (!mainWindow || mainWindow.isDestroyed()) createWindow()')
    expect(indexSource).not.toContain(
      'if (BrowserWindow.getAllWindows().length === 0) createWindow()'
    )
    const shutdownStart = indexSource.indexOf('beginShutdown:')
    const shutdownEnd = indexSource.indexOf('},', shutdownStart)
    const beginShutdown = indexSource.slice(shutdownStart, shutdownEnd + 2)
    expect(beginShutdown).toContain('browserPluginOverlayHost?.destroy()')
  })
})

describe('BrowserPluginOverlaySession', () => {
  it('写文件进行中不得把 overlay visible 置 true', () => {
    const session = new BrowserPluginOverlaySession()
    session.acceptExecutionSnapshot(runningExecution)
    expect(session.getSnapshot().visible).toBe(false)
    expect(session.getSnapshot().pointer).toBeUndefined()
  })

  it('未决 browser L3 使 overlay 可见，但冻结键不能发明光标', () => {
    const session = new BrowserPluginOverlaySession()
    session.acceptExecutionSnapshot(runningExecution)
    session.acceptPermission(createBrowserPermission())
    const snapshot = session.getSnapshot()
    expect(snapshot.visible).toBe(true)
    expect(snapshot.kind).toBe('browser')
    expect(snapshot.taskId).toBe('task-1')
    expect(snapshot.executionId).toBe('execution-1')
    expect(snapshot.pointer).toBeUndefined()
    expect(
      projectBrowserPluginPointer({ x: 120, y: 80 }, { width: 1440, height: 900 })
    ).toBeUndefined()
    expect(shouldRenderMovingOverlayCursor(snapshot)).toBe(false)
  })

  it('allow-once 或 deny 都清掉未决 L3；完成后写文件不得继续显示 overlay', () => {
    const session = new BrowserPluginOverlaySession()
    session.acceptExecutionSnapshot(runningExecution)
    session.acceptPermission(createBrowserPermission())
    expect(session.getSnapshot().visible).toBe(true)

    session.acceptPermissionResponse({ approvalId: 'approval-1', decision: 'allow-once' })
    expect(session.getSnapshot().visible).toBe(false)

    session.acceptBrowserTool({
      taskId: 'task-1',
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      status: 'in_progress'
    })
    expect(session.getSnapshot().visible).toBe(true)
    session.acceptBrowserTool({
      taskId: 'task-1',
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      status: 'completed'
    })
    expect(session.getSnapshot().visible).toBe(false)

    session.acceptPermission(createBrowserPermission({ approvalId: 'approval-2' }))
    expect(session.getSnapshot().visible).toBe(true)
    session.acceptPermissionResponse({ approvalId: 'approval-2', decision: 'allow-task' })
    expect(session.getSnapshot().visible).toBe(false)

    session.acceptPermission(createBrowserPermission({ approvalId: 'approval-3' }))
    expect(session.getSnapshot().visible).toBe(true)
    session.acceptPermissionResponse({ approvalId: 'approval-3', decision: 'deny' })
    expect(session.getSnapshot().visible).toBe(false)
  })

  it('cancel 或 Turn 结束后 visible 必须为 false', () => {
    const session = new BrowserPluginOverlaySession()
    session.acceptExecutionSnapshot(runningExecution)
    session.acceptBrowserTool({
      taskId: 'task-1',
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      status: 'in_progress',
      rawInput: { x: 120, y: 80 }
    })
    expect(session.getSnapshot().visible).toBe(true)

    session.acceptExecutionSnapshot({
      ...runningExecution,
      executionRevision: 2,
      execution: runningExecution.execution
        ? {
            ...runningExecution.execution,
            state: 'cancelled',
            endedAt: '2026-09-07T00:00:01.000Z',
            reason: 'runtime-cancelled',
            cancelRequestedAt: '2026-09-07T00:00:01.000Z'
          }
        : null
    })
    expect(session.getSnapshot().visible).toBe(false)
    expect(session.getSnapshot().pointer).toBeUndefined()
  })
})

describe('overlay 芯片可点', () => {
  it('芯片 hover 时关闭 click-through，离开后恢复穿透', () => {
    expect(resolveBrowserPluginOverlayIgnoreMouseEvents(true)).toEqual({ ignore: false })
    expect(resolveBrowserPluginOverlayIgnoreMouseEvents(false)).toEqual({
      ignore: true,
      forward: true
    })

    overlayWindowMocks.windows.length = 0
    const host = new BrowserPluginOverlayHost({
      isDev: false,
      preloadPath: '/tmp/overlay.js',
      productionHtmlPath: '/tmp/overlay.html',
      platform: 'darwin',
      publishToMain: vi.fn()
    })
    host.acceptExecutionSnapshot(runningExecution)
    host.acceptPermission(createBrowserPermission())
    const window = overlayWindowMocks.windows.at(-1)
    expect(window?.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })

    host.setChipHover(true)
    expect(window?.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
    host.setChipHover(false)
    expect(window?.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
  })
})

describe('overlay 窗口构造', () => {
  it('透明置顶窗口覆盖主屏，并声明 click-through', () => {
    const options = createBrowserPluginOverlayWindowOptions({
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      preloadPath: '/tmp/overlay.js'
    })
    expect(options).toMatchObject({
      x: 0,
      y: 0,
      width: 1440,
      height: 900,
      alwaysOnTop: true,
      skipTaskbar: true,
      transparent: true,
      frame: false,
      show: false
    })
    expect(options.webPreferences).toMatchObject({
      preload: '/tmp/overlay.js',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    })
  })
})
