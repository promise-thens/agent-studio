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

const appearanceState = { mode: 'dark' as const, resolved: 'dark' as const }

function createFixture(): {
  handlers: Map<string, DesktopIpcHandler>
  chooseProject: ReturnType<typeof vi.fn>
  revealProject: ReturnType<typeof vi.fn>
  assertTrustedSender: ReturnType<typeof vi.fn>
  setAppearance: ReturnType<typeof vi.fn>
  invoke: <T>(channel: string, ...args: unknown[]) => Promise<DesktopIpcResult<T>>
} {
  const handlers = new Map<string, DesktopIpcHandler>()
  const chooseProject = vi.fn(async () => project as ProjectSummary | null)
  const revealProject = vi.fn(async () => undefined)
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
  const getAppearance = vi.fn(() => appearanceState)
  const setAppearance = vi.fn(async (mode: 'dark' | 'light' | 'system') => ({
    mode,
    resolved: mode === 'light' ? ('light' as const) : ('dark' as const)
  }))
  registerAppIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    assertTrustedSender,
    chooseProject,
    listProjects,
    revealProject,
    removeProject,
    previewProjectHistoryDeletion,
    deleteProjectHistory,
    getAppearance,
    setAppearance,
    sanitizeError: (error) => (error instanceof Error ? error.message : String(error))
  })
  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<DesktopIpcResult<T>> => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`缺少 Handler: ${channel}`)
    return (await handler(event, ...args)) as DesktopIpcResult<T>
  }
  return { handlers, chooseProject, revealProject, assertTrustedSender, setAppearance, invoke }
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

  it('打开项目目录只接受 projectId，不把路径交给 Renderer', async () => {
    const fixture = createFixture()
    expect(
      await fixture.invoke(APP_INVOKE_CHANNELS.revealProject, { projectId: 'project-1' })
    ).toEqual({ ok: true, value: null })
    expect(fixture.revealProject).toHaveBeenCalledWith('project-1')
    expect(
      await fixture.invoke(APP_INVOKE_CHANNELS.revealProject, {
        projectId: 'project-1',
        path: '/tmp/project'
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(fixture.revealProject).toHaveBeenCalledTimes(1)
  })

  it('目录不可用时把 project-unavailable 回给 Renderer', async () => {
    const fixture = createFixture()
    fixture.revealProject.mockRejectedValueOnce(
      new DesktopIpcFailure('project-unavailable', '该项目目录已删除或无法访问。')
    )
    expect(
      await fixture.invoke(APP_INVOKE_CHANNELS.revealProject, { projectId: 'project-1' })
    ).toEqual({
      ok: false,
      error: { code: 'project-unavailable', message: '该项目目录已删除或无法访问。' }
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

  it('外观读写只接受合法 mode，拒绝未知字段', async () => {
    const fixture = createFixture()
    expect(await fixture.invoke(APP_INVOKE_CHANNELS.getAppearance)).toEqual({
      ok: true,
      value: appearanceState
    })
    expect(await fixture.invoke(APP_INVOKE_CHANNELS.setAppearance, { mode: 'light' })).toEqual({
      ok: true,
      value: { mode: 'light', resolved: 'light' }
    })
    expect(fixture.setAppearance).toHaveBeenCalledWith('light')
    expect(await fixture.invoke(APP_INVOKE_CHANNELS.setAppearance, { mode: 'dim' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' }
    })
    expect(
      await fixture.invoke(APP_INVOKE_CHANNELS.setAppearance, { mode: 'dark', extra: true })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(await fixture.invoke(APP_INVOKE_CHANNELS.getAppearance, { mode: 'dark' })).toMatchObject(
      {
        ok: false,
        error: { code: 'invalid-input' }
      }
    )
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
