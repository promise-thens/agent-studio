import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopIpcResult } from '../../../shared/ipc-result'
import type { ProjectSummary, TaskHistorySummary } from '../../../shared/task-history'
import { useTaskHistory } from './useTaskHistory'

const project: ProjectSummary = {
  projectId: 'project-1',
  canonicalRoot: '/tmp/project-1',
  displayName: 'project-1',
  status: 'active',
  availability: { state: 'available' },
  registeredAt: '2026-08-12T00:00:00.000Z',
  lastOpenedAt: '2026-08-12T00:00:00.000Z',
  revision: 1
}

const task = (taskId: string): TaskHistorySummary => ({
  taskId,
  projectId: project.projectId,
  runtimeId: 'grok',
  title: taskId,
  state: 'completed',
  turnCount: 1,
  resumable: true,
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:00.000Z',
  revision: 1
})

function ok<T>(data: T): DesktopIpcResult<T> {
  return { ok: true, value: data }
}

describe('useTaskHistory', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        app: {
          listProjects: vi.fn(async () => ok([project])),
          chooseProject: vi.fn(async () => ok(project)),
          removeProject: vi.fn(async () => ok(null)),
          previewProjectHistoryDeletion: vi.fn(),
          deleteProjectHistory: vi.fn(async () => ok(null))
        },
        task: {
          list: vi.fn(async (_projectId: string, cursor?: string) =>
            ok(
              cursor
                ? { items: [task('task-2')] }
                : { items: [task('task-1')], nextCursor: 'task-1' }
            )
          ),
          get: vi.fn(async (taskId: string) =>
            ok({
              ...task(taskId),
              environment: { kind: 'local', projectId: project.projectId },
              permissionPolicy: { kind: 'legacy-runtime' }
            })
          ),
          listTurns: vi.fn(async (taskId: string, cursor?: string) =>
            ok({
              items: [
                {
                  taskId,
                  turnId: cursor ? 'turn-2' : 'turn-1',
                  promptDisplayText: '测试',
                  model: { modelId: 'model-1' },
                  state: 'completed' as const,
                  createdAt: cursor ? '2026-08-11T00:00:00.000Z' : '2026-08-12T00:00:00.000Z',
                  eventCount: 1,
                  eventBytes: 1,
                  revision: 1
                }
              ],
              ...(cursor ? {} : { nextCursor: 'turn-1' })
            })
          ),
          listEvents: vi.fn(async (taskId: string, turnId: string, after = 0) =>
            ok({
              items: [
                {
                  runtimeId: 'grok' as const,
                  capabilityState: 'native' as const,
                  taskId,
                  turnId,
                  sequence: after + 1,
                  observedAt: '2026-08-12T00:00:00.000Z',
                  kind: 'agent-message' as const,
                  text: '完成'
                }
              ],
              ...(after === 0 ? { nextAfterSequence: 1 } : {}),
              watermark: after + 1
            })
          ),
          listPermissionAudits: vi.fn(async (taskId: string, cursor?: string) =>
            ok({
              items: [
                {
                  auditId: cursor ? 'audit-2' : 'audit-1',
                  taskId,
                  turnId: 'turn-1',
                  projectId: project.projectId,
                  environmentId: 'local:test',
                  initiator: 'runtime' as const,
                  runtimeId: 'grok' as const,
                  operationType: 'write-file' as const,
                  risk: 'L1' as const,
                  targetSummaries: ['path: src/index.ts'],
                  title: '修改文件',
                  impact: '写入 Project 文件。',
                  reason: 'user-allowed' as const,
                  scope: 'once' as const,
                  createdAt: '2026-08-12T00:00:00.000Z'
                }
              ],
              ...(cursor ? {} : { nextCursor: 'audit-1' })
            })
          ),
          resume: vi.fn(),
          previewDelete: vi.fn(async () =>
            ok({
              targetType: 'task' as const,
              targetId: 'task-1',
              revision: 1,
              fileCount: 1,
              turnCount: 1,
              bytes: 1,
              exclusions: [],
              token: 'token',
              expiresAt: '2026-08-12T00:05:00.000Z'
            })
          ),
          delete: vi.fn(async () => ok(null))
        }
      }
    })
  })

  it('初始化、Task 分页和 Turn/Event 分页追加时按身份去重', async () => {
    const history = useTaskHistory()
    await history.initialize()
    await history.loadMoreTasks()
    expect(history.tasks.value.map((item) => item.taskId)).toEqual(['task-1', 'task-2'])

    await history.openTask('task-1')
    await history.loadMoreTurns()
    await history.loadMoreEvents('turn-1')
    await history.loadMorePermissionAudits()
    expect(history.openedTurns.value.map((turn) => turn.turnId)).toEqual(['turn-1', 'turn-2'])
    expect(history.eventsByTurn.value['turn-1']?.map((event) => event.sequence)).toEqual([1, 2])
    expect(history.eventAfterSequenceByTurn.value['turn-1']).toBeNull()
    expect(history.eventWatermarkByTurn.value['turn-1']).toBe(2)
    expect(window.task.listEvents).toHaveBeenLastCalledWith('task-1', 'turn-1', 1, 200)
    expect(history.hasMoreEvents('turn-1')).toBe(false)
    expect(history.permissionAudits.value.map((audit) => audit.auditId)).toEqual([
      'audit-1',
      'audit-2'
    ])
  })

  it('删除 Task 后同步清理打开状态并刷新当前 Project 列表', async () => {
    const history = useTaskHistory()
    await history.initialize()
    await history.openTask('task-1')
    const preview = await history.previewTaskDeletion('task-1')
    await history.deleteTask('task-1', preview.token)
    expect(history.openedTask.value).toBeNull()
    expect(history.permissionAudits.value).toEqual([])
    expect(window.task.delete).toHaveBeenCalledWith('task-1', 'token')
  })

  it('快速打开 A/B 时只有最新 Task 能提交详情、Turn、事件与权限审计', async () => {
    const firstDetail = deferred<
      DesktopIpcResult<
        ReturnType<typeof task> & {
          environment: { kind: 'local'; projectId: string }
          permissionPolicy: { kind: 'legacy-runtime' }
        }
      >
    >()
    vi.mocked(window.task.get)
      .mockImplementationOnce(() => firstDetail.promise)
      .mockResolvedValueOnce(
        ok({
          ...task('task-b'),
          environment: { kind: 'local', projectId: project.projectId },
          permissionPolicy: { kind: 'legacy-runtime' }
        })
      )
    vi.mocked(window.task.listTurns).mockImplementation(async (taskId: string) =>
      ok({
        items: [
          {
            taskId,
            turnId: `turn-${taskId}`,
            promptDisplayText: taskId,
            model: { modelId: 'model-1' },
            state: 'completed' as const,
            createdAt: '2026-08-12T00:00:00.000Z',
            eventCount: 1,
            eventBytes: 1,
            revision: 1
          }
        ]
      })
    )
    vi.mocked(window.task.listPermissionAudits).mockImplementation(async (taskId: string) =>
      ok({
        items: [
          {
            auditId: `audit-${taskId}`,
            taskId,
            turnId: `turn-${taskId}`,
            projectId: project.projectId,
            environmentId: 'local:test',
            initiator: 'runtime' as const,
            runtimeId: 'grok' as const,
            operationType: 'write-file' as const,
            risk: 'L1' as const,
            targetSummaries: ['path: src/index.ts'],
            title: taskId,
            impact: '写入 Project 文件。',
            reason: 'user-allowed' as const,
            scope: 'once' as const,
            createdAt: '2026-08-12T00:00:00.000Z'
          }
        ]
      })
    )

    const history = useTaskHistory()
    const openingA = history.openTask('task-a')
    const openingB = history.openTask('task-b')
    await openingB
    firstDetail.resolve(
      ok({
        ...task('task-a'),
        environment: { kind: 'local', projectId: project.projectId },
        permissionPolicy: { kind: 'legacy-runtime' }
      })
    )
    await openingA

    expect(history.openedTask.value?.taskId).toBe('task-b')
    expect(history.openedTurns.value[0]?.taskId).toBe('task-b')
    expect(history.permissionAudits.value[0]?.taskId).toBe('task-b')
    expect(Object.keys(history.eventsByTurn.value)).toEqual(['turn-task-b'])
    expect(history.loading.value).toBe(false)
  })

  it('Project 切换会让正在读取的旧 Task 失效', async () => {
    const firstDetail = deferred<Awaited<ReturnType<typeof window.task.get>>>()
    vi.mocked(window.task.get).mockImplementationOnce(() => firstDetail.promise)

    const history = useTaskHistory()
    const opening = history.openTask('task-a')
    await history.selectProject(project.projectId)
    firstDetail.resolve(
      ok({
        ...task('task-a'),
        environment: { kind: 'local', projectId: project.projectId },
        permissionPolicy: { kind: 'legacy-runtime' }
      })
    )

    await expect(opening).resolves.toBe(false)
    expect(history.openedTask.value).toBeNull()
    expect(history.openedTurns.value).toEqual([])
    expect(history.eventsByTurn.value).toEqual({})
    expect(history.permissionAudits.value).toEqual([])
  })

  it('Project 列表加载期间同步隐藏旧 Task，避免旧入口继续被操作', async () => {
    const projectPage = deferred<Awaited<ReturnType<typeof window.task.list>>>()
    const history = useTaskHistory()
    await history.initialize()
    vi.mocked(window.task.list).mockImplementationOnce(() => projectPage.promise)

    const switching = history.selectProject('project-b')

    expect(history.activeProjectId.value).toBe('project-b')
    expect(history.tasks.value).toEqual([])
    expect(history.taskCursor.value).toBeNull()
    projectPage.resolve(ok({ items: [] }))
    await switching
  })

  it('外部代次失效后不再让旧 Project 请求改写当前状态', async () => {
    const history = useTaskHistory()
    await history.initialize()
    let current = true

    current = false
    await history.selectProject('project-stale', () => current)

    expect(history.activeProjectId.value).toBe(project.projectId)
    expect(window.task.list).toHaveBeenCalledTimes(1)
  })

  it('切换 Task 后丢弃旧 Turn 分页及其 Event，并保持新 Task 加载状态', async () => {
    const oldTurnPage = deferred<Awaited<ReturnType<typeof window.task.listTurns>>>()
    const nextDetail = deferred<Awaited<ReturnType<typeof window.task.get>>>()
    vi.mocked(window.task.listTurns).mockImplementationOnce(async () =>
      ok({
        items: [
          {
            taskId: 'task-a',
            turnId: 'turn-a',
            promptDisplayText: 'A',
            model: { modelId: 'model-1' },
            state: 'completed' as const,
            createdAt: '2026-08-12T00:00:00.000Z',
            eventCount: 1,
            eventBytes: 1,
            revision: 1
          }
        ],
        nextCursor: 'turn-a'
      })
    )
    const history = useTaskHistory()
    await history.openTask('task-a')
    vi.mocked(window.task.listTurns).mockImplementationOnce(() => oldTurnPage.promise)
    vi.mocked(window.task.get).mockImplementationOnce(() => nextDetail.promise)

    const loadingOldTurns = history.loadMoreTurns()
    const openingB = history.openTask('task-b')
    expect(history.loading.value).toBe(true)
    oldTurnPage.resolve(
      ok({
        items: [
          {
            taskId: 'task-a',
            turnId: 'turn-a-old',
            promptDisplayText: 'A old',
            model: { modelId: 'model-1' },
            state: 'completed' as const,
            createdAt: '2026-08-11T00:00:00.000Z',
            eventCount: 1,
            eventBytes: 1,
            revision: 1
          }
        ]
      })
    )
    await loadingOldTurns
    expect(history.loading.value).toBe(true)
    nextDetail.resolve(
      ok({
        ...task('task-b'),
        environment: { kind: 'local', projectId: project.projectId },
        permissionPolicy: { kind: 'legacy-runtime' }
      })
    )
    await openingB

    expect(history.openedTask.value?.taskId).toBe('task-b')
    expect(history.openedTurns.value.every((turn) => turn.taskId === 'task-b')).toBe(true)
    expect(Object.keys(history.eventsByTurn.value)).toEqual(['turn-1'])
    expect(history.eventsByTurn.value['turn-1']?.[0]?.taskId).toBe('task-b')
    expect(history.loadingMoreTurns.value).toBe(false)
  })

  it('切换 Task 后丢弃旧 Event 分页响应', async () => {
    const oldEventPage = deferred<Awaited<ReturnType<typeof window.task.listEvents>>>()
    const history = useTaskHistory()
    await history.openTask('task-a')
    vi.mocked(window.task.listEvents).mockImplementationOnce(() => oldEventPage.promise)

    const loadingOldEvents = history.loadMoreEvents('turn-1')
    await history.openTask('task-b')
    oldEventPage.resolve(
      ok({
        items: [
          {
            runtimeId: 'grok',
            capabilityState: 'native',
            taskId: 'task-a',
            turnId: 'turn-1',
            sequence: 2,
            observedAt: '2026-08-12T00:00:01.000Z',
            kind: 'agent-message',
            text: '旧响应'
          }
        ],
        watermark: 2
      })
    )
    await loadingOldEvents

    expect(history.openedTask.value?.taskId).toBe('task-b')
    expect(history.eventsByTurn.value['turn-1']?.map((event) => event.taskId)).toEqual(['task-b'])
    expect(history.loadingEventTurnIds.value).toEqual([])
  })

  it('切换 Task 后丢弃旧权限审计分页，并保持新 Task 加载状态', async () => {
    const oldAuditPage = deferred<Awaited<ReturnType<typeof window.task.listPermissionAudits>>>()
    const nextDetail = deferred<Awaited<ReturnType<typeof window.task.get>>>()
    const history = useTaskHistory()
    await history.openTask('task-a')
    vi.mocked(window.task.listPermissionAudits).mockImplementationOnce(() => oldAuditPage.promise)
    vi.mocked(window.task.get).mockImplementationOnce(() => nextDetail.promise)

    const loadingOldAudits = history.loadMorePermissionAudits()
    const openingB = history.openTask('task-b')
    expect(history.loading.value).toBe(true)
    oldAuditPage.resolve(
      ok({
        items: [
          {
            auditId: 'audit-old',
            taskId: 'task-a',
            turnId: 'turn-1',
            projectId: project.projectId,
            environmentId: 'local:test',
            initiator: 'runtime',
            runtimeId: 'grok',
            operationType: 'write-file',
            risk: 'L1',
            targetSummaries: ['path: old.ts'],
            title: '旧审计',
            impact: '旧响应',
            reason: 'user-allowed',
            scope: 'once',
            createdAt: '2026-08-12T00:00:00.000Z'
          }
        ]
      })
    )
    await loadingOldAudits
    expect(history.loading.value).toBe(true)
    nextDetail.resolve(
      ok({
        ...task('task-b'),
        environment: { kind: 'local', projectId: project.projectId },
        permissionPolicy: { kind: 'legacy-runtime' }
      })
    )
    await openingB

    expect(history.openedTask.value?.taskId).toBe('task-b')
    expect(history.permissionAudits.value.every((audit) => audit.auditId !== 'audit-old')).toBe(
      true
    )
    expect(history.loadingMorePermissionAudits.value).toBe(false)
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
