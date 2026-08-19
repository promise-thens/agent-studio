import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopIpcResult } from '../../../shared/ipc-result'
import type {
  RunningTaskExecution,
  TaskExecutionDto,
  TaskExecutionSnapshot
} from '../../../shared/task-execution'
import type { ProjectSummary, TaskHistorySummary } from '../../../shared/task-history'
import { useTaskWorkbench } from './useTaskWorkbench'

const projectA: ProjectSummary = {
  projectId: 'p-a',
  canonicalRoot: '/tmp/p-a',
  displayName: 'p-a',
  status: 'active',
  availability: { state: 'available' },
  registeredAt: '2026-08-12T00:00:00.000Z',
  lastOpenedAt: '2026-08-12T00:00:00.000Z',
  revision: 1
}

const projectB: ProjectSummary = {
  projectId: 'p-b',
  canonicalRoot: '/tmp/p-b',
  displayName: 'p-b',
  status: 'active',
  availability: { state: 'available' },
  registeredAt: '2026-08-12T00:00:00.000Z',
  lastOpenedAt: '2026-08-12T00:00:00.000Z',
  revision: 1
}

function taskSummary(taskId: string, projectId: string): TaskHistorySummary {
  return {
    taskId,
    projectId,
    runtimeId: 'grok',
    title: taskId,
    state: 'completed',
    turnCount: 1,
    resumable: true,
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    revision: 1
  }
}

function runningExecution(taskId: string, projectId: string): RunningTaskExecution {
  return {
    executionId: 'exec-1',
    taskId,
    turnId: 'turn-live',
    projectId,
    runtimeId: 'grok',
    model: { modelId: 'model-1' },
    environment: { environmentId: 'env-1', kind: 'local', version: 1 },
    acceptedAt: '2026-08-12T00:00:00.000Z',
    stateChangedAt: '2026-08-12T00:00:00.000Z',
    state: 'running',
    dispatchedAt: '2026-08-12T00:00:00.000Z'
  }
}

function snapshotOf(
  execution: TaskExecutionDto | null,
  executionRevision = 1
): TaskExecutionSnapshot {
  return {
    executorEpoch: 'epoch-1',
    executionRevision,
    execution
  }
}

function ok<T>(data: T): DesktopIpcResult<T> {
  return { ok: true, value: data }
}

function fail(message: string): DesktopIpcResult<never> {
  return { ok: false, error: { code: 'operation-failed', message } }
}

describe('useTaskWorkbench', () => {
  let executionListeners: Array<(snapshot: TaskExecutionSnapshot) => void>
  let currentSnapshot: TaskExecutionSnapshot

  beforeEach(() => {
    executionListeners = []
    currentSnapshot = snapshotOf(runningExecution('task-a', 'p-a'))
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        app: {
          listProjects: vi.fn(async () => ok([projectA, projectB])),
          chooseProject: vi.fn(),
          removeProject: vi.fn(),
          previewProjectHistoryDeletion: vi.fn(),
          deleteProjectHistory: vi.fn()
        },
        task: {
          list: vi.fn(async (projectId: string) =>
            ok({
              items: [taskSummary(projectId === 'p-b' ? 'task-b' : 'task-a', projectId)]
            })
          ),
          get: vi.fn(async (taskId: string) =>
            ok({
              ...taskSummary(taskId, taskId === 'task-b' ? 'p-b' : 'p-a'),
              environment: { kind: 'local', projectId: taskId === 'task-b' ? 'p-b' : 'p-a' },
              permissionPolicy: { kind: 'legacy-runtime' }
            })
          ),
          listTurns: vi.fn(async (taskId: string) =>
            ok({
              items: [
                {
                  taskId,
                  turnId: `turn-${taskId}`,
                  promptDisplayText: taskId,
                  model: { modelId: 'model-1' },
                  state: 'completed' as const,
                  createdAt: '2026-08-12T00:00:00.000Z',
                  eventCount: 0,
                  eventBytes: 0,
                  revision: 1
                }
              ]
            })
          ),
          listEvents: vi.fn(async () => ok({ items: [], watermark: 0 })),
          listPermissionAudits: vi.fn(async () => ok({ items: [] })),
          resume: vi.fn(),
          previewDelete: vi.fn(),
          delete: vi.fn(),
          rename: vi.fn(),
          archive: vi.fn()
        },
        agent: {
          getExecutionSnapshot: vi.fn(async () => ok(currentSnapshot)),
          onExecutionUpdate: vi.fn((listener: (snapshot: TaskExecutionSnapshot) => void) => {
            executionListeners.push(listener)
            return () => {
              executionListeners = executionListeners.filter((item) => item !== listener)
            }
          })
        }
      }
    })
  })

  it('查看 Task B 时保留 Task A 的运行执行，且不替换 snapshot', async () => {
    const workbench = useTaskWorkbench()
    await workbench.initialize()
    await workbench.start()
    const before = workbench.executionSnapshot.value

    await workbench.selectTask('task-b')

    expect(workbench.selectedTaskId.value).toBe('task-b')
    expect(workbench.activeExecution.value?.taskId).toBe('task-a')
    expect(workbench.activeExecution.value?.state).toBe('running')
    expect(workbench.executionSnapshot.value).toEqual(before)
    expect(workbench.executionSnapshot.value.execution?.taskId).toBe('task-a')
    expect(workbench.runningTaskCountByProjectId.value['p-a']).toBe(1)
  })

  it('切换 Project 的同一同步回合内必须清掉旧 Task 列表', async () => {
    const workbench = useTaskWorkbench()
    await workbench.initialize()
    expect(workbench.history.tasks.value.map((item) => item.taskId)).toEqual(['task-a'])

    const listB = deferred<Awaited<ReturnType<typeof window.task.list>>>()
    vi.mocked(window.task.list).mockImplementation((projectId: string) => {
      if (projectId === 'p-b') return listB.promise
      return Promise.resolve(ok({ items: [taskSummary('task-a', 'p-a')] }))
    })

    const switching = workbench.selectProject('p-b')

    expect(workbench.selectedProjectId.value).toBe('p-b')
    expect(workbench.history.tasks.value).toEqual([])
    expect(workbench.history.tasks.value.some((item) => item.projectId === 'p-a')).toBe(false)

    listB.resolve(ok({ items: [taskSummary('task-b', 'p-b')] }))
    await switching
    expect(workbench.history.tasks.value.map((item) => item.taskId)).toEqual(['task-b'])
  })

  it('快速 selectProject 后到达的旧 task.list 不得写入当前列表', async () => {
    const workbench = useTaskWorkbench()
    await workbench.initialize()
    const listA = deferred<Awaited<ReturnType<typeof window.task.list>>>()
    vi.mocked(window.task.list).mockImplementation((projectId: string) => {
      if (projectId === 'p-a') return listA.promise
      return Promise.resolve(ok({ items: [taskSummary('task-b', 'p-b')] }))
    })

    const selectingA = workbench.selectProject('p-a')
    const selectingB = workbench.selectProject('p-b')
    await selectingB
    listA.resolve(ok({ items: [taskSummary('task-stale-a', 'p-a')] }))
    await selectingA

    expect(workbench.selectedProjectId.value).toBe('p-b')
    expect(workbench.history.tasks.value.map((item) => item.taskId)).toEqual(['task-b'])
    expect(workbench.history.tasks.value.some((item) => item.taskId === 'task-stale-a')).toBe(false)
  })

  it('快速 selectTask 后到达的旧 task.get 不得把详情 loadState 写成 ready/a', async () => {
    const workbench = useTaskWorkbench()
    await workbench.initialize()
    const detailA = deferred<Awaited<ReturnType<typeof window.task.get>>>()
    vi.mocked(window.task.get).mockImplementation((taskId: string) => {
      if (taskId === 'task-a') return detailA.promise
      return Promise.resolve(
        ok({
          ...taskSummary('task-b', 'p-a'),
          environment: { kind: 'local', projectId: 'p-a' },
          permissionPolicy: { kind: 'legacy-runtime' }
        })
      )
    })

    const openingA = workbench.selectTask('task-a')
    const openingB = workbench.selectTask('task-b')
    await openingB
    detailA.resolve(
      ok({
        ...taskSummary('task-a', 'p-a'),
        environment: { kind: 'local', projectId: 'p-a' },
        permissionPolicy: { kind: 'legacy-runtime' }
      })
    )
    await openingA

    expect(workbench.selectedTaskId.value).toBe('task-b')
    expect(workbench.taskDetailLoadState.value.status).toBe('ready')
    expect(workbench.history.openedTask.value?.taskId).toBe('task-b')
    expect(workbench.taskDetailLoadState.value.errorMessage).not.toContain('task-a')
  })

  it('Project 列表加载失败不清空 activeExecution', async () => {
    const workbench = useTaskWorkbench()
    await workbench.initialize()
    await workbench.start()
    expect(workbench.activeExecution.value?.taskId).toBe('task-a')

    vi.mocked(window.app.listProjects).mockResolvedValueOnce(fail('项目列表失败'))
    await workbench.retryProjects()

    expect(workbench.projectLoadState.value.status).toBe('error')
    expect(workbench.activeExecution.value?.taskId).toBe('task-a')
    expect(workbench.executionSnapshot.value.execution?.state).toBe('running')
  })

  it('Task 列表加载失败不清空已经成功的 Project 列表', async () => {
    const workbench = useTaskWorkbench()
    await workbench.initialize()
    expect(workbench.projects.value).toHaveLength(2)

    vi.mocked(window.task.list).mockResolvedValueOnce(fail('任务列表失败'))
    await workbench.selectProject('p-b')

    expect(workbench.taskListLoadState.value.status).toBe('error')
    expect(workbench.projects.value.map((item) => item.projectId)).toEqual(['p-a', 'p-b'])
    expect(workbench.selectedProjectId.value).toBe('p-b')
  })

  it('终态 snapshot 让 activeExecution 变空，但保留 executionSnapshot.execution', async () => {
    const workbench = useTaskWorkbench()
    await workbench.initialize()
    await workbench.start()
    expect(workbench.activeExecution.value?.taskId).toBe('task-a')

    const running = runningExecution('task-a', 'p-a')
    const terminal = snapshotOf(
      {
        executionId: running.executionId,
        taskId: running.taskId,
        turnId: running.turnId,
        projectId: running.projectId,
        runtimeId: running.runtimeId,
        model: running.model,
        environment: running.environment,
        acceptedAt: running.acceptedAt,
        stateChangedAt: running.stateChangedAt,
        state: 'completed',
        dispatchedAt: running.dispatchedAt,
        endedAt: '2026-08-12T00:01:00.000Z'
      },
      2
    )
    for (const listener of executionListeners) listener(terminal)

    expect(workbench.activeExecution.value).toBeNull()
    expect(workbench.executionSnapshot.value.execution?.state).toBe('completed')
    expect(workbench.executionSnapshot.value.execution?.taskId).toBe('task-a')
  })

  it('retryTaskList 同项目重试失败时保留旧列表和已打开详情', async () => {
    const workbench = useTaskWorkbench()
    await workbench.initialize()
    await workbench.selectTask('task-a')
    expect(workbench.history.openedTask.value?.taskId).toBe('task-a')
    expect(workbench.taskDetailLoadState.value.status).toBe('ready')
    expect(workbench.history.tasks.value.map((item) => item.taskId)).toEqual(['task-a'])

    vi.mocked(window.task.list).mockResolvedValueOnce(fail('列表重试失败'))
    await workbench.retryTaskList()

    expect(workbench.taskListLoadState.value.status).toBe('error')
    expect(workbench.taskListLoadState.value.errorMessage).toBe('列表重试失败')
    expect(workbench.history.tasks.value.map((item) => item.taskId)).toEqual(['task-a'])
    expect(workbench.history.openedTask.value?.taskId).toBe('task-a')
    expect(workbench.taskDetailLoadState.value.status).toBe('ready')
  })

  it('retryTaskList 不得打断进行中的 selectTask，也不能让详情卡在 loading', async () => {
    const workbench = useTaskWorkbench()
    await workbench.initialize()
    const detailA = deferred<Awaited<ReturnType<typeof window.task.get>>>()
    vi.mocked(window.task.get).mockImplementationOnce(() => detailA.promise)

    const opening = workbench.selectTask('task-a')
    expect(workbench.taskDetailLoadState.value.status).toBe('loading')

    await workbench.retryTaskList()
    detailA.resolve(
      ok({
        ...taskSummary('task-a', 'p-a'),
        environment: { kind: 'local', projectId: 'p-a' },
        permissionPolicy: { kind: 'legacy-runtime' }
      })
    )
    await opening

    expect(workbench.taskDetailLoadState.value.status).toBe('ready')
    expect(workbench.history.openedTask.value?.taskId).toBe('task-a')
  })

  it('retryTaskList 失败后再成功时只写入当前 selectedProjectId 的列表', async () => {
    const workbench = useTaskWorkbench()
    await workbench.initialize()
    const staleA = deferred<Awaited<ReturnType<typeof window.task.list>>>()
    let projectBListCalls = 0
    vi.mocked(window.task.list).mockImplementation((projectId: string) => {
      if (projectId === 'p-a') return staleA.promise
      projectBListCalls += 1
      if (projectBListCalls === 1) return Promise.resolve(fail('第一次列表失败'))
      return Promise.resolve(ok({ items: [taskSummary('task-b-retry', 'p-b')] }))
    })

    const leftoverA = workbench.retryTaskList()
    await workbench.selectProject('p-b')
    expect(workbench.taskListLoadState.value.status).toBe('error')
    expect(workbench.selectedProjectId.value).toBe('p-b')

    const retrying = workbench.retryTaskList()
    staleA.resolve(ok({ items: [taskSummary('task-stale-a', 'p-a')] }))
    await leftoverA
    await retrying

    expect(workbench.selectedProjectId.value).toBe('p-b')
    expect(workbench.history.tasks.value.map((item) => item.taskId)).toEqual(['task-b-retry'])
    expect(workbench.taskListLoadState.value.status).toBe('ready')
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
