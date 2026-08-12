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
          get: vi.fn(async () =>
            ok({
              ...task('task-1'),
              environment: { kind: 'local', projectId: project.projectId },
              permissionPolicy: { kind: 'legacy-runtime' }
            })
          ),
          listTurns: vi.fn(async (_taskId: string, cursor?: string) =>
            ok({
              items: [
                {
                  taskId: 'task-1',
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
          listEvents: vi.fn(async (_taskId: string, turnId: string, after = 0) =>
            ok({
              items: [
                {
                  runtimeId: 'grok' as const,
                  capabilityState: 'native' as const,
                  taskId: 'task-1',
                  turnId,
                  sequence: after + 1,
                  observedAt: '2026-08-12T00:00:00.000Z',
                  kind: 'agent-message' as const,
                  text: '完成'
                }
              ],
              ...(after === 0 ? { nextCursor: '1' } : {})
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
    expect(history.openedTurns.value.map((turn) => turn.turnId)).toEqual(['turn-1', 'turn-2'])
    expect(history.eventsByTurn.value['turn-1']?.map((event) => event.sequence)).toEqual([1, 2])
    expect(history.hasMoreEvents('turn-1')).toBe(false)
  })

  it('删除 Task 后同步清理打开状态并刷新当前 Project 列表', async () => {
    const history = useTaskHistory()
    await history.initialize()
    await history.openTask('task-1')
    const preview = await history.previewTaskDeletion('task-1')
    await history.deleteTask('task-1', preview.token)
    expect(history.openedTask.value).toBeNull()
    expect(window.task.delete).toHaveBeenCalledWith('task-1', 'token')
  })
})
