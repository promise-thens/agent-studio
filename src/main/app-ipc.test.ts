import { describe, expect, it, vi } from 'vitest'
import { APP_INVOKE_CHANNELS } from '../shared/app-ipc'
import type { DesktopIpcResult } from '../shared/ipc-result'
import type { RuntimePluginDetail, RuntimePluginSummary } from '../shared/runtime-plugin'
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

const pluginSummary: RuntimePluginSummary = {
  pluginId: 'demo-plugin',
  displayName: 'Demo Plugin',
  status: 'enabled',
  scope: 'user',
  skillCount: 1,
  mcpCount: 0,
  hookCount: 0
}

const pluginDetail: RuntimePluginDetail = {
  ...pluginSummary,
  skillNames: ['demo-skill'],
  mcpNames: [],
  hookNames: []
}

function createFixture(): {
  handlers: Map<string, DesktopIpcHandler>
  chooseProject: ReturnType<typeof vi.fn>
  revealProject: ReturnType<typeof vi.fn>
  assertTrustedSender: ReturnType<typeof vi.fn>
  setAppearance: ReturnType<typeof vi.fn>
  listPlugins: ReturnType<typeof vi.fn>
  getPlugin: ReturnType<typeof vi.fn>
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
  const listPlugins = vi.fn(async () => [pluginSummary])
  const getPlugin = vi.fn(async () => pluginDetail as RuntimePluginDetail | null)
  const setPluginEnabled = vi.fn(async (pluginId: string, enabled: boolean) => ({
    pluginId,
    enabled
  }))
  const getGrokConfig = vi.fn(async () => ({ text: '[memory]\nenabled = true\n' }))
  const saveGrokConfig = vi.fn(async () => undefined)
  const listMemories = vi.fn(async () => [])
  const getMemory = vi.fn(async () => ({
    memoryId: 'global/MEMORY.md',
    scope: 'global' as const,
    title: '全局',
    markdown: 'hello'
  }))
  const saveMemory = vi.fn(async () => ({
    memoryId: 'global/MEMORY.md',
    scope: 'global' as const,
    title: '全局',
    markdown: 'hello'
  }))
  const deleteMemory = vi.fn(async () => undefined)
  const getMemoryEnabled = vi.fn(async () => ({ enabled: true, shareStatus: 'linked' as const }))
  const setMemoryEnabled = vi.fn(async (enabled: boolean) => ({
    enabled,
    shareStatus: 'linked' as const
  }))
  const listMcpServers = vi.fn(async () => [])
  const upsertMcpServer = vi.fn(async () => ({
    name: 'docs',
    enabled: true,
    transport: 'http' as const,
    origin: 'user' as const,
    hasSecret: false,
    url: 'https://example.com/mcp'
  }))
  const deleteMcpServer = vi.fn(async () => undefined)
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
    listPlugins,
    getPlugin,
    setPluginEnabled,
    getGrokConfig,
    saveGrokConfig,
    listMemories,
    getMemory,
    saveMemory,
    deleteMemory,
    getMemoryEnabled,
    setMemoryEnabled,
    listMcpServers,
    upsertMcpServer,
    deleteMcpServer,
    sanitizeError: (error) => (error instanceof Error ? error.message : String(error))
  })
  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<DesktopIpcResult<T>> => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`缺少 Handler: ${channel}`)
    return (await handler(event, ...args)) as DesktopIpcResult<T>
  }
  return {
    handlers,
    chooseProject,
    revealProject,
    assertTrustedSender,
    setAppearance,
    listPlugins,
    getPlugin,
    invoke
  }
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

  it('插件列表无参，详情只接受合法 pluginId', async () => {
    const fixture = createFixture()
    expect(await fixture.invoke(APP_INVOKE_CHANNELS.listPlugins)).toEqual({
      ok: true,
      value: [pluginSummary]
    })
    expect(fixture.listPlugins).toHaveBeenCalledTimes(1)

    expect(
      await fixture.invoke(APP_INVOKE_CHANNELS.getPlugin, { pluginId: 'demo-plugin' })
    ).toEqual({ ok: true, value: pluginDetail })
    expect(fixture.getPlugin).toHaveBeenCalledWith('demo-plugin')

    expect(await fixture.invoke(APP_INVOKE_CHANNELS.listPlugins, { extra: true })).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' }
    })
    expect(
      await fixture.invoke(APP_INVOKE_CHANNELS.getPlugin, {
        pluginId: 'demo-plugin',
        path: '/tmp/plugins/demo-plugin'
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(fixture.getPlugin).toHaveBeenCalledTimes(1)
  })

  it('非法 pluginId 为 invalid-input，缺失插件为 not-found', async () => {
    const fixture = createFixture()
    // 路径分隔符会在 join 前逃出 plugins 目录，必须在 IPC 层拒绝
    expect(
      await fixture.invoke(APP_INVOKE_CHANNELS.getPlugin, { pluginId: '../escape' })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(await fixture.invoke(APP_INVOKE_CHANNELS.getPlugin, { pluginId: 'a\\b' })).toMatchObject(
      { ok: false, error: { code: 'invalid-input' } }
    )
    expect(await fixture.invoke(APP_INVOKE_CHANNELS.getPlugin, { pluginId: '' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' }
    })
    expect(fixture.getPlugin).not.toHaveBeenCalled()

    // 格式合法但库存无此项：与输入错误分开，方便 UI 显示「未找到」
    fixture.getPlugin.mockResolvedValueOnce(null)
    expect(
      await fixture.invoke(APP_INVOKE_CHANNELS.getPlugin, { pluginId: 'missing-plugin' })
    ).toEqual({
      ok: false,
      error: { code: 'not-found', message: '未找到指定插件。' }
    })
    expect(fixture.getPlugin).toHaveBeenCalledWith('missing-plugin')
  })

  it('启停插件拒绝含路径的 pluginId', async () => {
    const fixture = createFixture()
    expect(
      await fixture.invoke(APP_INVOKE_CHANNELS.setPluginEnabled, {
        pluginId: '../escape',
        enabled: true
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(
      await fixture.invoke(APP_INVOKE_CHANNELS.setPluginEnabled, {
        pluginId: 'demo-plugin',
        enabled: false
      })
    ).toEqual({ ok: true, value: { pluginId: 'demo-plugin', enabled: false } })
  })
})
