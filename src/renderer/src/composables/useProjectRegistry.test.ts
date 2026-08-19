import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopIpcResult } from '../../../shared/ipc-result'
import type { ProjectSummary } from '../../../shared/task-history'
import { useProjectRegistry } from './useProjectRegistry'

const availableProject: ProjectSummary = {
  projectId: 'project-available',
  canonicalRoot: '/tmp/project-available',
  displayName: 'available',
  status: 'active',
  availability: { state: 'available' },
  registeredAt: '2026-08-12T00:00:00.000Z',
  lastOpenedAt: '2026-08-12T00:00:00.000Z',
  revision: 1
}

const unavailableProject: ProjectSummary = {
  projectId: 'project-unavailable',
  canonicalRoot: '/tmp/project-unavailable',
  displayName: 'unavailable',
  status: 'active',
  availability: { state: 'unavailable', message: '目录不存在' },
  registeredAt: '2026-08-11T00:00:00.000Z',
  lastOpenedAt: '2026-08-11T00:00:00.000Z',
  revision: 1
}

function ok<T>(data: T): DesktopIpcResult<T> {
  return { ok: true, value: data }
}

function fail(message: string): DesktopIpcResult<never> {
  return { ok: false, error: { code: 'operation-failed', message } }
}

describe('useProjectRegistry', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        app: {
          listProjects: vi.fn(async () => ok([unavailableProject, availableProject])),
          chooseProject: vi.fn(async () => ok(availableProject)),
          removeProject: vi.fn(async () => ok(null)),
          previewProjectHistoryDeletion: vi.fn(),
          deleteProjectHistory: vi.fn(async () => ok(null))
        }
      }
    })
  })

  it('initialize 填入持久 Project 列表，默认不把 unavailable 当成可执行选中项', async () => {
    const registry = useProjectRegistry()
    await registry.initialize()

    expect(registry.projects.value.map((item) => item.projectId)).toEqual([
      'project-unavailable',
      'project-available'
    ])
    expect(registry.selectedProjectId.value).toBe('project-available')
    expect(registry.selectedProject.value?.availability.state).toBe('available')
    expect(registry.loadState.value.status).toBe('ready')

    await registry.selectProject('project-unavailable')
    expect(registry.selectedProjectId.value).toBe('project-unavailable')
    expect(registry.selectedProject.value?.availability.state).toBe('unavailable')
  })

  it('快速连续 selectProject 时旧 list 响应不得改写新选中项的关联状态', async () => {
    const registry = useProjectRegistry()
    await registry.initialize()
    const staleList = deferred<DesktopIpcResult<ProjectSummary[]>>()
    vi.mocked(window.app.listProjects).mockImplementationOnce(() => staleList.promise)

    const refreshing = registry.refresh()
    await registry.selectProject('project-unavailable')
    await registry.selectProject('project-available')
    staleList.resolve(ok([unavailableProject]))
    await refreshing

    expect(registry.selectedProjectId.value).toBe('project-available')
    expect(registry.selectedProject.value?.projectId).toBe('project-available')
    expect(registry.selectedProject.value?.availability.state).toBe('available')
    expect(registry.projects.value.map((item) => item.projectId)).toEqual([
      'project-unavailable',
      'project-available'
    ])
  })

  it('refresh 与 retryAccess 失败只标记 error，不清空已展示的 projects', async () => {
    const registry = useProjectRegistry()
    await registry.initialize()
    vi.mocked(window.app.listProjects).mockResolvedValueOnce(fail('刷新失败'))

    await registry.refresh()
    expect(registry.loadState.value.status).toBe('error')
    expect(registry.loadState.value.errorMessage).toBe('刷新失败')
    expect(registry.projects.value).toHaveLength(2)

    vi.mocked(window.app.listProjects).mockResolvedValueOnce(fail('重试访问失败'))
    await registry.retryAccess('project-unavailable')
    expect(registry.loadState.value.status).toBe('error')
    expect(registry.loadState.value.errorMessage).toBe('重试访问失败')
    expect(registry.projects.value.map((item) => item.projectId)).toEqual([
      'project-unavailable',
      'project-available'
    ])
    expect(registry.selectedProject.value?.availability.state).not.toBeUndefined()
  })

  it('removeProject 只走 window.app.removeProject，成功后刷新列表', async () => {
    const registry = useProjectRegistry()
    await registry.initialize()
    vi.mocked(window.app.listProjects).mockResolvedValueOnce(ok([unavailableProject]))

    await registry.removeProject('project-available')

    expect(window.app.removeProject).toHaveBeenCalledWith('project-available')
    expect(window.app.removeProject).toHaveBeenCalledTimes(1)
    expect(window.app.listProjects).toHaveBeenCalledTimes(2)
    expect(registry.projects.value.map((item) => item.projectId)).toEqual(['project-unavailable'])
  })
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
