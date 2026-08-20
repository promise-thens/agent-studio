import { describe, expect, it, vi } from 'vitest'
import type { TaskHistorySummary } from '../../shared/task-history'
import {
  countProjectLiveTasks,
  createAndSelectTask,
  deriveSessionTitle,
  isUntitledTaskTitle,
  resolvePermissionTaskTitle,
  resolveProjectAccordionToggle,
  resolveSidebarTaskSelection,
  tasksForExpandedProject,
  toProjectSwitcherRow,
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
    expect(view.runningMarker).toBe('accent')
    expect(view.showStateChip).toBe(false)
  })

  it('运行中用 accent 条而不是状态芯片文案，title 全文留给 title 属性', () => {
    const longTitle = `把登录改成支持邮箱并补齐回归测试-${'很长标题'.repeat(12)}`
    const view = toTaskListItemView({ ...task('task-a', 'running'), title: longTitle }, 'task-a', {
      taskId: 'task-a',
      state: 'running'
    })

    expect(view.live).toBe(true)
    expect(view.runningMarker).toBe('accent')
    expect(view.showStateChip).toBe(false)
    expect(view.title).toBe(longTitle)
    expect(view.titleAttribute).toBe(longTitle)
    expect(view.title).not.toMatch(/进行中|待审批|排队/)
    expect(view.titleAttribute.length).toBe(longTitle.length)

    const idle = toTaskListItemView(task('task-b', 'completed'), 'task-b', null)
    expect(idle.runningMarker).toBe('none')
    expect(idle.showStateChip).toBe(false)
    expect(idle.titleAttribute).toBe('task-b')
  })

  it('项目切换只给一行标签，路径进 title，不堆路径卡', () => {
    const row = toProjectSwitcherRow({
      displayName: 'agent-studio',
      canonicalRoot: '/Users/demo/work/agent-studio',
      runningTaskCount: 1
    })
    expect(row.label).toBe('agent-studio')
    expect(row.titleAttribute).toBe('/Users/demo/work/agent-studio')
    expect(row.showPathLine).toBe(false)
    expect(row.live).toBe(true)

    const empty = toProjectSwitcherRow({ displayName: '', canonicalRoot: '', runningTaskCount: 0 })
    expect(empty.label).toBe('选择项目')
    expect(empty.showPathLine).toBe(false)
    expect(empty.live).toBe(false)
  })

  it('queued 与 cancelling 也是活动项，不能归档删除', () => {
    const queued = toTaskListItemView(task('task-a', 'queued'), 'task-b', {
      taskId: 'task-a',
      state: 'queued'
    })
    expect(queued).toMatchObject({
      live: true,
      canArchiveOrDelete: false
    })

    const cancelling = toTaskListItemView(task('task-a', 'cancelling'), 'task-b', {
      taskId: 'task-a',
      state: 'cancelling'
    })
    expect(cancelling).toMatchObject({
      live: true,
      canArchiveOrDelete: false
    })

    const queuedOnList = toTaskListItemView(task('task-a', 'queued'), 'task-b', null)
    expect(queuedOnList.live).toBe(true)
    expect(queuedOnList.canArchiveOrDelete).toBe(false)
    expect(
      countProjectLiveTasks('p-a', [task('task-a', 'completed')], 'p-a', {
        taskId: 'task-a',
        state: 'queued',
        projectId: 'p-a'
      })
    ).toBe(1)
    expect(
      countProjectLiveTasks('p-a', [task('task-a', 'completed')], 'p-a', {
        taskId: 'task-a',
        state: 'cancelling',
        projectId: 'p-a'
      })
    ).toBe(1)
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

  it('侧栏项目手风琴：点目录只展开或收起，不切走当前对话', () => {
    expect(
      resolveProjectAccordionToggle({
        expandedProjectId: 'p-a',
        selectedProjectId: 'p-a',
        clickedProjectId: 'p-a'
      })
    ).toEqual({ expandedProjectId: '', shouldSelect: false, shouldBrowse: false })
    expect(
      resolveProjectAccordionToggle({
        expandedProjectId: 'p-a',
        selectedProjectId: 'p-a',
        clickedProjectId: 'p-b'
      })
    ).toEqual({ expandedProjectId: 'p-b', shouldSelect: false, shouldBrowse: true })
    expect(
      resolveProjectAccordionToggle({
        expandedProjectId: '',
        selectedProjectId: 'p-a',
        clickedProjectId: 'p-a'
      })
    ).toEqual({ expandedProjectId: 'p-a', shouldSelect: false, shouldBrowse: false })
  })

  it('展开非当前项目时用浏览列表，当前项目仍用已选中列表', () => {
    const selected = [task('task-a', 'completed', 'p-a')]
    const browse = [task('task-b', 'completed', 'p-b')]
    expect(
      tasksForExpandedProject({
        expandedProjectId: 'p-a',
        selectedProjectId: 'p-a',
        selectedTasks: selected,
        browseProjectId: 'p-b',
        browseTasks: browse
      })
    ).toEqual(selected)
    expect(
      tasksForExpandedProject({
        expandedProjectId: 'p-b',
        selectedProjectId: 'p-a',
        selectedTasks: selected,
        browseProjectId: 'p-b',
        browseTasks: browse
      })
    ).toEqual(browse)
    expect(
      tasksForExpandedProject({
        expandedProjectId: 'p-c',
        selectedProjectId: 'p-a',
        selectedTasks: selected,
        browseProjectId: 'p-b',
        browseTasks: browse
      })
    ).toEqual([])
  })

  it('点浏览列表里的对话才切项目；点当前项目的对话不切', () => {
    const selected = [task('task-a', 'completed', 'p-a')]
    const browse = [task('task-b', 'completed', 'p-b')]
    expect(
      resolveSidebarTaskSelection({
        taskId: 'task-b',
        selectedProjectId: 'p-a',
        selectedTasks: selected,
        browseTasks: browse
      })
    ).toEqual({ projectId: 'p-b', shouldSwitchProject: true })
    expect(
      resolveSidebarTaskSelection({
        taskId: 'task-a',
        selectedProjectId: 'p-a',
        selectedTasks: selected,
        browseTasks: browse
      })
    ).toEqual({ projectId: 'p-a', shouldSwitchProject: false })
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
