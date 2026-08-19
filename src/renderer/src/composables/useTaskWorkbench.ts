import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { TaskExecutionDto, TaskExecutionSnapshot } from '../../../shared/task-execution'
import type { ProjectSummary } from '../../../shared/task-history'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'
import { createTaskExecutionConsumer } from '../task-execution-consumer'
import { countProjectLiveTasks } from '../task-navigation'
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
  /** 非终态执行；与 selectedTaskId 独立。终态不得占用此字段。 */
  activeExecution: ComputedRef<TaskExecution | null>
  executionSnapshot: Ref<TaskExecutionSnapshot>
  projectLoadState: Ref<WorkbenchLoadState>
  taskListLoadState: Ref<WorkbenchLoadState>
  taskDetailLoadState: Ref<WorkbenchLoadState>
  executionLoadState: Ref<WorkbenchLoadState>
  projects: Ref<ProjectSummary[]>
  selectedProject: ComputedRef<ProjectSummary | null>
  runningTaskCountByProjectId: ComputedRef<Record<string, number>>
  initialize(): Promise<void>
  selectProject(projectId: string): Promise<void>
  selectTask(taskId: string): Promise<void>
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
  const executionSnapshot = ref<TaskExecutionSnapshot>({
    executorEpoch: 'renderer-initial',
    executionRevision: 0,
    execution: null
  })
  const taskListLoadState = ref<WorkbenchLoadState>(createWorkbenchLoadState())
  const taskDetailLoadState = ref<WorkbenchLoadState>(createWorkbenchLoadState())
  const executionLoadState = ref<WorkbenchLoadState>(createWorkbenchLoadState())
  let taskListRevision = 0
  let taskDetailRevision = 0

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
    },
    { flush: 'sync' }
  )

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
   * 立即写入 selectedTaskId，并用独立 revision 保护详情；
   * 不得触碰 executionSnapshot，也不得把运行中的 Task A 清空。
   */
  async function selectTask(taskId: string): Promise<void> {
    if (!taskId) return
    selectedTaskId.value = taskId
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
    activeExecution,
    executionSnapshot,
    projectLoadState: registry.loadState,
    taskListLoadState,
    taskDetailLoadState,
    executionLoadState,
    projects: registry.projects,
    selectedProject: registry.selectedProject,
    runningTaskCountByProjectId,
    initialize,
    selectProject,
    selectTask,
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
