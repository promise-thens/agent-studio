import type { TaskExecutionDto } from '../../shared/task-execution'
import type { HistoryExecutionState, TaskHistorySummary } from '../../shared/task-history'

/** 与 activeExecution 非终态对齐：排队、运行、待审批、停止中都算活动项。 */
const LIVE_TASK_STATES = new Set<string>(['queued', 'running', 'waiting-permission', 'cancelling'])
/** 尚未被首条 Prompt 命名的占位标题；历史默认「新任务」，UI 新建默认「新对话」。 */
const UNTITLED_TASK_TITLES = new Set(['新对话', '新任务'])
const SESSION_TITLE_MAX_LENGTH = 28

/** 空标题和产品占位名都视为未命名，避免审批摘要卡在「新任务」。 */
export function isUntitledTaskTitle(title: string | null | undefined): boolean {
  const compact = title?.trim() ?? ''
  return !compact || UNTITLED_TASK_TITLES.has(compact)
}

/** 从用户首条消息生成侧栏与审批摘要标题，超长时截断保持列表清爽。 */
export function deriveSessionTitle(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return '新对话'
  return compact.length > SESSION_TITLE_MAX_LENGTH
    ? `${compact.slice(0, SESSION_TITLE_MAX_LENGTH)}…`
    : compact
}

/**
 * 审批摘要优先用本地已从首条 Prompt 派生的标题。
 * 视图或仓库仍是未命名占位时，回退到派生标题，而不是继续展示「新任务」。
 */
export function resolvePermissionTaskTitle(input: {
  viewTitle?: string | null
  storeTitle?: string | null
  firstPrompt?: string | null
  taskId: string
}): string {
  const derived = input.firstPrompt ? deriveSessionTitle(input.firstPrompt) : ''
  for (const candidate of [input.viewTitle, derived, input.storeTitle]) {
    const compact = candidate?.trim() ?? ''
    if (compact && !isUntitledTaskTitle(compact)) return compact
  }
  return input.taskId
}

export type TaskListRunningMarker = 'accent' | 'none'

export interface TaskListItemView {
  taskId: string
  title: string
  /** 完整标题给 `title` 属性；展示层用 CSS ellipsis，这里不再截断。 */
  titleAttribute: string
  selected: boolean
  /** 排队/运行/待审批/停止中：由列表状态或后台 execution 共同决定，不依赖当前选中项。 */
  live: boolean
  /** 运行态用左侧细条，不要状态芯片文案。 */
  runningMarker: TaskListRunningMarker
  showStateChip: false
  waitingPermission: boolean
  state: HistoryExecutionState
  canArchiveOrDelete: boolean
}

export interface ProjectSwitcherRow {
  label: string
  titleAttribute: string
  showPathLine: false
  live: boolean
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
    titleAttribute: task.title,
    selected: task.taskId === selectedTaskId,
    live,
    runningMarker: live ? 'accent' : 'none',
    showStateChip: false,
    waitingPermission,
    state: task.state,
    canArchiveOrDelete: !live
  }
}

/**
 * 侧栏项目手风琴：点标题只展开或收起。
 * 展开其它项目时只拉浏览列表，不得 selectProject，否则当前对话会被清掉。
 */
export function resolveProjectAccordionToggle(input: {
  expandedProjectId: string
  selectedProjectId: string
  clickedProjectId: string
}): { expandedProjectId: string; shouldSelect: boolean; shouldBrowse: boolean } {
  if (input.expandedProjectId === input.clickedProjectId) {
    return { expandedProjectId: '', shouldSelect: false, shouldBrowse: false }
  }
  return {
    expandedProjectId: input.clickedProjectId,
    shouldSelect: false,
    shouldBrowse: input.clickedProjectId !== input.selectedProjectId
  }
}

export interface ExpandedProjectTaskLists<T> {
  expandedProjectId: string
  selectedProjectId: string
  selectedTasks: T[]
  browseProjectId: string
  browseTasks: T[]
}

/** 展开块要画哪份对话列表：当前项目用已选中列表，其它项目用浏览列表。 */
export function tasksForExpandedProject<T>(input: ExpandedProjectTaskLists<T>): T[] {
  if (!input.expandedProjectId) return []
  if (input.expandedProjectId === input.selectedProjectId) return input.selectedTasks
  if (input.expandedProjectId === input.browseProjectId) return input.browseTasks
  return []
}

/** 点具体对话才决定要不要切项目；点目录本身不走这条。 */
export function resolveSidebarTaskSelection(input: {
  taskId: string
  selectedProjectId: string
  selectedTasks: readonly Pick<TaskHistorySummary, 'taskId' | 'projectId'>[]
  browseTasks: readonly Pick<TaskHistorySummary, 'taskId' | 'projectId'>[]
}): { projectId: string; shouldSwitchProject: boolean } {
  const match = [...input.selectedTasks, ...input.browseTasks].find(
    (task) => task.taskId === input.taskId
  )
  if (!match) {
    return { projectId: input.selectedProjectId, shouldSwitchProject: false }
  }
  return {
    projectId: match.projectId,
    shouldSwitchProject: match.projectId !== input.selectedProjectId
  }
}

/** 项目切换收成一行标签；完整路径只进 title，避免侧栏堆路径卡。 */
export function toProjectSwitcherRow(input: {
  displayName?: string | null
  canonicalRoot?: string | null
  runningTaskCount?: number
}): ProjectSwitcherRow {
  const label = input.displayName?.trim() || '选择项目'
  const path = input.canonicalRoot?.trim() || ''
  return {
    label,
    titleAttribute: path || label,
    showPathLine: false,
    live: (input.runningTaskCount ?? 0) > 0
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
