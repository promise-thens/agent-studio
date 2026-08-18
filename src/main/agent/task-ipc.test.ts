import { describe, expect, it, vi } from 'vitest'
import { TASK_INVOKE_CHANNELS } from '../../shared/task-ipc'
import type { DesktopIpcResult } from '../../shared/ipc-result'
import type { DesktopIpcHandler } from '../ipc-types'
import { DesktopIpcFailure, type TrustedIpcInvokeEvent } from '../security/ipc-sender-validation'
import { registerTaskIpcHandlers, type TaskHistoryIpcRuntime } from './task-ipc'

const event = {} as TrustedIpcInvokeEvent

function createFixture(historyAvailable = true): {
  handlers: Map<string, DesktopIpcHandler>
  history: TaskHistoryIpcRuntime
  assertTrustedSender: ReturnType<typeof vi.fn>
  invoke: <T>(channel: string, request: unknown) => Promise<DesktopIpcResult<T>>
} {
  const handlers = new Map<string, DesktopIpcHandler>()
  const history: TaskHistoryIpcRuntime = {
    listTasks: vi.fn(async () => ({ items: [] })),
    getTaskDetail: vi.fn(() => ({
      taskId: 'task-1',
      projectId: 'project-1',
      runtimeId: 'grok' as const,
      title: '测试',
      state: 'completed' as const,
      turnCount: 1,
      resumable: true,
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      revision: 1,
      environment: { kind: 'local' as const, projectId: 'project-1' },
      permissionPolicy: { kind: 'legacy-runtime' as const }
    })),
    listTurns: vi.fn(async () => ({ items: [] })),
    listEvents: vi.fn(async () => ({ items: [], watermark: 0 })),
    listPermissionAudits: vi.fn(async () => ({ items: [] })),
    resumeTask: vi.fn(async () => ({ resumed: false, message: '不可恢复' })),
    previewTaskDeletion: vi.fn(async () => ({
      targetType: 'task' as const,
      targetId: 'task-1',
      revision: 1,
      fileCount: 1,
      turnCount: 1,
      bytes: 1,
      exclusions: [],
      token: 'token',
      expiresAt: '2026-08-12T00:05:00.000Z'
    })),
    deleteTask: vi.fn(async () => undefined)
  }
  const assertTrustedSender = vi.fn()
  registerTaskIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    assertTrustedSender,
    getHistory: () => (historyAvailable ? history : null),
    sanitizeError: (error) => (error instanceof Error ? error.message : String(error))
  })
  return {
    handlers,
    history,
    assertTrustedSender,
    invoke: async <T>(channel: string, request: unknown): Promise<DesktopIpcResult<T>> => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`缺少 Handler: ${channel}`)
      return (await handler(event, request)) as DesktopIpcResult<T>
    }
  }
}

describe('Task 历史 IPC', () => {
  it('只注册固定 Task channel，并先验证 Renderer 来源', async () => {
    const fixture = createFixture()
    expect([...fixture.handlers.keys()]).toEqual(Object.values(TASK_INVOKE_CHANNELS))
    fixture.assertTrustedSender.mockImplementation(() => {
      throw new DesktopIpcFailure('forbidden', '拒绝此 IPC 调用。')
    })
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.get, { taskId: 'task-1', extra: 'bad' })
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(fixture.history.getTaskDetail).not.toHaveBeenCalled()
  })

  it('历史服务未初始化时返回有限 runtime-unavailable', async () => {
    const fixture = createFixture(false)
    expect(await fixture.invoke(TASK_INVOKE_CHANNELS.get, { taskId: 'task-1' })).toEqual({
      ok: false,
      error: { code: 'runtime-unavailable', message: 'Task 历史服务尚未初始化。' }
    })
  })

  it('分页参数必须为安全非负整数，额外字段和 NUL 文本被拒绝', async () => {
    const fixture = createFixture()
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.listEvents, {
        taskId: 'task-1',
        turnId: 'turn-1',
        afterSequence: 1.5
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.list, {
        projectId: 'project\0bad',
        extra: true
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })

  it('事件分页原样转发数值 afterSequence 并保留数值响应字段', async () => {
    const fixture = createFixture()
    vi.mocked(fixture.history.listEvents).mockResolvedValueOnce({
      items: [],
      nextAfterSequence: 42,
      watermark: 100
    })

    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.listEvents, {
        taskId: 'task-1',
        turnId: 'turn-1',
        afterSequence: 42,
        limit: 200
      })
    ).toEqual({
      ok: true,
      value: { items: [], nextAfterSequence: 42, watermark: 100 }
    })
    expect(fixture.history.listEvents).toHaveBeenCalledWith('task-1', 'turn-1', 42, 200)
  })

  it('删除 token 与 Task ID原样绑定到历史服务，不暴露其它能力', async () => {
    const fixture = createFixture()
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.delete, {
        taskId: 'task-1',
        token: 'token-1'
      })
    ).toEqual({ ok: true, value: null })
    expect(fixture.history.deleteTask).toHaveBeenCalledWith('task-1', 'token-1')
  })

  it('权限审计查询只接受 Task ID、cursor 和 limit', async () => {
    const fixture = createFixture()
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.listPermissionAudits, {
        taskId: 'task-1',
        cursor: 'audit-1',
        limit: 20
      })
    ).toEqual({ ok: true, value: { items: [] } })
    expect(fixture.history.listPermissionAudits).toHaveBeenCalledWith('task-1', 'audit-1', 20)
  })
})
