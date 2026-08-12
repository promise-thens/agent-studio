import { describe, expect, it, vi } from 'vitest'
import { APP_INVOKE_CHANNELS } from '../shared/app-ipc'
import type { DesktopIpcResult } from '../shared/ipc-result'
import type { ProjectSummary } from '../shared/task-history'
import type { DesktopIpcHandler } from './ipc-types'
import { DesktopIpcFailure, type TrustedIpcInvokeEvent } from './security/ipc-sender-validation'
import { registerAppIpcHandlers } from './app-ipc'

const event = {} as TrustedIpcInvokeEvent
const project: ProjectSummary = {
  projectId: 'project-1',
  canonicalRoot: '/tmp/project',
  displayName: 'project',
  status: 'active',
  availability: { state: 'available' },
  registeredAt: '2026-08-12T00:00:00.000Z',
  lastOpenedAt: '2026-08-12T00:00:00.000Z',
  revision: 1
}

function createFixture(): {
  handlers: Map<string, DesktopIpcHandler>
  chooseProject: ReturnType<typeof vi.fn>
  assertTrustedSender: ReturnType<typeof vi.fn>
  invoke: <T>(channel: string, ...args: unknown[]) => Promise<DesktopIpcResult<T>>
} {
  const handlers = new Map<string, DesktopIpcHandler>()
  const chooseProject = vi.fn(async () => project as ProjectSummary | null)
  const assertTrustedSender = vi.fn()
  const listProjects = vi.fn(async () => [project])
  const removeProject = vi.fn(async () => undefined)
  const previewProjectHistoryDeletion = vi.fn(async () => ({
    targetType: 'project-history' as const,
    targetId: project.projectId,
    revision: 1,
    fileCount: 2,
    turnCount: 1,
    bytes: 100,
    exclusions: ['项目目录'],
    token: 'token-1',
    expiresAt: '2026-08-12T00:05:00.000Z'
  }))
  const deleteProjectHistory = vi.fn(async () => undefined)
  registerAppIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    assertTrustedSender,
    chooseProject,
    listProjects,
    removeProject,
    previewProjectHistoryDeletion,
    deleteProjectHistory,
    sanitizeError: (error) => (error instanceof Error ? error.message : String(error))
  })
  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<DesktopIpcResult<T>> => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`缺少 Handler: ${channel}`)
    return (await handler(event, ...args)) as DesktopIpcResult<T>
  }
  return { handlers, chooseProject, assertTrustedSender, invoke }
}

describe('App IPC Handler', () => {
  it('注册固定 Project 管理 channels，并支持选择与取消', async () => {
    const fixture = createFixture()
    expect([...fixture.handlers.keys()]).toEqual(Object.values(APP_INVOKE_CHANNELS))
    expect(await fixture.invoke(APP_INVOKE_CHANNELS.chooseProject)).toEqual({
      ok: true,
      value: project
    })
    fixture.chooseProject.mockResolvedValueOnce(null)
    expect(await fixture.invoke(APP_INVOKE_CHANNELS.chooseProject)).toEqual({
      ok: true,
      value: null
    })
  })

  it('来源拒绝先于 Dialog', async () => {
    const fixture = createFixture()
    fixture.assertTrustedSender.mockImplementation(() => {
      throw new DesktopIpcFailure('forbidden', '拒绝此 IPC 调用。')
    })
    expect(await fixture.invoke(APP_INVOKE_CHANNELS.chooseProject)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' }
    })
    expect(fixture.chooseProject).not.toHaveBeenCalled()
  })

  it('删除接口拒绝未知字段', async () => {
    const fixture = createFixture()
    expect(
      await fixture.invoke(APP_INVOKE_CHANNELS.deleteProjectHistory, {
        projectId: 'project-1',
        token: 'token-1',
        workspace: '/tmp/project'
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })
})
