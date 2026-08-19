import type { TaskExecutionDto } from '../../shared/task-execution'
import type { HistoryExecutionState, TaskHistorySummary } from '../../shared/task-history'

const LIVE_TASK_STATES = new Set<string>(['running', 'waiting-permission'])

export interface TaskListItemView {
  taskId: string
  title: string
  selected: boolean
  /** 运行或等待审批：由列表状态或后台 execution 共同决定，不依赖当前选中项。 */
  live: boolean
  waitingPermission: boolean
  state: HistoryExecutionState
  canArchiveOrDelete: boolean
}

/** 后台执行中的 Task 即使没被选中也要显示稳定活动指示。 */
export function taskShowsLiveActivity(
  task: Pick<TaskHistorySummary, 'taskId' | 'state'>,
  activeExecution: Pick<TaskExecutionDto, 'taskId' | 'state'> | null
): boolean {
  if (activeExecution?.taskId === task.taskId) {
    return LIVE_TASK_STATES.has(activeExecution.state)
  }
  return LIVE_TASK_STATES.has(task.state)
}

export function toTaskListItemView(
  task: TaskHistorySummary,
  selectedTaskId: string,
  activeExecution: Pick<TaskExecutionDto, 'taskId' | 'state'> | null
): TaskListItemView {
  const live = taskShowsLiveActivity(task, activeExecution)
  const waitingPermission =
    (activeExecution?.taskId === task.taskId ? activeExecution.state : task.state) ===
    'waiting-permission'
  return {
    taskId: task.taskId,
    title: task.title,
    selected: task.taskId === selectedTaskId,
    live,
    waitingPermission,
    state: task.state,
    canArchiveOrDelete: !live
  }
}

export function countProjectLiveTasks(
  projectId: string,
  tasks: readonly TaskHistorySummary[],
  selectedProjectId: string,
  activeExecution: Pick<TaskExecutionDto, 'taskId' | 'state' | 'projectId'> | null
): number {
  const listed =
    projectId === selectedProjectId
      ? tasks.filter((task) => taskShowsLiveActivity(task, activeExecution)).length
      : 0
  if (
    activeExecution &&
    activeExecution.projectId === projectId &&
    projectId !== selectedProjectId &&
    LIVE_TASK_STATES.has(activeExecution.state)
  ) {
    return listed + 1
  }
  return listed
}

/** 新对话：先创建产品 Task，再走同一条 selectTask / enterTask 路径。 */
export async function createAndSelectTask(input: {
  projectId: string
  createTask: (projectId: string) => Promise<{ taskId: string }>
  selectTask: (taskId: string) => Promise<void>
  refreshTasks?: () => Promise<void>
}): Promise<string> {
  const created = await input.createTask(input.projectId)
  await input.refreshTasks?.()
  await input.selectTask(created.taskId)
  return created.taskId
}
