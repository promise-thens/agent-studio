import { describe, expect, it, vi } from 'vitest'
import type { TaskHistorySummary } from '../../shared/task-history'
import {
  countProjectLiveTasks,
  createAndSelectTask,
  deriveSessionTitle,
  isUntitledTaskTitle,
  resolvePermissionTaskTitle,
  toTaskListItemView
} from './task-navigation'

function task(
  taskId: string,
  state: TaskHistorySummary['state'] = 'completed',
  projectId = 'p-a'
): TaskHistorySummary {
  return {
    taskId,
    projectId,
    runtimeId: 'grok',
    title: taskId,
    state,
    turnCount: 1,
    resumable: true,
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    revision: 1
  }
}

describe('Task 导航展示', () => {
  it('查看 Task B 时 Task A 仍显示运行徽标', () => {
    const views = [
      toTaskListItemView(task('task-a', 'completed'), 'task-b', {
        taskId: 'task-a',
        state: 'running'
      }),
      toTaskListItemView(task('task-b', 'completed'), 'task-b', {
        taskId: 'task-a',
        state: 'running'
      })
    ]

    expect(views[0]).toMatchObject({
      taskId: 'task-a',
      selected: false,
      live: true,
      canArchiveOrDelete: false
    })
    expect(views[1]).toMatchObject({
      taskId: 'task-b',
      selected: true,
      live: false,
      canArchiveOrDelete: true
    })
  })

  it('列表自身的 waiting-permission 也算活动项', () => {
    const view = toTaskListItemView(task('task-a', 'waiting-permission'), 'task-b', null)
    expect(view.live).toBe(true)
    expect(view.waitingPermission).toBe(true)
    expect(view.canArchiveOrDelete).toBe(false)
  })

  it('未选中 Project 仍能按后台 execution 计运行数', () => {
    expect(
      countProjectLiveTasks('p-a', [task('task-b', 'completed', 'p-b')], 'p-b', {
        taskId: 'task-a',
        state: 'running',
        projectId: 'p-a'
      })
    ).toBe(1)
    expect(
      countProjectLiveTasks('p-b', [task('task-b', 'completed', 'p-b')], 'p-b', {
        taskId: 'task-a',
        state: 'running',
        projectId: 'p-a'
      })
    ).toBe(0)
  })

  it('新对话与新任务都视为未命名，审批摘要优先用派生标题', () => {
    expect(isUntitledTaskTitle('新对话')).toBe(true)
    expect(isUntitledTaskTitle('新任务')).toBe(true)
    expect(isUntitledTaskTitle('   ')).toBe(true)
    expect(isUntitledTaskTitle('生命周期审批任务 A')).toBe(false)
    expect(deriveSessionTitle('生命周期审批任务 A')).toBe('生命周期审批任务 A')
    expect(deriveSessionTitle('  ')).toBe('新对话')
    expect(
      resolvePermissionTaskTitle({
        viewTitle: '新任务',
        storeTitle: '新任务',
        firstPrompt: '生命周期审批任务 A',
        taskId: 'task-a'
      })
    ).toBe('生命周期审批任务 A')
    expect(
      resolvePermissionTaskTitle({
        viewTitle: '生命周期审批任务 A',
        storeTitle: '新任务',
        firstPrompt: '另一条',
        taskId: 'task-a'
      })
    ).toBe('生命周期审批任务 A')
  })

  it('新对话先 createTask 再 selectTask', async () => {
    const selectTask = vi.fn(async () => undefined)
    const createTask = vi.fn(async () => ({ taskId: 'task-new' }))
    const refreshTasks = vi.fn(async () => undefined)

    await expect(
      createAndSelectTask({
        projectId: 'p-a',
        createTask,
        selectTask,
        refreshTasks
      })
    ).resolves.toBe('task-new')

    expect(createTask).toHaveBeenCalledWith('p-a')
    expect(refreshTasks).toHaveBeenCalled()
    expect(selectTask).toHaveBeenCalledWith('task-new')
    expect(createTask.mock.invocationCallOrder[0]).toBeLessThan(
      selectTask.mock.invocationCallOrder[0]
    )
  })
})
