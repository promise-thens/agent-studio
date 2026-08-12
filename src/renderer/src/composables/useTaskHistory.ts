import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type {
  DeletionPreview,
  PersistedAgentEvent,
  ProjectSummary,
  RuntimeResumeSummary,
  TaskHistoryDetail,
  TaskHistorySummary,
  TurnHistoryRecord
} from '../../../shared/task-history'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'

interface TaskHistoryState {
  projects: Ref<ProjectSummary[]>
  tasks: Ref<TaskHistorySummary[]>
  activeProjectId: Ref<string>
  activeProject: ComputedRef<ProjectSummary | null>
  openedTask: Ref<TaskHistoryDetail | null>
  openedTurns: Ref<TurnHistoryRecord[]>
  eventsByTurn: Ref<Record<string, PersistedAgentEvent[]>>
  loading: Ref<boolean>
  errorMessage: Ref<string>
  deletionPreview: Ref<DeletionPreview | null>
  taskCursor: Ref<string | null>
  turnCursor: Ref<string | null>
  eventCursorByTurn: Ref<Record<string, number | null>>
  loadingMoreTasks: Ref<boolean>
  loadingMoreTurns: Ref<boolean>
  loadingEventTurnIds: Ref<string[]>
  initialize(): Promise<void>
  chooseProject(): Promise<ProjectSummary | null>
  selectProject(projectId: string): Promise<void>
  refreshTasks(): Promise<void>
  loadMoreTasks(): Promise<void>
  openTask(taskId: string): Promise<void>
  loadMoreTurns(): Promise<void>
  loadMoreEvents(turnId: string): Promise<void>
  hasMoreEvents(turnId: string): boolean
  resumeOpenedTask(): Promise<RuntimeResumeSummary>
  previewTaskDeletion(taskId: string): Promise<DeletionPreview>
  deleteTask(taskId: string, token: string): Promise<void>
  removeProject(projectId: string): Promise<void>
  previewProjectDeletion(projectId: string): Promise<DeletionPreview>
  deleteProjectHistory(projectId: string, token: string): Promise<void>
}

/** 管理 Project/Task 历史查询，不把分页与删除事务继续堆入 App.vue。 */
export function useTaskHistory(): TaskHistoryState {
  const projects = ref<ProjectSummary[]>([])
  const tasks = ref<TaskHistorySummary[]>([])
  const activeProjectId = ref('')
  const openedTask = ref<TaskHistoryDetail | null>(null)
  const openedTurns = ref<TurnHistoryRecord[]>([])
  const eventsByTurn = ref<Record<string, PersistedAgentEvent[]>>({})
  const loading = ref(false)
  const errorMessage = ref('')
  const deletionPreview = ref<DeletionPreview | null>(null)
  const taskCursor = ref<string | null>(null)
  const turnCursor = ref<string | null>(null)
  const eventCursorByTurn = ref<Record<string, number | null>>({})
  const loadingMoreTasks = ref(false)
  const loadingMoreTurns = ref(false)
  const loadingEventTurnIds = ref<string[]>([])
  let projectRequestId = 0
  const activeProject = computed(
    () => projects.value.find((project) => project.projectId === activeProjectId.value) ?? null
  )

  async function initialize(): Promise<void> {
    projects.value = unwrapDesktopIpcResult(await window.app.listProjects())
    const preferred = projects.value.find((project) => project.status === 'active')
    if (preferred) await selectProject(preferred.projectId)
  }

  async function chooseProject(): Promise<ProjectSummary | null> {
    const project = unwrapDesktopIpcResult(await window.app.chooseProject())
    if (!project) return null
    projects.value = [
      project,
      ...projects.value.filter((item) => item.projectId !== project.projectId)
    ]
    await selectProject(project.projectId)
    return project
  }

  async function selectProject(projectId: string): Promise<void> {
    const requestId = ++projectRequestId
    activeProjectId.value = projectId
    openedTask.value = null
    openedTurns.value = []
    eventsByTurn.value = {}
    turnCursor.value = null
    eventCursorByTurn.value = {}
    const page = unwrapDesktopIpcResult(await window.task.list(projectId, undefined, 50))
    if (requestId !== projectRequestId || activeProjectId.value !== projectId) return
    tasks.value = page.items
    taskCursor.value = page.nextCursor ?? null
  }

  async function refreshTasks(): Promise<void> {
    const projectId = activeProjectId.value
    if (!projectId) {
      tasks.value = []
      taskCursor.value = null
      return
    }
    const requestId = ++projectRequestId
    const page = unwrapDesktopIpcResult(await window.task.list(projectId, undefined, 50))
    if (requestId !== projectRequestId || activeProjectId.value !== projectId) return
    tasks.value = page.items
    taskCursor.value = page.nextCursor ?? null
  }

  async function loadMoreTasks(): Promise<void> {
    const projectId = activeProjectId.value
    const cursor = taskCursor.value
    if (!projectId || !cursor || loadingMoreTasks.value) return
    loadingMoreTasks.value = true
    try {
      const page = unwrapDesktopIpcResult(await window.task.list(projectId, cursor, 50))
      if (activeProjectId.value !== projectId) return
      tasks.value = mergeUnique(tasks.value, page.items, (task) => task.taskId)
      taskCursor.value = page.nextCursor ?? null
    } finally {
      loadingMoreTasks.value = false
    }
  }

  async function openTask(taskId: string): Promise<void> {
    loading.value = true
    errorMessage.value = ''
    try {
      openedTask.value = unwrapDesktopIpcResult(await window.task.get(taskId))
      const turnPage = unwrapDesktopIpcResult(await window.task.listTurns(taskId, undefined, 20))
      openedTurns.value = turnPage.items
      turnCursor.value = turnPage.nextCursor ?? null
      await loadEventPages(taskId, turnPage.items, true)
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      loading.value = false
    }
  }

  async function loadMoreTurns(): Promise<void> {
    const taskId = openedTask.value?.taskId
    const cursor = turnCursor.value
    if (!taskId || !cursor || loadingMoreTurns.value) return
    loadingMoreTurns.value = true
    try {
      const page = unwrapDesktopIpcResult(await window.task.listTurns(taskId, cursor, 20))
      openedTurns.value = mergeUnique(openedTurns.value, page.items, (turn) => turn.turnId)
      turnCursor.value = page.nextCursor ?? null
      await loadEventPages(taskId, page.items, false)
    } finally {
      loadingMoreTurns.value = false
    }
  }

  async function loadMoreEvents(turnId: string): Promise<void> {
    const taskId = openedTask.value?.taskId
    const cursor = eventCursorByTurn.value[turnId]
    if (!taskId || cursor == null || loadingEventTurnIds.value.includes(turnId)) return
    loadingEventTurnIds.value = [...loadingEventTurnIds.value, turnId]
    try {
      const page = unwrapDesktopIpcResult(await window.task.listEvents(taskId, turnId, cursor, 200))
      eventsByTurn.value = {
        ...eventsByTurn.value,
        [turnId]: mergeUnique(eventsByTurn.value[turnId] ?? [], page.items, (event) =>
          String(event.sequence)
        ).sort((left, right) => left.sequence - right.sequence)
      }
      eventCursorByTurn.value = {
        ...eventCursorByTurn.value,
        [turnId]: parseSequenceCursor(page.nextCursor)
      }
    } finally {
      loadingEventTurnIds.value = loadingEventTurnIds.value.filter((id) => id !== turnId)
    }
  }

  function hasMoreEvents(turnId: string): boolean {
    return eventCursorByTurn.value[turnId] != null
  }

  async function resumeOpenedTask(): Promise<RuntimeResumeSummary> {
    const taskId = openedTask.value?.taskId
    if (!taskId) throw new Error('未打开可继续的 Task。')
    return unwrapDesktopIpcResult(await window.task.resume(taskId))
  }

  async function previewTaskDeletion(taskId: string): Promise<DeletionPreview> {
    const preview = unwrapDesktopIpcResult(await window.task.previewDelete(taskId))
    deletionPreview.value = preview
    return preview
  }

  async function deleteTask(taskId: string, token: string): Promise<void> {
    unwrapDesktopIpcResult(await window.task.delete(taskId, token))
    tasks.value = tasks.value.filter((task) => task.taskId !== taskId)
    if (openedTask.value?.taskId === taskId) openedTask.value = null
    deletionPreview.value = null
    await refreshTasks()
  }

  async function removeProject(projectId: string): Promise<void> {
    unwrapDesktopIpcResult(await window.app.removeProject(projectId))
    projects.value = unwrapDesktopIpcResult(await window.app.listProjects())
    if (activeProjectId.value === projectId) {
      const fallback = projects.value.find((project) => project.status === 'active')
      if (fallback) await selectProject(fallback.projectId)
      else clearProjectSelection()
    }
  }

  async function previewProjectDeletion(projectId: string): Promise<DeletionPreview> {
    const preview = unwrapDesktopIpcResult(
      await window.app.previewProjectHistoryDeletion(projectId)
    )
    deletionPreview.value = preview
    return preview
  }

  async function deleteProjectHistory(projectId: string, token: string): Promise<void> {
    unwrapDesktopIpcResult(await window.app.deleteProjectHistory(projectId, token))
    if (activeProjectId.value === projectId) {
      tasks.value = []
      taskCursor.value = null
      openedTask.value = null
      openedTurns.value = []
      eventsByTurn.value = {}
      turnCursor.value = null
      eventCursorByTurn.value = {}
    }
    deletionPreview.value = null
  }

  async function loadEventPages(
    taskId: string,
    turns: TurnHistoryRecord[],
    replace: boolean
  ): Promise<void> {
    const entries = await Promise.all(
      turns.map(async (turn) => {
        const page = unwrapDesktopIpcResult(
          await window.task.listEvents(taskId, turn.turnId, 0, 200)
        )
        return [turn.turnId, page] as const
      })
    )
    const nextEvents = replace ? {} : { ...eventsByTurn.value }
    const nextCursors = replace ? {} : { ...eventCursorByTurn.value }
    for (const [turnId, page] of entries) {
      nextEvents[turnId] = page.items
      nextCursors[turnId] = parseSequenceCursor(page.nextCursor)
    }
    eventsByTurn.value = nextEvents
    eventCursorByTurn.value = nextCursors
  }

  function clearProjectSelection(): void {
    activeProjectId.value = ''
    tasks.value = []
    taskCursor.value = null
    openedTask.value = null
    openedTurns.value = []
    eventsByTurn.value = {}
    turnCursor.value = null
    eventCursorByTurn.value = {}
  }

  return {
    projects,
    tasks,
    activeProjectId,
    activeProject,
    openedTask,
    openedTurns,
    eventsByTurn,
    loading,
    errorMessage,
    deletionPreview,
    taskCursor,
    turnCursor,
    eventCursorByTurn,
    loadingMoreTasks,
    loadingMoreTurns,
    loadingEventTurnIds,
    initialize,
    chooseProject,
    selectProject,
    refreshTasks,
    loadMoreTasks,
    openTask,
    loadMoreTurns,
    loadMoreEvents,
    hasMoreEvents,
    resumeOpenedTask,
    previewTaskDeletion,
    deleteTask,
    removeProject,
    previewProjectDeletion,
    deleteProjectHistory
  }
}

function mergeUnique<T>(current: T[], incoming: T[], identify: (value: T) => string): T[] {
  const result = [...current]
  const seen = new Set(result.map(identify))
  for (const item of incoming) {
    const id = identify(item)
    if (!seen.has(id)) {
      seen.add(id)
      result.push(item)
    }
  }
  return result
}

function parseSequenceCursor(cursor?: string): number | null {
  if (cursor == null || !/^\d+$/.test(cursor)) return null
  const value = Number(cursor)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}
