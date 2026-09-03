import { computed, onBeforeUnmount, ref, toRaw, type ComputedRef, type Ref } from 'vue'
import type { PublicAgentEvent } from '../../../shared/agent-event'
import type { CommandExecutionEvidence } from '../../../shared/command'
import type { TaskExecutionSnapshot } from '../../../shared/task-execution'
import type { PublicAgentEventPage } from '../../../shared/task-ipc'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'
import { createTaskExecutionConsumer } from '../task-execution-consumer'
import {
  createTaskTimelineFacts,
  reduceTaskTimelineFacts,
  selectTaskTimeline,
  type AdmittedTurnFact,
  type TaskTimelineFacts,
  type TaskTimelineViewModel
} from '../task-timeline-reducer'

export interface TaskTimelineCoordinator {
  generation: number
  loading: boolean
  errorMessage: string
  eventAfterSequenceByTurn: Record<string, number | null>
  eventWatermarkByTurn: Record<string, number>
}

export interface UseTaskTimelineOptions {
  getSnapshot?: () => Promise<TaskExecutionSnapshot>
  subscribeExecution?: (listener: (snapshot: TaskExecutionSnapshot) => void) => () => void
  subscribeEvents?: (listener: (event: PublicAgentEvent) => void) => () => void
  /** App 已统一订阅事件和执行快照时关闭，避免重复订阅与竞态。 */
  manageSubscriptions?: boolean
}

export interface TaskTimelineController {
  factsByTaskId: Ref<Record<string, TaskTimelineFacts>>
  activeTaskId: Ref<string>
  activeTimeline: ComputedRef<TaskTimelineViewModel | null>
  executionSnapshot: Ref<TaskExecutionSnapshot>
  coordinators: Ref<Record<string, TaskTimelineCoordinator>>
  start(): Promise<void>
  openTask(taskId: string): Promise<boolean>
  /** Turn admission 成功后立即写入 Prompt，避免实时 Timeline 只能等历史回放开才看见用户指令。 */
  acceptAdmission(admission: AdmittedTurnFact): void
  acceptLiveEvent(event: PublicAgentEvent): void
  acceptExecutionSnapshot(snapshot: TaskExecutionSnapshot): void
  hydrateHistory(
    detail: import('../../../shared/task-history').TaskHistoryDetail,
    turns: readonly import('../../../shared/task-history').TurnHistoryRecord[],
    eventsByTurn: Record<string, readonly PublicAgentEvent[]>,
    audits: readonly import('../../../shared/task-history').PermissionAuditRecord[],
    commandEvidences?: readonly CommandExecutionEvidence[]
  ): void
  acceptCommandEvidence(
    taskId: string,
    evidences: readonly CommandExecutionEvidence[],
    flags?: { truncated?: true; persistIncomplete?: true }
  ): void
  refreshCommandEvidence(taskId: string): Promise<void>
  setActiveTask(taskId: string): void
  removeTask(taskId: string): void
  dispose(): void
}

/** 将响应式历史输入转为纯可序列化数据，避免 Vue Proxy 进入 Timeline reducer。 */
function cloneTimelineInput<T>(value: T): T {
  return structuredClone(toRaw(value))
}

/** 打开 Timeline 时自动读完当前 Turn 事件，沿用 IPC 单页上限并防止游标不前进死循环。 */
async function readAllEventPages(taskId: string, turnId: string): Promise<PublicAgentEventPage> {
  let afterSequence = 0
  let watermark = 0
  const items: PublicAgentEvent[] = []

  while (true) {
    const page = unwrapDesktopIpcResult(
      await window.task.listEvents(taskId, turnId, afterSequence, 200)
    )
    items.push(...page.items)
    watermark = Math.max(watermark, page.watermark)
    const nextAfterSequence = page.nextAfterSequence
    if (nextAfterSequence == null || nextAfterSequence <= afterSequence) {
      return { items, watermark }
    }
    afterSequence = nextAfterSequence
  }
}

function shouldRefreshCommandEvidence(event: PublicAgentEvent): boolean {
  if (event.kind === 'turn-complete') return true
  if (event.kind !== 'tool-call' && event.kind !== 'tool-update') return false
  return event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled'
}

/** 将历史查询、实时事件和执行快照编排到纯 Timeline facts；组件不直接访问 IPC。 */
export function useTaskTimeline(options: UseTaskTimelineOptions): TaskTimelineController {
  const factsByTaskId = ref<Record<string, TaskTimelineFacts>>({})
  const activeTaskId = ref('')
  const executionSnapshot = ref<TaskExecutionSnapshot>({
    executorEpoch: 'renderer-initial',
    executionRevision: 0,
    execution: null
  })
  const coordinators = ref<Record<string, TaskTimelineCoordinator>>({})
  let disposed = false
  let cleanupEvents: (() => void) | null = null
  let executionConsumer: ReturnType<typeof createTaskExecutionConsumer> | null = null
  let pendingEventsByTaskId: Record<string, PublicAgentEvent[]> = {}
  let pendingEventFlush = false

  const activeTimeline = computed(() => {
    const taskId = activeTaskId.value
    const facts = factsByTaskId.value[taskId]
    // Timeline selector 会复制审计和用量事实；先取 ref 的原始值，避免嵌套 Vue Proxy 再次触发 DataCloneError。
    return facts
      ? selectTaskTimeline(toRaw(facts), { executionSnapshot: toRaw(executionSnapshot.value) })
      : null
  })

  function ensureFacts(taskId: string): TaskTimelineFacts {
    return (factsByTaskId.value[taskId] ??= createTaskTimelineFacts(taskId))
  }

  function dispatch(taskId: string, action: Parameters<typeof reduceTaskTimelineFacts>[1]): void {
    if (disposed) return
    // ref 内存储的 facts 会变成 Vue Proxy，纯 reducer 只能接收可 structuredClone 的原始数据。
    const next = reduceTaskTimelineFacts(toRaw(ensureFacts(taskId)), action)
    factsByTaskId.value = { ...factsByTaskId.value, [taskId]: next }
  }

  /** 高频文本在同一微任务内合并；计划快照和终态必须立刻可见，避免 Inspector 像滞后刷新。 */
  function flushPendingEvents(): void {
    if (disposed) return
    pendingEventFlush = false
    const batches = pendingEventsByTaskId
    pendingEventsByTaskId = {}
    for (const [taskId, events] of Object.entries(batches)) {
      if (events.length) dispatch(taskId, { type: 'events/ingest-public', events })
    }
  }

  function acceptAdmission(admission: AdmittedTurnFact): void {
    if (disposed) return
    dispatch(admission.taskId, {
      type: 'turn/admitted',
      admission: cloneTimelineInput(admission)
    })
  }

  function acceptLiveEvent(event: PublicAgentEvent): void {
    if (disposed) return
    if (
      event.kind === 'turn-complete' ||
      event.kind === 'error' ||
      event.kind === 'plan' ||
      event.kind === 'tool-call' ||
      event.kind === 'tool-update'
    ) {
      flushPendingEvents()
      dispatch(event.taskId, { type: 'events/ingest-public', events: [event] })
      if (shouldRefreshCommandEvidence(event)) void refreshCommandEvidence(event.taskId)
      return
    }
    ;(pendingEventsByTaskId[event.taskId] ??= []).push(event)
    if (pendingEventFlush) return
    pendingEventFlush = true
    queueMicrotask(flushPendingEvents)
  }

  function acceptExecutionSnapshot(snapshot: TaskExecutionSnapshot): void {
    // 执行快照常从 Vue ref 流入，必须先 toRaw，否则 structuredClone 会抛 DataCloneError。
    if (!disposed) executionSnapshot.value = structuredClone(toRaw(snapshot))
  }

  function hydrateHistory(
    detail: import('../../../shared/task-history').TaskHistoryDetail,
    turns: readonly import('../../../shared/task-history').TurnHistoryRecord[],
    eventsByTurn: Record<string, readonly PublicAgentEvent[]>,
    audits: readonly import('../../../shared/task-history').PermissionAuditRecord[],
    commandEvidences: readonly CommandExecutionEvidence[] = []
  ): void {
    const historyDetail = cloneTimelineInput(detail)
    const historyTurns = cloneTimelineInput(turns)
    const historyEventsByTurn = cloneTimelineInput(eventsByTurn)
    const historyAudits = cloneTimelineInput(audits)

    dispatch(historyDetail.taskId, { type: 'task/upsert', task: historyDetail })
    dispatch(historyDetail.taskId, { type: 'turns/upsert', turns: historyTurns })
    dispatch(historyDetail.taskId, { type: 'permission-audits/merge', audits: historyAudits })
    for (const turn of historyTurns) {
      dispatch(historyDetail.taskId, {
        type: 'events/ingest-public',
        events: historyEventsByTurn[turn.turnId] ?? []
      })
    }
    if (commandEvidences.length) {
      acceptCommandEvidence(historyDetail.taskId, commandEvidences)
    }
    activeTaskId.value = historyDetail.taskId
  }

  function acceptCommandEvidence(
    taskId: string,
    evidences: readonly CommandExecutionEvidence[],
    flags: { truncated?: true; persistIncomplete?: true } = {}
  ): void {
    if (disposed || !taskId) return
    dispatch(taskId, {
      type: 'command-evidence/replace',
      evidences: cloneTimelineInput([...evidences]),
      ...(flags.truncated ? { truncated: true as const } : {}),
      ...(flags.persistIncomplete ? { persistIncomplete: true as const } : {})
    })
  }

  /** 只读拉取当前 Task 证据；失败不得拆掉已有 Timeline。truncated 必须进入 reducer。 */
  async function refreshCommandEvidence(taskId: string): Promise<void> {
    const list = typeof window === 'undefined' ? undefined : window.task?.listCommandEvidence
    if (disposed || !taskId || typeof list !== 'function') return
    try {
      const page = unwrapDesktopIpcResult(await list(taskId))
      if (disposed) return
      acceptCommandEvidence(taskId, page.items, {
        ...(page.truncated ? { truncated: true as const } : {}),
        ...(page.persistIncomplete ? { persistIncomplete: true as const } : {})
      })
    } catch {
      // 查询失败时保留已有 Timeline，不把证据通道错误提升成整页失败。
    }
  }

  function removeTask(taskId: string): void {
    const next = { ...factsByTaskId.value }
    delete next[taskId]
    factsByTaskId.value = next
    delete coordinators.value[taskId]
    if (activeTaskId.value === taskId) activeTaskId.value = ''
  }

  async function openTask(taskId: string): Promise<boolean> {
    const generation = (coordinators.value[taskId]?.generation ?? 0) + 1
    coordinators.value = {
      ...coordinators.value,
      [taskId]: {
        generation,
        loading: true,
        errorMessage: '',
        eventAfterSequenceByTurn: {},
        eventWatermarkByTurn: {}
      }
    }
    try {
      const [detail, turns, audits] = await Promise.all([
        window.task.get(taskId).then(unwrapDesktopIpcResult),
        window.task.listTurns(taskId, undefined, 20).then(unwrapDesktopIpcResult),
        window.task.listPermissionAudits(taskId, undefined, 50).then(unwrapDesktopIpcResult)
      ])
      const eventPages = await Promise.all(
        turns.items.map(
          async (turn) => [turn, await readAllEventPages(taskId, turn.turnId)] as const
        )
      )
      const current = coordinators.value[taskId]
      if (disposed || !current || current.generation !== generation) return false
      dispatch(taskId, { type: 'task/upsert', task: detail })
      dispatch(taskId, { type: 'turns/upsert', turns: turns.items })
      dispatch(taskId, { type: 'permission-audits/merge', audits: audits.items })
      const afterSequenceByTurn: Record<string, number | null> = {}
      const watermarkByTurn: Record<string, number> = {}
      for (const [turn, page] of eventPages) {
        dispatch(taskId, { type: 'events/ingest-public', events: page.items })
        afterSequenceByTurn[turn.turnId] = page.nextAfterSequence ?? null
        watermarkByTurn[turn.turnId] = page.watermark
      }
      await refreshCommandEvidence(taskId)
      coordinators.value = {
        ...coordinators.value,
        [taskId]: {
          ...current,
          loading: false,
          eventAfterSequenceByTurn: afterSequenceByTurn,
          eventWatermarkByTurn: watermarkByTurn
        }
      }
      activeTaskId.value = taskId
      return true
    } catch (error) {
      const current = coordinators.value[taskId]
      if (!current || current.generation !== generation) return false
      coordinators.value = {
        ...coordinators.value,
        [taskId]: {
          ...current,
          loading: false,
          errorMessage: error instanceof Error ? error.message : String(error)
        }
      }
      return false
    }
  }

  async function start(): Promise<void> {
    if (disposed || cleanupEvents || options.manageSubscriptions === false) return
    if (!options.subscribeEvents || !options.getSnapshot || !options.subscribeExecution) return
    cleanupEvents = options.subscribeEvents(acceptLiveEvent)
    executionConsumer = createTaskExecutionConsumer({
      getSnapshot: options.getSnapshot,
      subscribe: options.subscribeExecution,
      onSnapshot: acceptExecutionSnapshot
    })
    await executionConsumer.start()
  }

  function dispose(): void {
    disposed = true
    pendingEventsByTaskId = {}
    pendingEventFlush = false
    cleanupEvents?.()
    cleanupEvents = null
    executionConsumer?.dispose()
    executionConsumer = null
  }

  onBeforeUnmount(dispose)

  return {
    factsByTaskId,
    activeTaskId,
    activeTimeline,
    executionSnapshot,
    coordinators,
    start,
    openTask,
    acceptAdmission,
    acceptLiveEvent,
    acceptExecutionSnapshot,
    hydrateHistory,
    acceptCommandEvidence,
    refreshCommandEvidence,
    setActiveTask: (taskId) => {
      activeTaskId.value = taskId
    },
    removeTask,
    dispose
  }
}
