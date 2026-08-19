import { ref, type Ref } from 'vue'
import type {
  DeletionPreview,
  PermissionAuditRecord,
  RuntimeResumeSummary,
  TaskHistoryDetail,
  TaskHistorySummary,
  TurnHistoryRecord
} from '../../../shared/task-history'
import type { PublicAgentEvent } from '../../../shared/agent-event'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'

export interface TaskHistoryState {
  tasks: Ref<TaskHistorySummary[]>
  activeProjectId: Ref<string>
  openedTask: Ref<TaskHistoryDetail | null>
  openedTurns: Ref<TurnHistoryRecord[]>
  eventsByTurn: Ref<Record<string, PublicAgentEvent[]>>
  permissionAudits: Ref<PermissionAuditRecord[]>
  loading: Ref<boolean>
  errorMessage: Ref<string>
  deletionPreview: Ref<DeletionPreview | null>
  taskCursor: Ref<string | null>
  turnCursor: Ref<string | null>
  eventAfterSequenceByTurn: Ref<Record<string, number | null>>
  eventWatermarkByTurn: Ref<Record<string, number>>
  permissionAuditCursor: Ref<string | null>
  loadingMoreTasks: Ref<boolean>
  loadingMoreTurns: Ref<boolean>
  loadingEventTurnIds: Ref<string[]>
  loadingMorePermissionAudits: Ref<boolean>
  selectProject(projectId: string, isCurrent?: () => boolean): Promise<void>
  /** 同步丢掉当前 Project 的 Task 列表与打开态，供选中身份刚变化时使用。 */
  invalidateProjectTasks(): void
  refreshTasks(): Promise<void>
  loadMoreTasks(): Promise<void>
  openTask(taskId: string): Promise<boolean>
  loadMoreTurns(): Promise<void>
  loadMoreEvents(turnId: string): Promise<void>
  loadMorePermissionAudits(): Promise<void>
  hasMoreEvents(turnId: string): boolean
  resumeOpenedTask(): Promise<RuntimeResumeSummary>
  previewTaskDeletion(taskId: string): Promise<DeletionPreview>
  deleteTask(taskId: string, token: string): Promise<void>
}

export interface UseTaskHistoryOptions {
  /** 与 Project registry 共用选中身份，避免两侧 projectId 在 await 之间分叉。 */
  activeProjectId?: Ref<string>
}

/** 管理 Task/Turn/Event 历史查询；Project 列表身份已迁到 useProjectRegistry。 */
export function useTaskHistory(options: UseTaskHistoryOptions = {}): TaskHistoryState {
  const tasks = ref<TaskHistorySummary[]>([])
  const activeProjectId = options.activeProjectId ?? ref('')
  const openedTask = ref<TaskHistoryDetail | null>(null)
  const openedTurns = ref<TurnHistoryRecord[]>([])
  const eventsByTurn = ref<Record<string, PublicAgentEvent[]>>({})
  const permissionAudits = ref<PermissionAuditRecord[]>([])
  const loading = ref(false)
  const errorMessage = ref('')
  const deletionPreview = ref<DeletionPreview | null>(null)
  const taskCursor = ref<string | null>(null)
  const turnCursor = ref<string | null>(null)
  const eventAfterSequenceByTurn = ref<Record<string, number | null>>({})
  const eventWatermarkByTurn = ref<Record<string, number>>({})
  const permissionAuditCursor = ref<string | null>(null)
  const loadingMoreTasks = ref(false)
  const loadingMoreTurns = ref(false)
  const loadingEventTurnIds = ref<string[]>([])
  const loadingMorePermissionAudits = ref(false)
  let projectRequestId = 0
  let taskRequestId = 0

  async function selectProject(
    projectId: string,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    if (!isCurrent()) return
    activeProjectId.value = projectId
    invalidateProjectTasks()
    const requestId = projectRequestId
    const page = unwrapDesktopIpcResult(await window.task.list(projectId, undefined, 50))
    if (!isCurrent() || requestId !== projectRequestId || activeProjectId.value !== projectId) {
      return
    }
    tasks.value = page.items
    taskCursor.value = page.nextCursor ?? null
  }

  /** 身份已变时必须同步清空列表；同项目 refresh 不得走这条路径。 */
  function invalidateProjectTasks(): void {
    projectRequestId += 1
    tasks.value = []
    taskCursor.value = null
    clearOpenedTaskState()
  }

  /** 同项目重拉列表：成功才替换；失败抛出并保留旧 items，也不拆已打开的详情。 */
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

  async function openTask(taskId: string): Promise<boolean> {
    const requestId = invalidateOpenedTaskRequests()
    loading.value = true
    errorMessage.value = ''
    try {
      const [detail, turnPage, auditPage] = await Promise.all([
        window.task.get(taskId).then(unwrapDesktopIpcResult),
        window.task.listTurns(taskId, undefined, 20).then(unwrapDesktopIpcResult),
        window.task.listPermissionAudits(taskId, undefined, 50).then(unwrapDesktopIpcResult)
      ])
      const eventPages = await readEventPages(taskId, turnPage.items)
      if (requestId !== taskRequestId) return false
      openedTask.value = detail
      openedTurns.value = turnPage.items
      permissionAudits.value = auditPage.items
      turnCursor.value = turnPage.nextCursor ?? null
      permissionAuditCursor.value = auditPage.nextCursor ?? null
      eventsByTurn.value = eventPages.events
      eventAfterSequenceByTurn.value = eventPages.afterSequences
      eventWatermarkByTurn.value = eventPages.watermarks
      return true
    } catch (error) {
      if (requestId !== taskRequestId) return false
      errorMessage.value = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      if (requestId === taskRequestId) loading.value = false
    }
  }

  async function loadMoreTurns(): Promise<void> {
    const taskId = openedTask.value?.taskId
    const cursor = turnCursor.value
    const requestId = taskRequestId
    if (!taskId || !cursor || loading.value || loadingMoreTurns.value) return
    loadingMoreTurns.value = true
    try {
      const page = unwrapDesktopIpcResult(await window.task.listTurns(taskId, cursor, 20))
      if (!isCurrentOpenedTaskRequest(requestId, taskId)) return
      const eventPages = await readEventPages(taskId, page.items)
      if (!isCurrentOpenedTaskRequest(requestId, taskId)) return
      openedTurns.value = mergeUnique(openedTurns.value, page.items, (turn) => turn.turnId)
      turnCursor.value = page.nextCursor ?? null
      const nextEvents = { ...eventsByTurn.value }
      const nextAfterSequences = { ...eventAfterSequenceByTurn.value }
      const nextWatermarks = { ...eventWatermarkByTurn.value }
      Object.assign(nextEvents, eventPages.events)
      Object.assign(nextAfterSequences, eventPages.afterSequences)
      Object.assign(nextWatermarks, eventPages.watermarks)
      eventsByTurn.value = nextEvents
      eventAfterSequenceByTurn.value = nextAfterSequences
      eventWatermarkByTurn.value = nextWatermarks
    } catch (error) {
      if (!isCurrentOpenedTaskRequest(requestId, taskId)) return
      throw error
    } finally {
      if (isCurrentOpenedTaskRequest(requestId, taskId)) loadingMoreTurns.value = false
    }
  }

  async function loadMoreEvents(turnId: string): Promise<void> {
    const taskId = openedTask.value?.taskId
    const afterSequence = eventAfterSequenceByTurn.value[turnId]
    const requestId = taskRequestId
    if (
      !taskId ||
      afterSequence == null ||
      loading.value ||
      loadingEventTurnIds.value.includes(turnId)
    ) {
      return
    }
    loadingEventTurnIds.value = [...loadingEventTurnIds.value, turnId]
    try {
      const page = unwrapDesktopIpcResult(
        await window.task.listEvents(taskId, turnId, afterSequence, 200)
      )
      if (!isCurrentOpenedTaskRequest(requestId, taskId)) return
      eventsByTurn.value = {
        ...eventsByTurn.value,
        [turnId]: mergeEventsBySequence(eventsByTurn.value[turnId] ?? [], page.items)
      }
      eventAfterSequenceByTurn.value = {
        ...eventAfterSequenceByTurn.value,
        [turnId]: page.nextAfterSequence ?? null
      }
      eventWatermarkByTurn.value = {
        ...eventWatermarkByTurn.value,
        [turnId]: page.watermark
      }
    } catch (error) {
      if (!isCurrentOpenedTaskRequest(requestId, taskId)) return
      throw error
    } finally {
      if (isCurrentOpenedTaskRequest(requestId, taskId)) {
        loadingEventTurnIds.value = loadingEventTurnIds.value.filter((id) => id !== turnId)
      }
    }
  }

  function hasMoreEvents(turnId: string): boolean {
    return eventAfterSequenceByTurn.value[turnId] != null
  }

  async function loadMorePermissionAudits(): Promise<void> {
    const taskId = openedTask.value?.taskId
    const cursor = permissionAuditCursor.value
    const requestId = taskRequestId
    if (!taskId || !cursor || loading.value || loadingMorePermissionAudits.value) return
    loadingMorePermissionAudits.value = true
    try {
      const page = unwrapDesktopIpcResult(
        await window.task.listPermissionAudits(taskId, cursor, 50)
      )
      if (!isCurrentOpenedTaskRequest(requestId, taskId)) return
      permissionAudits.value = mergeUnique(
        permissionAudits.value,
        page.items,
        (audit) => audit.auditId
      )
      permissionAuditCursor.value = page.nextCursor ?? null
    } catch (error) {
      if (!isCurrentOpenedTaskRequest(requestId, taskId)) return
      throw error
    } finally {
      if (isCurrentOpenedTaskRequest(requestId, taskId)) {
        loadingMorePermissionAudits.value = false
      }
    }
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
    if (openedTask.value?.taskId === taskId) {
      clearOpenedTaskState()
    }
    deletionPreview.value = null
    await refreshTasks()
  }

  /** 先在局部变量读取完整首屏，只有最新 openTask 请求才一次性提交响应式状态。 */
  async function readEventPages(
    taskId: string,
    turns: TurnHistoryRecord[]
  ): Promise<{
    events: Record<string, PublicAgentEvent[]>
    afterSequences: Record<string, number | null>
    watermarks: Record<string, number>
  }> {
    const entries = await Promise.all(
      turns.map(async (turn) => {
        const page = unwrapDesktopIpcResult(
          await window.task.listEvents(taskId, turn.turnId, 0, 200)
        )
        return [turn.turnId, page] as const
      })
    )
    return {
      events: Object.fromEntries(
        entries.map(([turnId, page]) => [turnId, mergeEventsBySequence([], page.items)])
      ),
      afterSequences: Object.fromEntries(
        entries.map(([turnId, page]) => [turnId, page.nextAfterSequence ?? null])
      ),
      watermarks: Object.fromEntries(entries.map(([turnId, page]) => [turnId, page.watermark]))
    }
  }

  /** 让旧 Task 请求全部失效，并同步复位只属于该请求代际的加载状态。 */
  function invalidateOpenedTaskRequests(): number {
    taskRequestId += 1
    loading.value = false
    loadingMoreTurns.value = false
    loadingEventTurnIds.value = []
    loadingMorePermissionAudits.value = false
    return taskRequestId
  }

  /** 清空当前 Task 历史；Project 切换或删除后，旧响应不得再写回新上下文。 */
  function clearOpenedTaskState(): void {
    invalidateOpenedTaskRequests()
    openedTask.value = null
    openedTurns.value = []
    eventsByTurn.value = {}
    permissionAudits.value = []
    turnCursor.value = null
    eventAfterSequenceByTurn.value = {}
    eventWatermarkByTurn.value = {}
    permissionAuditCursor.value = null
    errorMessage.value = ''
  }

  function isCurrentOpenedTaskRequest(requestId: number, taskId: string): boolean {
    return requestId === taskRequestId && openedTask.value?.taskId === taskId
  }

  return {
    tasks,
    activeProjectId,
    openedTask,
    openedTurns,
    eventsByTurn,
    permissionAudits,
    loading,
    errorMessage,
    deletionPreview,
    taskCursor,
    turnCursor,
    eventAfterSequenceByTurn,
    eventWatermarkByTurn,
    permissionAuditCursor,
    loadingMoreTasks,
    loadingMoreTurns,
    loadingEventTurnIds,
    loadingMorePermissionAudits,
    selectProject,
    invalidateProjectTasks,
    refreshTasks,
    loadMoreTasks,
    openTask,
    loadMoreTurns,
    loadMoreEvents,
    loadMorePermissionAudits,
    hasMoreEvents,
    resumeOpenedTask,
    previewTaskDeletion,
    deleteTask
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

function mergeEventsBySequence(
  current: PublicAgentEvent[],
  incoming: PublicAgentEvent[]
): PublicAgentEvent[] {
  return mergeUnique(current, incoming, (event) => String(event.sequence)).sort(
    (left, right) => left.sequence - right.sequence
  )
}
