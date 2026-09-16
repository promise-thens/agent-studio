import { describe, expect, it, vi } from 'vitest'
import { TASK_INVOKE_CHANNELS } from '../../shared/task-ipc'
import type { DesktopIpcResult } from '../../shared/ipc-result'
import type { DesktopIpcHandler } from '../ipc-types'
import { type TrustedIpcInvokeEvent } from '../security/ipc-sender-validation'
import { registerTaskIpcHandlers, type TaskHistoryIpcRuntime } from '../agent/task-ipc'
import type { HostBrowserService } from './host-browser-service'

const event = {} as TrustedIpcInvokeEvent

function createFixture(options?: { historyAvailable?: boolean; browserAvailable?: boolean }): {
  invoke: <T>(channel: string, request: unknown) => Promise<DesktopIpcResult<T>>
  browser: Pick<
    HostBrowserService,
    'getChrome' | 'setOpen' | 'userNavigate' | 'updateBounds' | 'noteActiveTask'
  >
  history: Pick<TaskHistoryIpcRuntime, 'getTaskDetail'>
} {
  const handlers = new Map<string, DesktopIpcHandler>()
  const browser = {
    getChrome: vi.fn(() => ({
      url: 'https://example.com/',
      title: 'Example',
      isLoading: false,
      open: true
    })),
    setOpen: vi.fn((_taskId: string, _projectId: string, open: boolean) => ({
      url: '',
      title: '',
      isLoading: false,
      open
    })),
    userNavigate: vi.fn((_taskId: string, _projectId: string, url: string) => ({
      url,
      title: url,
      isLoading: true,
      open: true
    })),
    updateBounds: vi.fn(),
    noteActiveTask: vi.fn()
  }
  const history = {
    getTaskDetail: vi.fn((taskId: string) => {
      if (taskId === 'missing-task') throw new Error('未找到指定 Task 历史。')
      return {
        taskId,
        projectId: 'project-real',
        runtimeId: 'grok' as const,
        title: '测试',
        state: 'completed' as const,
        turnCount: 1,
        resumable: true,
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z',
        revision: 1,
        environment: { kind: 'local' as const, projectId: 'project-real' },
        permissionPolicy: { kind: 'legacy-runtime' as const }
      }
    })
  }
  registerTaskIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    assertTrustedSender: vi.fn(),
    getHistory: () =>
      options?.historyAvailable === false ? null : (history as unknown as TaskHistoryIpcRuntime),
    getCommandEvidenceStore: () => null,
    getHostBrowser: () =>
      options?.browserAvailable === false ? null : (browser as unknown as HostBrowserService),
    sanitizeError: (error) => (error instanceof Error ? error.message : String(error))
  })
  return {
    browser,
    history,
    invoke: async <T>(channel: string, request: unknown): Promise<DesktopIpcResult<T>> => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`缺少 Handler: ${channel}`)
      return (await handler(event, request)) as DesktopIpcResult<T>
    }
  }
}

describe('宿主浏览器 IPC', () => {
  it('用户导航使用 Task 的真实 projectId，拒绝 javascript: 和占位项目', async () => {
    const fixture = createFixture()
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.userNavigateBrowser, {
        taskId: 'task-1',
        url: 'javascript:alert(1)'
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(fixture.browser.userNavigate).not.toHaveBeenCalled()

    const allowed = await fixture.invoke(TASK_INVOKE_CHANNELS.userNavigateBrowser, {
      taskId: 'task-1',
      url: 'https://example.com'
    })
    expect(allowed).toMatchObject({
      ok: true,
      value: { url: 'https://example.com/', open: true }
    })
    expect(fixture.browser.userNavigate).toHaveBeenCalledWith(
      'task-1',
      'project-real',
      'https://example.com/'
    )
    expect(vi.mocked(fixture.browser.userNavigate).mock.calls[0]?.[1]).not.toBe(
      'dummy-project-for-now'
    )
  })

  it('未知 Task 或未初始化浏览器返回有限错误，不碰 guest', async () => {
    const missingTask = createFixture()
    expect(
      await missingTask.invoke(TASK_INVOKE_CHANNELS.getBrowserChrome, { taskId: 'missing-task' })
    ).toMatchObject({ ok: false, error: { code: 'history-not-found' } })
    expect(missingTask.browser.getChrome).not.toHaveBeenCalled()

    const missingBrowser = createFixture({ browserAvailable: false })
    expect(
      await missingBrowser.invoke(TASK_INVOKE_CHANNELS.setBrowserOpen, {
        taskId: 'task-1',
        open: true
      })
    ).toMatchObject({ ok: false, error: { code: 'runtime-unavailable' } })
  })

  it('bounds 必须是有限整数，打开状态必须等主进程确认', async () => {
    const fixture = createFixture()
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.updateBrowserBounds, {
        taskId: 'task-1',
        x: 1.5,
        y: 0,
        width: 400,
        height: 400
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(fixture.browser.updateBounds).not.toHaveBeenCalled()

    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.updateBrowserBounds, {
        taskId: 'task-1',
        x: 12,
        y: 40,
        width: 480,
        height: 720
      })
    ).toEqual({ ok: true, value: null })
    expect(fixture.browser.updateBounds).toHaveBeenCalledWith({
      x: 12,
      y: 40,
      width: 480,
      height: 720
    })

    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.setBrowserOpen, { taskId: 'task-1', open: true })
    ).toEqual({
      ok: true,
      value: { url: '', title: '', isLoading: false, open: true }
    })
    expect(fixture.browser.setOpen).toHaveBeenCalledWith('task-1', 'project-real', true)

    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.getBrowserChrome, { taskId: 'task-1' })
    ).toMatchObject({ ok: true })
    expect(fixture.browser.noteActiveTask).toHaveBeenCalledWith('task-1')
  })
})
