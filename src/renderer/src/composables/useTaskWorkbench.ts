import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { TaskExecutionDto, TaskExecutionSnapshot } from '../../../shared/task-execution'
import type { ProjectSummary, TaskHistorySummary } from '../../../shared/task-history'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'
import { createTaskExecutionConsumer } from '../task-execution-consumer'
import { countProjectLiveTasks } from '../task-navigation'
import {
  applyOpenPlugins,
  DEFAULT_WORKBENCH_PRIMARY_VIEW,
  type WorkbenchPrimaryView
} from '../workbench-primary-view'
import {
  createWorkbenchLoadState,
  useProjectRegistry,
  type ProjectRegistryState,
  type WorkbenchLoadState
} from './useProjectRegistry'
import { useTaskHistory, type TaskHistoryState } from './useTaskHistory'

export type TaskExecution = TaskExecutionDto

const ACTIVE_EXECUTION_STATES = new Set<TaskExecution['state']>([
  'queued',
  'running',
  'waiting-permission',
  'cancelling'
])

export interface TaskWorkbenchState {
  selectedProjectId: Ref<string>
  selectedTaskId: Ref<string>
  /** 主列页；与 selectedTaskId / activeExecution 独立，切页不得停 Task。 */
  primaryView: Ref<WorkbenchPrimaryView>
  /** 非终态执行；与 selectedTaskId 独立。终态不得占用此字段。 */
  activeExecution: ComputedRef<TaskExecution | null>
  executionSnapshot: Ref<TaskExecutionSnapshot>
  projectLoadState: Ref<WorkbenchLoadState>
  taskListLoadState: Ref<WorkbenchLoadState>
  taskDetailLoadState: Ref<WorkbenchLoadState>
  executionLoadState: Ref<WorkbenchLoadState>
  /** 展开其它项目时的浏览列表；不改 selectedProjectId / selectedTaskId。 */
  browseProjectId: Ref<string>
  browseTasks: Ref<TaskHistorySummary[]>
  browseLoadState: Ref<WorkbenchLoadState>
  browseHasMore: ComputedRef<boolean>
  browseLoadingMore: Ref<boolean>
  projects: Ref<ProjectSummary[]>
  selectedProject: ComputedRef<ProjectSummary | null>
  runningTaskCountByProjectId: ComputedRef<Record<string, number>>
  initialize(): Promise<void>
  selectProject(projectId: string): Promise<void>
  selectTask(taskId: string): Promise<void>
  openPlugins(): void
  returnToConversation(): void
  browseProject(projectId: string): Promise<void>
  loadMoreBrowseTasks(): Promise<void>
  retryBrowseTasks(): Promise<void>
  retryProjects(): Promise<void>
  retryTaskList(): Promise<void>
  retryTaskDetail(): Promise<void>
  start(): Promise<void>
  dispose(): void
}

export interface TaskWorkbenchController extends TaskWorkbenchState {
  history: TaskHistoryState
  registry: ProjectRegistryState
  acceptExecutionSnapshot(snapshot: TaskExecutionSnapshot): void
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 工作台编排：选中身份、列表/详情加载边界和实时执行相互独立。
 * 查看 Task B 不得改写或清空 Task A 的 execution snapshot。
 */
export function useTaskWorkbench(): TaskWorkbenchController {
  const registry = useProjectRegistry()
  const history = useTaskHistory({ activeProjectId: registry.selectedProjectId })
  const selectedTaskId = ref('')
  const primaryView = ref<WorkbenchPrimaryView>(DEFAULT_WORKBENCH_PRIMARY_VIEW)
  const executionSnapshot = ref<TaskExecutionSnapshot>({
    executorEpoch: 'renderer-initial',
    executionRevision: 0,
    execution: null
  })
  const taskListLoadState = ref<WorkbenchLoadState>(createWorkbenchLoadState())
  const taskDetailLoadState = ref<WorkbenchLoadState>(createWorkbenchLoadState())
  const executionLoadState = ref<WorkbenchLoadState>(createWorkbenchLoadState())
  const browseProjectId = ref('')
  const browseTasks = ref<TaskHistorySummary[]>([])
  const browseLoadState = ref<WorkbenchLoadState>(createWorkbenchLoadState())
  const browseCursor = ref<string | null>(null)
  const browseLoadingMore = ref(false)
  const browseHasMore = computed(() => Boolean(browseCursor.value))
  let taskListRevision = 0
  let taskDetailRevision = 0
  let browseRevision = 0

  const activeExecution = computed(() => {
    const execution = executionSnapshot.value.execution
    return execution && ACTIVE_EXECUTION_STATES.has(execution.state) ? execution : null
  })

  const runningTaskCountByProjectId = computed(() => {
    const counts: Record<string, number> = {}
    for (const project of registry.projects.value) {
      counts[project.projectId] = countProjectLiveTasks(
        project.projectId,
        history.tasks.value,
        registry.selectedProjectId.value,
        activeExecution.value
      )
    }
    return counts
  })

  const executionConsumer = createTaskExecutionConsumer({
    getSnapshot: async () => unwrapDesktopIpcResult(await window.agent.getExecutionSnapshot()),
    subscribe: (listener) => window.agent.onExecutionUpdate(listener),
    onSnapshot: (snapshot) => {
      executionSnapshot.value = snapshot
    }
  })

  /**
   * selectedProjectId 一变就必须同步丢掉旧 Task 入口。
   * 不能先 await 再清列表，否则 Vue 会把新项目和旧 Task 画在一起。
   */
  const stopSelectedProjectWatch = watch(
    registry.selectedProjectId,
    (projectId, previousId) => {
      if (projectId === previousId) return
      selectedTaskId.value = ''
      taskDetailLoadState.value = createWorkbenchLoadState(taskDetailRevision, 'idle')
      history.invalidateProjectTasks()
      clearBrowseTasks()
    },
    { flush: 'sync' }
  )

  /** 丢掉浏览列表，不影响当前对话身份。 */
  function clearBrowseTasks(): void {
    browseRevision += 1
    browseProjectId.value = ''
    browseTasks.value = []
    browseCursor.value = null
    browseLoadingMore.value = false
    browseLoadState.value = createWorkbenchLoadState(browseRevision, 'idle')
  }

  /** 只刷新当前 Project 的 Task 列表，不改选中身份、不拆已打开详情。 */
  async function loadTaskList(projectId: string): Promise<void> {
    const revision = ++taskListRevision
    taskListLoadState.value = createWorkbenchLoadState(revision, 'loading')
    try {
      await history.refreshTasks()
      if (revision !== taskListRevision || registry.selectedProjectId.value !== projectId) return
      taskListLoadState.value = createWorkbenchLoadState(revision, 'ready')
    } catch (error) {
      if (revision !== taskListRevision || registry.selectedProjectId.value !== projectId) return
      taskListLoadState.value = createWorkbenchLoadState(revision, 'error', readErrorMessage(error))
    }
  }

  async function initialize(): Promise<void> {
    await registry.initialize()
    const projectId = registry.selectedProjectId.value
    if (projectId) await loadTaskList(projectId)
  }

  async function selectProject(projectId: string): Promise<void> {
    if (!projectId) return
    selectedTaskId.value = ''
    taskDetailLoadState.value = createWorkbenchLoadState(taskDetailRevision, 'idle')
    // registry.selectProject 没有真实异步；禁止 await，以免在清列表前先交出微任务。
    void registry.selectProject(projectId)
    await loadTaskList(projectId)
  }

  /**
   * 展开其它项目时只拉对话列表，不改 selectedProjectId / selectedTaskId。
   * 点目录不得走 selectProject，否则当前回话会被同步清掉。
   */
  async function browseProject(projectId: string): Promise<void> {
    if (!projectId || projectId === registry.selectedProjectId.value) {
      clearBrowseTasks()
      return
    }
    const revision = ++browseRevision
    browseProjectId.value = projectId
    browseTasks.value = []
    browseCursor.value = null
    browseLoadState.value = createWorkbenchLoadState(revision, 'loading')
    try {
      const page = unwrapDesktopIpcResult(await window.task.list(projectId, undefined, 50))
      if (revision !== browseRevision || browseProjectId.value !== projectId) return
      browseTasks.value = page.items
      browseCursor.value = page.nextCursor ?? null
      browseLoadState.value = createWorkbenchLoadState(revision, 'ready')
    } catch (error) {
      if (revision !== browseRevision || browseProjectId.value !== projectId) return
      browseLoadState.value = createWorkbenchLoadState(revision, 'error', readErrorMessage(error))
    }
  }

  async function loadMoreBrowseTasks(): Promise<void> {
    const projectId = browseProjectId.value
    const cursor = browseCursor.value
    if (!projectId || !cursor || browseLoadingMore.value) return
    browseLoadingMore.value = true
    try {
      const page = unwrapDesktopIpcResult(await window.task.list(projectId, cursor, 50))
      if (browseProjectId.value !== projectId) return
      const seen = new Set(browseTasks.value.map((task) => task.taskId))
      browseTasks.value = [
        ...browseTasks.value,
        ...page.items.filter((task) => !seen.has(task.taskId))
      ]
      browseCursor.value = page.nextCursor ?? null
    } finally {
      browseLoadingMore.value = false
    }
  }

  async function retryBrowseTasks(): Promise<void> {
    const projectId = browseProjectId.value
    if (projectId) await browseProject(projectId)
  }

  /**
   * 立即写入 selectedTaskId，并用独立 revision 保护详情；
   * 不得触碰 executionSnapshot，也不得把运行中的 Task A 清空。
   * 点任务必须回到对话主列，避免新选中的 Task 藏在插件页后面。
   */
  async function selectTask(taskId: string): Promise<void> {
    if (!taskId) return
    selectedTaskId.value = taskId
    primaryView.value = 'conversation'
    const revision = ++taskDetailRevision
    taskDetailLoadState.value = createWorkbenchLoadState(revision, 'loading')
    try {
      const opened = await history.openTask(taskId)
      if (revision !== taskDetailRevision || selectedTaskId.value !== taskId) return
      if (!opened) return
      taskDetailLoadState.value = createWorkbenchLoadState(revision, 'ready')
    } catch (error) {
      if (revision !== taskDetailRevision || selectedTaskId.value !== taskId) return
      taskDetailLoadState.value = createWorkbenchLoadState(
        revision,
        'error',
        readErrorMessage(error)
      )
      throw error
    }
  }

  /**
   * 切到插件页只换主列。
   * 不得 cancelTurn、disconnect 或 selectTask('')，后台 Turn 继续跑。
   */
  function openPlugins(): void {
    const next = applyOpenPlugins({
      selectedTaskId: selectedTaskId.value,
      activeExecutionTaskId: activeExecution.value?.taskId ?? null
    })
    primaryView.value = next.primaryView
  }

  /**
   * 从插件页回到对话只改主列。
   * 不得取消 Turn，也不得清空 selectedTaskId。
   */
  function returnToConversation(): void {
    primaryView.value = 'conversation'
  }

  async function retryProjects(): Promise<void> {
    await registry.refresh()
  }

  async function retryTaskList(): Promise<void> {
    const projectId = registry.selectedProjectId.value
    if (!projectId) return
    if (history.activeProjectId.value !== projectId) {
      void registry.selectProject(projectId)
    }
    await loadTaskList(projectId)
  }

  async function retryTaskDetail(): Promise<void> {
    const taskId = selectedTaskId.value
    if (taskId) await selectTask(taskId)
  }

  async function start(): Promise<void> {
    const revision = executionLoadState.value.revision + 1
    executionLoadState.value = createWorkbenchLoadState(revision, 'loading')
    try {
      await executionConsumer.start()
      executionLoadState.value = createWorkbenchLoadState(revision, 'ready')
    } catch (error) {
      executionLoadState.value = createWorkbenchLoadState(
        revision,
        'error',
        readErrorMessage(error)
      )
    }
  }

  function dispose(): void {
    stopSelectedProjectWatch()
    executionConsumer.dispose()
  }

  function acceptExecutionSnapshot(snapshot: TaskExecutionSnapshot): void {
    executionConsumer.accept(snapshot)
  }

  return {
    selectedProjectId: registry.selectedProjectId,
    selectedTaskId,
    primaryView,
    activeExecution,
    executionSnapshot,
    projectLoadState: registry.loadState,
    taskListLoadState,
    taskDetailLoadState,
    executionLoadState,
    browseProjectId,
    browseTasks,
    browseLoadState,
    browseHasMore,
    browseLoadingMore,
    projects: registry.projects,
    selectedProject: registry.selectedProject,
    runningTaskCountByProjectId,
    initialize,
    selectProject,
    selectTask,
    openPlugins,
    returnToConversation,
    browseProject,
    loadMoreBrowseTasks,
    retryBrowseTasks,
    retryProjects,
    retryTaskList,
    retryTaskDetail,
    start,
    dispose,
    history,
    registry,
    acceptExecutionSnapshot
  }
}
