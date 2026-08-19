<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  PhCheckCircle as CheckCircle,
  PhCircleNotch as CircleNotch,
  PhRobot as Robot,
  PhShieldCheck as ShieldCheck,
  PhSidebarSimple as SidebarSimple,
  PhTerminalWindow as TerminalWindow,
  PhWarningCircle as WarningCircle
} from '@phosphor-icons/vue'
import type {
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentPlanEntry,
  AgentRuntimeStatus,
  AgentTaskRuntimeState
} from '../../shared/agent'
import type { PublicAgentEvent, PublicAgentToolEvent } from '../../shared/agent-event'
import type {
  ProviderConfigInput,
  ProviderConfigSummary,
  ProviderConnectionInput,
  ProviderModelOption,
  ProviderTestResult
} from '../../shared/provider'
import type {
  ConversationEntryState,
  DeletionPreview,
  PermissionAuditRecord
} from '../../shared/task-history'
import {
  createAgentEventGuard,
  createAgentMessageKey,
  createAgentToolKey
} from './agent-event-consumer'
import { unwrapDesktopIpcResult } from './desktop-ipc-result'
import PermissionPrompt from './components/PermissionPrompt.vue'
import ProviderOnboarding from './components/ProviderOnboarding.vue'
import ProjectSidebar from './components/ProjectSidebar.vue'
import TaskComposer from './components/TaskComposer.vue'
import TaskConversation from './components/TaskConversation.vue'
import TaskHeader from './components/TaskHeader.vue'
import { useRuntimeCapabilities } from './composables/useRuntimeCapabilities'
import { useTaskTimeline } from './composables/useTaskTimeline'
import { useTaskWorkbench } from './composables/useTaskWorkbench'
import {
  evaluateTaskComposerSend,
  isForeignExecutionBlockingSend,
  resolveCancelTurnRequest,
  resolveComposerAction,
  resolveStopButtonTitle,
  resolveTaskHeaderFacts,
  restoreComposerPromptAfterFailure
} from './task-composer-actions'
import { projectTaskHistory } from './task-history-projector'
import { createAndSelectTask } from './task-navigation'
import {
  clearRespondingPermission,
  clearPermissionQueueState,
  enqueuePermissionRequest,
  getNextPermissionExpiry,
  isPermissionResponsePending,
  removeExpiredPermissionRequests,
  removePermissionRequest
} from './permission-queue'
import { createProjectSelectionCoordinator } from './project-selection-coordinator'
import {
  createAsyncSingleFlight,
  isRuntimeConnectedToProject,
  shouldConnectProject
} from './runtime-session-actions'

const TERMINAL_EXECUTION_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

interface ChatMessage {
  id: string
  turnId?: string
  role: 'user' | 'assistant' | 'thought' | 'error'
  text: string
  streaming?: boolean
  /**
   * 仅挂在“本轮结果锚点”消息上的整轮总耗时。
   * 一条用户指令只保留一个总时长，不按中间思考/片段拆分计时。
   */
  turnDurationMs?: number
}

interface ToolActivity {
  id: string
  title: string
  status: string
}

/** P0-05 的 Renderer 内存 Task 视图；只保存展示状态，不持有 Runtime 私有 session。 */
interface TaskViewState {
  taskId: string
  projectId: string
  workspace: string
  title: string
  mode: 'live' | 'history'
  messages: ChatMessage[]
  planEntries: AgentPlanEntry[]
  toolActivities: ToolActivity[]
  thoughtExpandOverride: Record<string, boolean>
}

const status = ref<AgentRuntimeStatus>({
  runtimeId: 'grok',
  state: 'idle',
  message: '尚未连接 Grok Build'
})
const workbench = useTaskWorkbench()
const taskHistory = workbench.history
const taskTimeline = useTaskTimeline({ manageSubscriptions: false })
const executionSnapshot = workbench.executionSnapshot
/** 选中身份来自 workbench；模板可继续用 activeTaskId 别名减少改动。 */
const activeTaskId = workbench.selectedTaskId
const activeExecution = workbench.activeExecution
const providerSummary = ref<ProviderConfigSummary | null>(null)
const providerBootState = ref<'loading' | 'needs-provider' | 'ready'>('loading')
const showProviderSettings = ref(false)
const workspace = ref('')
type HistoryConfirmationKind = 'task-delete' | 'project-remove' | 'project-history-delete'
const historyConfirmation = ref<{
  kind: HistoryConfirmationKind
  targetId: string
  title: string
  preview?: DeletionPreview
} | null>(null)
const historyConfirmationPending = ref(false)
const conversationEntry = ref<ConversationEntryState | null>(null)
let conversationEnterGeneration = 0
let conversationEnterPromise: Promise<ConversationEntryState | null> | null = null
const prompt = ref('')
const taskComposer = ref<{ focus: () => void } | null>(null)
const promptSubmissionPending = ref(false)
const projectConnectionPending = ref(false)
const projectSelectionPending = ref(false)
/** 发送入口共享单飞门禁，并同步投影到 UI busy 状态。 */
const runPromptSubmission = createAsyncSingleFlight((pending) => {
  promptSubmissionPending.value = pending
})
/** Project 切换和手工连接共用单飞门禁，避免快速点击并发重建 Runtime。 */
const runProjectConnection = createAsyncSingleFlight((pending) => {
  projectConnectionPending.value = pending
})
/** Project 历史尚未提交时独立锁住旧 Task 入口；连接 Runtime 前会释放此门禁。 */
const projectSelection = createProjectSelectionCoordinator((pending) => {
  projectSelectionPending.value = pending
})
const permissionQueue = ref<AgentPermissionRequest[]>([])
const permission = computed(() => permissionQueue.value[0] ?? null)
const respondingPermission = ref<{
  approvalId: string
  taskId: string
  turnId: string
} | null>(null)
const permissionResponsePending = computed(() =>
  isPermissionResponsePending(permission.value, respondingPermission.value)
)
let permissionExpiryTimer: ReturnType<typeof setTimeout> | null = null
const showInspector = ref(true)
const taskViews = ref<Record<string, TaskViewState>>({})
const taskOrder = ref<string[]>([])
/** 以 workbench 的查看身份驱动 Timeline；保留后台 facts，但绝不将旧 Task 展示到新 Project。 */
watch(activeTaskId, (taskId) => taskTimeline.setActiveTask(taskId), { flush: 'sync' })
/** 尚未建立 Task 时只承接真实错误消息，不伪造 Runtime 欢迎回复。 */
const welcomeMessages = ref<ChatMessage[]>([])
const emptyPlanEntries = ref<AgentPlanEntry[]>([])
const emptyToolActivities = ref<ToolActivity[]>([])
const activeTaskView = computed(() => taskViews.value[activeTaskId.value] ?? null)
/** 审批标题按请求真实 taskId 解析，查看 B 时不能把后台 A 冒充成 B。 */
const permissionTaskTitle = computed(() => {
  const request = permission.value
  if (!request) return ''
  return (
    taskViews.value[request.taskId]?.title ??
    taskHistory.tasks.value.find((task) => task.taskId === request.taskId)?.title ??
    request.taskId
  )
})

const permissionAuditReasonLabels: Record<PermissionAuditRecord['reason'], string> = {
  'auto-allowed': '策略自动允许',
  'grant-reused': '复用当前 Task 授权',
  'user-allowed': '用户允许',
  'user-denied': '用户拒绝',
  cancelled: '请求已取消',
  expired: '审批已过期',
  'invalid-target': '目标无效',
  unsupported: '能力不支持',
  'internal-error': '内部执行失败'
}

/** 当前 Task 的消息、计划和工具状态通过计算属性切换，A/B 视图不会串台。 */
const messages = computed<ChatMessage[]>({
  get: () => activeTaskView.value?.messages ?? welcomeMessages.value,
  set: (value) => {
    const view = activeTaskView.value
    if (view) view.messages = value
    else welcomeMessages.value = value
  }
})
const planEntries = computed<AgentPlanEntry[]>({
  get: () => activeTaskView.value?.planEntries ?? emptyPlanEntries.value,
  set: (value) => {
    const view = activeTaskView.value
    if (view) view.planEntries = value
    else emptyPlanEntries.value = value
  }
})
const toolActivities = computed<ToolActivity[]>({
  get: () => activeTaskView.value?.toolActivities ?? emptyToolActivities.value,
  set: (value) => {
    const view = activeTaskView.value
    if (view) view.toolActivities = value
    else emptyToolActivities.value = value
  }
})
const activeSidebarTaskId = computed(() =>
  projectSelectionPending.value ? '' : activeTaskId.value
)

const cleanupListeners: Array<() => void> = []
const acceptAgentEvent = createAgentEventGuard()
/** 驱动整轮任务耗时的实时刷新。 */
const nowTick = ref(Date.now())
let durationTimer: ReturnType<typeof setInterval> | null = null
/** 当前这一轮用户指令的开始时间；一条指令只对应一个计时器。 */
const turnStartedAt = ref<number | null>(null)
/** 计时器绑定执行 Task，而不是当前查看 Task，切去历史 B 时不得把 A 的耗时挂到 B。 */
const turnTimingTaskId = ref<string | null>(null)
/** 当前这一轮结束时间；结束后冻结总耗时。 */
const turnEndedAt = ref<number | null>(null)
/** 当前把“整轮耗时”徽章挂在哪条消息上；运行中跟着最新输出走，结束后固定在最终回复。 */
const turnDurationAnchorId = ref<string | null>(null)
/** 本轮开始时的消息分界，结束时只在本轮消息里挑选耗时锚点。 */
const turnMessageStartIndex = ref(0)
/** 是否存在仍在流式输出的消息。 */
const hasStreamingMessage = computed(() => messages.value.some((item) => item.streaming))
/** 当前这一轮是否仍在计时（发送后到整轮结束前）。 */
const isTurnTiming = computed(
  () =>
    turnTimingTaskId.value === activeTaskId.value &&
    activeTaskView.value?.mode === 'live' &&
    turnStartedAt.value != null &&
    turnEndedAt.value == null
)
/** 启动/停止整轮耗时刷新定时器。 */
function syncDurationTimer(): void {
  if (isTurnTiming.value || hasStreamingMessage.value) {
    if (durationTimer) return
    durationTimer = setInterval(() => {
      nowTick.value = Date.now()
    }, 200)
    return
  }

  if (!durationTimer) return
  clearInterval(durationTimer)
  durationTimer = null
}

/** 将仍在流式输出的消息统一收尾。 */
function finalizeStreamingMessages(): void {
  for (const message of messages.value) {
    if (!message.streaming) continue
    message.streaming = false
  }
}

/**
 * 结束当前这一轮计时，并把唯一的总耗时徽章沉淀到最终回复上。
 * 优先挂在最后一条助手消息；没有则挂在本轮最后一条非用户消息。
 */
function completeCurrentTurn(taskId = activeTaskId.value): void {
  if (turnTimingTaskId.value !== taskId || turnStartedAt.value == null) return
  if (activeTaskId.value !== taskId) {
    // 后台 Task 收束时只清理它自己的计时身份，当前查看 Task 的消息保持完全不动。
    turnTimingTaskId.value = null
    turnStartedAt.value = null
    turnEndedAt.value = null
    turnDurationAnchorId.value = null
    syncDurationTimer()
    return
  }

  const endedAt = Date.now()
  turnEndedAt.value = endedAt
  finalizeStreamingMessages()

  const durationMs = Math.max(0, endedAt - turnStartedAt.value)
  // 只在本轮新增消息里找锚点，避免误挂到上一轮回复。
  const turnMessages = messages.value.slice(turnMessageStartIndex.value)
  const anchor =
    [...turnMessages].reverse().find((item) => item.role === 'assistant') ??
    [...turnMessages].reverse().find((item) => item.role === 'thought') ??
    [...turnMessages].reverse().find((item) => item.role !== 'user')

  if (anchor) {
    // 清掉本轮其他消息上的整轮耗时，保证一条指令永远只有一个总时长。
    for (const message of turnMessages) {
      if (message.id !== anchor.id && message.turnDurationMs != null) {
        delete message.turnDurationMs
      }
    }
    anchor.turnDurationMs = durationMs
    turnDurationAnchorId.value = anchor.id
  }

  // 计时状态回到空闲，后续新指令重新开始。
  turnTimingTaskId.value = null
  turnStartedAt.value = null
  turnEndedAt.value = null
  turnMessageStartIndex.value = messages.value.length
  syncDurationTimer()
}

/** 开始新一轮用户指令的计时。 */
function beginCurrentTurn(taskId = activeTaskId.value): void {
  const now = Date.now()
  turnTimingTaskId.value = taskId
  turnStartedAt.value = now
  turnEndedAt.value = null
  turnDurationAnchorId.value = null
  // 记录分界：本轮耗时锚点只会落在此索引之后的消息上。
  turnMessageStartIndex.value = messages.value.length
  nowTick.value = now
  syncDurationTimer()
}

const isConnected = computed(() =>
  isRuntimeConnectedToProject(status.value, workbench.selectedProject.value?.canonicalRoot ?? '')
)
const isBusy = computed(
  () =>
    Boolean(activeExecution.value) ||
    status.value.state === 'busy' ||
    status.value.state === 'connecting' ||
    isTurnTiming.value ||
    promptSubmissionPending.value ||
    projectConnectionPending.value
)
/** 只约束 Renderer 交互，不参与 Runtime 连接判断，避免门禁反向阻止目标 Project 连接。 */
const projectInteractionBlocked = computed(() => isBusy.value || projectSelectionPending.value)
/** 历史导航不受后台 execution 影响，只在 Project 列表切换事务自身未完成时禁用。 */
const historyNavigationBlocked = computed(() => projectSelectionPending.value)
const { resolveCapability, isAvailable } = useRuntimeCapabilities(status)
const promptCapability = computed(() => resolveCapability('session.prompt.text', '发送文本 Prompt'))
const planCapability = computed(() => resolveCapability('event.plan', '展示执行计划'))
const toolCapability = computed(() => resolveCapability('event.tool', '展示工具活动'))
const createSessionCapability = computed(() => resolveCapability('session.create', '创建新对话'))
const connectCapability = computed(() => resolveCapability('runtime.connect', '连接 Runtime'))
const promptCapabilityMessage = computed(
  () => promptCapability.value.reason ?? promptCapability.value.notice
)
const activeProjectExecutable = computed(
  () =>
    workbench.selectedProject.value?.status === 'active' &&
    workbench.selectedProject.value.availability.state === 'available'
)
const activeProjectExecutionReason = computed(() => {
  const project = workbench.selectedProject.value
  if (!project) return '请先选择 Project。'
  if (project.status !== 'active') return '该 Project 已从列表移除，仅保留历史。'
  return project.availability.state === 'available' ? '' : project.availability.message
})
const runningTaskTitle = computed(() => {
  const execution = activeExecution.value
  if (!execution) return ''
  return (
    taskViews.value[execution.taskId]?.title ||
    taskHistory.tasks.value.find((task) => task.taskId === execution.taskId)?.title ||
    ''
  )
})
const composerSend = computed(() =>
  evaluateTaskComposerSend({
    prompt: prompt.value,
    selectedTaskId: activeTaskId.value,
    activeExecution: activeExecution.value,
    restore: conversationEntry.value?.restore,
    restoreReason: conversationEntry.value?.reason,
    providerConfigured: Boolean(providerSummary.value?.configured),
    projectSelectionPending: projectSelectionPending.value,
    turnTiming: isTurnTiming.value,
    promptSubmissionPending: promptSubmissionPending.value,
    promptCapabilityAvailable: promptCapability.value.available,
    promptCapabilityMessage: promptCapabilityMessage.value,
    runtimeConnected: isConnected.value,
    projectExecutable: activeProjectExecutable.value,
    projectExecutionReason: activeProjectExecutionReason.value
  })
)
const canSend = computed(() => composerSend.value.canSend)
const composerDisabledMessage = computed(() => composerSend.value.reason)
const composerAction = computed(() => resolveComposerAction(activeExecution.value))
const stopButtonTitle = computed(() =>
  resolveStopButtonTitle(activeExecution.value, runningTaskTitle.value)
)
const localErrorMessages = computed(() =>
  messages.value
    .filter((item) => item.role === 'error')
    .map((item) => item.text)
    .slice(-3)
)
const composerTextareaDisabled = computed(
  () =>
    projectSelectionPending.value ||
    conversationEntry.value?.restore === 'unavailable' ||
    !promptCapability.value.available ||
    !providerSummary.value?.configured
)
const planEmptyMessage = computed(
  () =>
    planCapability.value.reason ??
    planCapability.value.notice ??
    'Runtime 返回执行计划后会显示在这里。'
)
const toolEmptyMessage = computed(
  () =>
    toolCapability.value.reason ??
    toolCapability.value.notice ??
    'Runtime 返回工具活动后会显示在这里。'
)
const newChatDisabled = computed(
  () =>
    status.value.state !== 'ready' ||
    projectInteractionBlocked.value ||
    !activeProjectExecutable.value ||
    !providerSummary.value?.configured ||
    !isAvailable('runtime.connect') ||
    !isAvailable('session.create')
)
const newChatDisabledReason = computed(() => {
  if (projectSelectionPending.value) return '正在切换 Project，暂时不能创建新对话。'
  if (isBusy.value) return 'Runtime 正在执行或连接中，暂时不能创建新对话。'
  if (!providerSummary.value?.configured) return '请先配置 Provider。'
  if (!activeProjectExecutable.value) return activeProjectExecutionReason.value
  if (status.value.state !== 'ready') return '请先连接 Runtime，再创建新对话。'
  return connectCapability.value.reason ?? createSessionCapability.value.reason ?? ''
})
const activeProjectId = computed(() => workbench.selectedProjectId.value)
const currentModel = computed<ProviderModelOption | null>(() => {
  const summary = providerSummary.value
  if (!summary?.modelId) return null
  return {
    modelId: summary.modelId,
    ...(summary.modelDisplayName ? { displayName: summary.modelDisplayName } : {})
  }
})
const showProviderScreen = computed(
  () =>
    showProviderSettings.value ||
    (providerBootState.value !== 'ready' && workbench.projects.value.length === 0)
)
const workbenchLoadMessage = computed(() => {
  if (workbench.projectLoadState.value.status === 'error') {
    return workbench.projectLoadState.value.errorMessage || 'Project 列表加载失败。'
  }
  if (workbench.taskListLoadState.value.status === 'error') {
    return workbench.taskListLoadState.value.errorMessage || 'Task 列表加载失败。'
  }
  if (workbench.taskDetailLoadState.value.status === 'error') {
    return workbench.taskDetailLoadState.value.errorMessage || 'Task 详情加载失败。'
  }
  return ''
})
const taskHeaderFacts = computed(() => {
  const detail = taskHistory.openedTask.value
  const lastTurn = taskTimeline.activeTimeline.value?.turns.at(-1)
  return resolveTaskHeaderFacts({
    selectedTaskId: activeTaskId.value,
    selectedTitle: activeTaskView.value?.title ?? detail?.title,
    selectedProjectName: workbench.selectedProject.value?.displayName,
    selectedRuntimeId: detail?.runtimeId ?? 'grok',
    selectedState: detail?.state,
    createdAt: detail?.createdAt,
    selectedModel: lastTurn?.model ?? currentModel.value,
    activeExecution: activeExecution.value,
    runningTaskTitle: runningTaskTitle.value,
    restore: conversationEntry.value?.restore,
    restoreReason: conversationEntry.value?.reason,
    runtimeState: status.value.state,
    runtimeMessage: status.value.message,
    workbenchLoadMessage: workbenchLoadMessage.value
  })
})
const workbenchLoadError = computed(
  () =>
    workbench.projectLoadState.value.status === 'error' ||
    workbench.taskListLoadState.value.status === 'error' ||
    workbench.taskDetailLoadState.value.status === 'error'
)

// 查看身份变化只切换计时可见性；execution 终态按其真实 taskId 收束，不能误写当前历史 B。
watch([hasStreamingMessage, isTurnTiming, activeTaskId, () => status.value.state], () => {
  const execution = activeExecution.value
  if (
    status.value.state === 'busy' &&
    execution?.taskId === activeTaskId.value &&
    activeTaskView.value?.mode === 'live' &&
    turnStartedAt.value == null
  ) {
    beginCurrentTurn(execution.taskId)
  }
  syncDurationTimer()
})

watch(executionSnapshot, (snapshot) => {
  taskTimeline.acceptExecutionSnapshot(snapshot)
})

watch(
  () => executionSnapshot.value.execution,
  (execution) => {
    if (!execution) return
    if (TERMINAL_EXECUTION_STATES.has(execution.state)) {
      completeCurrentTurn(execution.taskId)
    } else if (
      execution.taskId === activeTaskId.value &&
      activeTaskView.value?.mode === 'live' &&
      turnStartedAt.value == null
    ) {
      beginCurrentTurn(execution.taskId)
    }
    syncDurationTimer()
  }
)

onMounted(async () => {
  cleanupListeners.push(
    window.agent.onStatus((nextStatus) => {
      status.value = nextStatus
      syncWorkspaceDisplay(nextStatus.workspace)
      if (nextStatus.state === 'idle' || nextStatus.state === 'error') clearPermissionQueue()
    }),
    window.agent.onEvent(handleAgentEvent),
    window.agent.onPermission((request) => {
      // 查看身份不参与权限决策；所有未过期审批都保留到用户显式处理或 Broker 收束。
      enqueuePermission(request)
    }),
    window.agent.onPermissionCancelled((request) => {
      removePermission(request)
      respondingPermission.value = clearRespondingPermission(respondingPermission.value, request)
    })
  )

  try {
    providerSummary.value = await window.provider.getSummary()
    providerBootState.value = providerSummary.value.configured ? 'ready' : 'needs-provider'
  } catch {
    providerBootState.value = 'needs-provider'
  }

  try {
    await workbench.initialize()
    workspace.value = workbench.selectedProject.value?.canonicalRoot ?? workspace.value
    const initialTask = taskHistory.tasks.value[0]
    if (initialTask && !activeTaskId.value) {
      await selectTask(initialTask.taskId)
    }
  } catch (error) {
    appendMessage('error', error instanceof Error ? error.message : String(error))
  }

  try {
    await workbench.start()
    await taskTimeline.start()
    taskTimeline.acceptExecutionSnapshot(executionSnapshot.value)
    status.value = unwrapDesktopIpcResult(await window.agent.getStatus())
    syncWorkspaceDisplay(status.value.workspace)
    if (activeProjectId.value) await ensureProjectConnected(activeProjectId.value)
  } catch (error) {
    appendMessage('error', error instanceof Error ? error.message : String(error))
  }
})

onBeforeUnmount(() => {
  workbench.dispose()
  taskTimeline.dispose()
  cleanupListeners.forEach((cleanup) => cleanup())
  if (permissionExpiryTimer) {
    clearTimeout(permissionExpiryTimer)
    permissionExpiryTimer = null
  }
  if (durationTimer) {
    clearInterval(durationTimer)
    durationTimer = null
  }
})

/** 从用户首条消息生成侧栏最近项标题，超长时截断保持列表清爽。 */
function deriveSessionTitle(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return '新对话'
  return compact.length > 28 ? `${compact.slice(0, 28)}…` : compact
}

/** 新对话先 createTask，再走同一条 selectTask / enterTask，不再另开只读入口。 */
async function startNewChat(): Promise<void> {
  if (newChatDisabled.value || projectSelectionPending.value || !activeProjectId.value) return

  try {
    await createAndSelectTask({
      projectId: activeProjectId.value,
      createTask: async (projectId) =>
        unwrapDesktopIpcResult(await window.agent.createTask(projectId)),
      selectTask,
      refreshTasks: () => taskHistory.refreshTasks()
    })
  } catch (error) {
    appendMessage('error', error instanceof Error ? error.message : String(error))
  }
}

/** 建立或切换本地 Task 视图；每个 Task 持有独立消息、计划与工具活动数组。 */
function activateTaskView(task: AgentTaskRuntimeState, mode: 'live' | 'history' = 'live'): void {
  const existing = taskViews.value[task.taskId]
  if (!existing) {
    taskViews.value[task.taskId] = {
      taskId: task.taskId,
      projectId: activeProjectId.value,
      workspace: task.workspace,
      title: '新对话',
      mode,
      messages: [],
      planEntries: [],
      toolActivities: [],
      thoughtExpandOverride: {}
    }
  } else {
    // 历史恢复成功后保留已有投影，只切换为主进程确认过的 live 执行状态。
    existing.projectId = activeProjectId.value
    existing.workspace = task.workspace
    existing.mode = mode
  }

  workbench.selectedTaskId.value = task.taskId
  conversationEntry.value = {
    taskId: task.taskId,
    historyReady: true,
    restore: 'ready',
    verification: 'unverified'
  }
  taskOrder.value = [task.taskId, ...taskOrder.value.filter((id) => id !== task.taskId)].slice(
    0,
    12
  )
  reconcilePermissionQueue(task.taskId, activeProjectId.value)
}

/** 首次发送时懒创建 Task；后续 Turn 始终复用当前稳定 taskId。 */
async function ensureActiveTask(): Promise<string> {
  if (projectSelectionPending.value) throw new Error('正在切换 Project，请稍候。')
  const current = activeTaskView.value
  if (current?.projectId === activeProjectId.value && current.taskId) return current.taskId

  const task = unwrapDesktopIpcResult(await window.agent.createTask(activeProjectId.value))
  activateTaskView(task)
  await taskHistory.refreshTasks()
  return task.taskId
}

/** 点选即进入对话；选中身份由 workbench revision 保护，Runtime 恢复仍留在 App。 */
async function selectTask(taskId: string): Promise<void> {
  if (!taskId || projectSelectionPending.value) return
  const enterGeneration = ++conversationEnterGeneration
  conversationEnterPromise = null
  conversationEntry.value = {
    taskId,
    historyReady: false,
    restore: 'connecting',
    verification: 'unverified',
    reason: '正在接回上次上下文…'
  }

  try {
    await workbench.selectTask(taskId)
    if (activeTaskId.value !== taskId) return
    const detail = taskHistory.openedTask.value
    if (!detail || detail.taskId !== taskId) return
    const projection = projectTaskHistory(
      taskHistory.openedTurns.value,
      taskHistory.eventsByTurn.value
    )
    const mode = activeExecution.value?.taskId === taskId ? 'live' : 'history'
    taskViews.value[taskId] = {
      taskId,
      projectId: detail.projectId,
      workspace: workspace.value,
      title: detail.title,
      mode,
      messages: projection.messages,
      planEntries: projection.planEntries,
      toolActivities: projection.toolActivities,
      thoughtExpandOverride: {}
    }
    taskTimeline.hydrateHistory(
      detail,
      taskHistory.openedTurns.value,
      taskHistory.eventsByTurn.value,
      taskHistory.permissionAudits.value
    )
    reconcilePermissionQueue(taskId, detail.projectId)
    conversationEntry.value = {
      taskId,
      historyReady: true,
      restore: 'connecting',
      verification: 'unverified',
      reason: '正在接回上次上下文…'
    }
    if (activeTaskId.value !== taskId) return
    const pendingEnter = window.agent
      .enterTask(taskId)
      .then((result) => unwrapDesktopIpcResult(result))
    conversationEnterPromise = pendingEnter
    const entry = await pendingEnter
    if (enterGeneration !== conversationEnterGeneration || activeTaskId.value !== taskId) return
    conversationEntry.value = entry
  } catch (error) {
    if (activeTaskId.value !== taskId) return
    if (enterGeneration === conversationEnterGeneration) {
      conversationEntry.value = {
        taskId,
        historyReady: Boolean(taskHistory.openedTask.value),
        restore: 'degraded',
        verification: 'unverified',
        reason: error instanceof Error ? error.message : String(error)
      }
    }
    appendMessage('error', error instanceof Error ? error.message : String(error))
  }
}

/** Project 选择只切换本地历史身份；点进 Task 后由 enterTask 自动接回 Runtime。 */
async function selectProject(projectId: string): Promise<void> {
  if (!projectId || projectSelectionPending.value || projectId === activeProjectId.value) return
  conversationEnterGeneration += 1
  conversationEnterPromise = null
  conversationEntry.value = null
  const selection = projectSelection.begin()
  reconcilePermissionQueue('', projectId)
  try {
    await workbench.selectProject(projectId)
    if (!projectSelection.isCurrent(selection) || activeProjectId.value !== projectId) {
      return
    }
    workspace.value = workbench.selectedProject.value?.canonicalRoot ?? ''
  } catch (error) {
    if (!projectSelection.isCurrent(selection) || activeProjectId.value !== projectId) return
    projectSelection.commit(selection, () => {
      appendMessage('error', error instanceof Error ? error.message : String(error))
    })
  } finally {
    projectSelection.finish(selection)
  }
}

function syncWorkspaceDisplay(runtimeWorkspace?: string): void {
  workspace.value = workbench.selectedProject.value?.canonicalRoot ?? runtimeWorkspace ?? ''
}

/** 局部 loadState 失败后从当前错误边界重试，不把失败伪装成空列表成功。 */
function retryWorkbenchLoad(): void {
  if (workbench.projectLoadState.value.status === 'error') {
    void workbench.retryProjects()
    return
  }
  if (workbench.taskListLoadState.value.status === 'error') {
    void workbench.retryTaskList()
    return
  }
  if (workbench.taskDetailLoadState.value.status === 'error') {
    void workbench.retryTaskDetail().catch((error) => {
      appendMessage('error', error instanceof Error ? error.message : String(error))
    })
  }
}

async function chooseWorkspace(): Promise<void> {
  if (isBusy.value || projectSelectionPending.value) return
  conversationEnterGeneration += 1
  conversationEnterPromise = null
  conversationEntry.value = null
  const selection = projectSelection.begin()
  const previousProjectId = activeProjectId.value
  const previousTaskId = activeTaskId.value
  activeTaskId.value = ''
  try {
    const selected = await workbench.registry.chooseProject(() =>
      projectSelection.isCurrent(selection)
    )
    if (!selected) {
      projectSelection.commit(selection, () => {
        if (activeProjectId.value === previousProjectId) activeTaskId.value = previousTaskId
      })
      return
    }
    if (!projectSelection.isCurrent(selection) || activeProjectId.value !== selected.projectId) {
      return
    }
    await workbench.selectProject(selected.projectId)
    if (!projectSelection.isCurrent(selection) || activeProjectId.value !== selected.projectId) {
      return
    }
    workspace.value = selected.canonicalRoot
    activeTaskId.value = ''
    reconcilePermissionQueue('', selected.projectId)
    projectSelection.finish(selection)
    await ensureProjectConnected(selected.projectId, () => projectSelection.isCurrent(selection))
  } catch (error) {
    if (!projectSelection.isCurrent(selection)) return
    projectSelection.commit(selection, () => {
      if (activeProjectId.value === previousProjectId) activeTaskId.value = previousTaskId
      else reconcilePermissionQueue('', activeProjectId.value)
      appendMessage('error', error instanceof Error ? error.message : String(error))
    })
  } finally {
    projectSelection.finish(selection)
  }
}

function listProviderModels(input: ProviderConnectionInput): Promise<ProviderTestResult> {
  return window.provider.listModels(input)
}

function loadSavedModels(): Promise<ProviderTestResult> {
  return window.provider.listModels()
}

function saveProvider(input: ProviderConfigInput): Promise<ProviderConfigSummary> {
  return window.provider.save(input)
}

function handleProviderSaved(summary: ProviderConfigSummary): void {
  providerSummary.value = summary
  providerBootState.value = summary.configured ? 'ready' : 'needs-provider'
  showProviderSettings.value = false
}

async function selectProviderModel(model: ProviderModelOption): Promise<ProviderConfigSummary> {
  return window.provider.selectModel(model)
}

function handleModelChanged(summary: ProviderConfigSummary): void {
  providerSummary.value = summary
}

function handleModelError(message: string): void {
  appendMessage('error', message)
}

function openProviderSettings(): void {
  showProviderSettings.value = true
}

function closeProviderSettings(): void {
  if (providerSummary.value?.configured) showProviderSettings.value = false
}

async function clearProvider(): Promise<void> {
  conversationEnterGeneration += 1
  conversationEnterPromise = null
  conversationEntry.value = null
  projectSelection.invalidate()
  providerSummary.value = await window.provider.clear()
  providerBootState.value = 'needs-provider'
  showProviderSettings.value = false
  syncWorkspaceDisplay()
  activeTaskId.value = ''
  reconcilePermissionQueue('', '')
}

/**
 * 确保目标 Project 的 Runtime 已连接。
 * 连接失败只展示有限错误，不清空 Project/Task 历史，也不隐式恢复历史 session。
 */
async function ensureProjectConnected(
  projectId: string,
  isCurrent: () => boolean = () => true
): Promise<boolean> {
  const project = workbench.projects.value.find((item) => item.projectId === projectId)
  if (!project) return false

  const executable = project.status === 'active' && project.availability.state === 'available'
  if (
    !shouldConnectProject(
      status.value,
      project.canonicalRoot,
      Boolean(providerSummary.value?.configured),
      executable,
      isBusy.value
    )
  ) {
    return status.value.state === 'ready' && status.value.workspace === project.canonicalRoot
  }

  let connected = false
  await runProjectConnection(async () => {
    try {
      const result = await window.agent.connect(projectId)
      if (!isCurrent()) return
      unwrapDesktopIpcResult(result)
      connected = true
    } catch (error) {
      if (!isCurrent()) return
      appendMessage('error', error instanceof Error ? error.message : String(error))
    }
  })
  return connected
}

/** 发送只针对当前选中 Task；单飞门禁避免重复提交双 Turn。 */
async function sendPrompt(): Promise<void> {
  const text = prompt.value.trim()
  if (!text || !canSend.value) return

  await runPromptSubmission(async () => {
    let turnStarted = false
    let submittedTaskId = ''

    try {
      const taskId = await ensureActiveTask()
      submittedTaskId = taskId
      if (conversationEnterPromise && conversationEntry.value?.taskId === taskId) {
        await conversationEnterPromise.catch(() => undefined)
      }
      if (isForeignExecutionBlockingSend(activeExecution.value, taskId)) {
        throw new Error('先停掉当前任务。')
      }
      prompt.value = ''
      // 一条用户指令只开一个总计时，从发送当下就开始。
      beginCurrentTurn(taskId)
      turnStarted = true

      const current = taskViews.value[taskId]
      if (current && (current.title === '新对话' || current.title.startsWith('新对话'))) {
        current.title = deriveSessionTitle(text)
        taskOrder.value = [taskId, ...taskOrder.value.filter((id) => id !== taskId)]
      }

      appendMessage('user', text)
      await nextTick()
      taskComposer.value?.focus()
      const admitted = unwrapDesktopIpcResult(await window.agent.startTurn(taskId, text))
      // admission 也必须经过 epoch/revision watermark，不能覆盖已经先到的较新 Push。
      workbench.acceptExecutionSnapshot(admitted)
      // 实时 Timeline 只靠 AgentEvent 看不到用户 Prompt；admission 成功后立刻写入同一投影。
      const execution = admitted.execution
      if (execution) {
        taskTimeline.acceptAdmission({
          taskId: execution.taskId,
          turnId: execution.turnId,
          executionId: execution.executionId,
          promptDisplayText: text,
          model: execution.model,
          acceptedAt: execution.acceptedAt
        })
      }
      await taskHistory.refreshTasks()
      if (
        conversationEntry.value?.taskId === taskId &&
        conversationEntry.value.restore === 'degraded'
      ) {
        conversationEntry.value = {
          ...conversationEntry.value,
          method: 'new-session',
          reason: '已用新上下文接着聊。'
        }
      }
    } catch (error) {
      // 只收束本次已经启动的 Turn，创建 Task 失败不能误结束其他计时。
      if (turnStarted) completeCurrentTurn(submittedTaskId)
      prompt.value = restoreComposerPromptAfterFailure(prompt.value, text)
      appendMessage('error', error instanceof Error ? error.message : String(error))
      await taskHistory.refreshTasks().catch(() => undefined)
    }
  })
}

async function cancelTurn(): Promise<void> {
  // 停止只认 activeExecution，即使当前选中的是另一个 Task。
  const request = resolveCancelTurnRequest(activeExecution.value, activeTaskId.value)
  if (!request) return

  try {
    unwrapDesktopIpcResult(await window.agent.cancelTurn(request))
    // 接受取消只表示请求已发出；等待真实 turn-complete 再收束计时与流式状态。
  } catch (error) {
    appendMessage('error', error instanceof Error ? error.message : String(error))
  }
}

async function respondPermission(decision: AgentPermissionDecision): Promise<void> {
  const request = permission.value
  if (!request || isPermissionResponsePending(request, respondingPermission.value)) return
  const identity = {
    approvalId: request.approvalId,
    taskId: request.taskId,
    turnId: request.turnId
  }
  respondingPermission.value = identity
  try {
    unwrapDesktopIpcResult(
      await window.agent.respondPermission({
        approvalId: request.approvalId,
        taskId: request.taskId,
        turnId: request.turnId,
        decision
      })
    )
    removePermission(identity)
  } catch (error) {
    appendMessage('error', error instanceof Error ? error.message : String(error))
  } finally {
    respondingPermission.value = clearRespondingPermission(respondingPermission.value, identity)
  }
}

/** 审批按 arrival 顺序展示并按三元组身份去重，防止并发请求互相覆盖。 */
function enqueuePermission(request: AgentPermissionRequest): void {
  permissionQueue.value = enqueuePermissionRequest(permissionQueue.value, request)
  schedulePermissionExpiry()
}

function removePermission(identity: { approvalId: string; taskId: string; turnId: string }): void {
  permissionQueue.value = removePermissionRequest(permissionQueue.value, identity)
  schedulePermissionExpiry()
}

/** Runtime 断开或异常后立即清空 Renderer 投影，主进程 Broker 负责真实请求的最终收束。 */
function clearPermissionQueue(): void {
  const cleared = clearPermissionQueueState()
  permissionQueue.value = cleared.queue
  respondingPermission.value = cleared.respondingPermission
  schedulePermissionExpiry()
}

/** Task/Project 身份变化只改变当前展示，不把后台审批解释为用户拒绝。 */
function reconcilePermissionQueue(taskId: string, projectId: string): void {
  void taskId
  void projectId
  permissionQueue.value = removeExpiredPermissionRequests(permissionQueue.value)
  schedulePermissionExpiry()
}

function schedulePermissionExpiry(): void {
  if (permissionExpiryTimer) clearTimeout(permissionExpiryTimer)
  permissionExpiryTimer = null
  const nextExpiry = getNextPermissionExpiry(permissionQueue.value)
  if (nextExpiry == null) return
  permissionExpiryTimer = setTimeout(
    () => {
      const now = Date.now()
      permissionQueue.value = removeExpiredPermissionRequests(permissionQueue.value, now)
      schedulePermissionExpiry()
    },
    Math.max(0, nextExpiry - Date.now())
  )
}

function permissionAuditScopeLabel(scope: PermissionAuditRecord['scope']): string {
  if (scope === 'task') return '当前 Task'
  if (scope === 'once') return '仅本次'
  return '未授予范围'
}

function permissionAuditInitiatorLabel(audit: PermissionAuditRecord): string {
  if (audit.initiator === 'runtime') {
    if (audit.runtimeId === 'grok') return 'Grok Build'
    if (audit.runtimeId === 'codex') return 'Codex'
    return 'Agent Runtime'
  }
  const labels: Record<NonNullable<PermissionAuditRecord['appService']>, string> = {
    'command-runner': 'Command Runner',
    git: 'Git',
    worktree: 'Worktree',
    other: 'Agent Studio'
  }
  return audit.appService ? labels[audit.appService] : 'Agent Studio'
}

function handleAgentEvent(event: PublicAgentEvent): void {
  if (!acceptAgentEvent(event)) return
  taskTimeline.acceptLiveEvent(event)
  if (event.taskId !== activeTaskId.value) return

  if (event.kind === 'agent-message' && event.text) {
    appendStreamChunk('assistant', event.text, createAgentMessageKey(event))
  } else if (event.kind === 'agent-thought' && event.text) {
    appendStreamChunk('thought', event.text, createAgentMessageKey(event))
  } else if (event.kind === 'tool-call' || event.kind === 'tool-update') {
    upsertToolActivity(event)
  } else if (event.kind === 'plan') {
    planEntries.value = event.entries
  } else if (event.kind === 'turn-complete') {
    permissionQueue.value = permissionQueue.value.filter(
      (item) => item.taskId !== event.taskId || item.turnId !== event.turnId
    )
    schedulePermissionExpiry()
    // 整轮完成：只沉淀一个总耗时，不给中间片段分别计时。
    completeCurrentTurn(event.taskId)
    void taskHistory.refreshTasks()
  } else if (event.kind === 'error') {
    completeCurrentTurn(event.taskId)
    appendMessage('error', event.message)
  }
}

function refreshOpenedHistoryProjection(): void {
  const detail = taskHistory.openedTask.value
  if (!detail) return
  const taskId = detail.taskId
  const view = taskViews.value[taskId]
  if (!view || view.mode !== 'history') return
  const projection = projectTaskHistory(
    taskHistory.openedTurns.value,
    taskHistory.eventsByTurn.value
  )
  view.messages = projection.messages
  view.planEntries = projection.planEntries
  view.toolActivities = projection.toolActivities
  // 历史分页会更新事件集合；同步再次水合，避免 Timeline 仍停在首次打开时的首屏事实。
  taskTimeline.hydrateHistory(
    detail,
    taskHistory.openedTurns.value,
    taskHistory.eventsByTurn.value,
    taskHistory.permissionAudits.value
  )
}

async function loadMoreHistoryTurns(): Promise<void> {
  await taskHistory.loadMoreTurns()
  refreshOpenedHistoryProjection()
}

async function loadMoreHistoryEvents(turnId: string): Promise<void> {
  await taskHistory.loadMoreEvents(turnId)
  refreshOpenedHistoryProjection()
}

async function renameOpenedTask(taskId: string, title: string): Promise<void> {
  try {
    await taskHistory.renameTask(taskId, title)
    const view = taskViews.value[taskId]
    if (view) view.title = title
  } catch (error) {
    appendMessage('error', error instanceof Error ? error.message : String(error))
  }
}

async function archiveOpenedTask(taskId: string): Promise<void> {
  try {
    await taskHistory.archiveTask(taskId)
    delete taskViews.value[taskId]
    taskOrder.value = taskOrder.value.filter((id) => id !== taskId)
    if (activeTaskId.value === taskId) {
      activeTaskId.value = ''
      conversationEntry.value = null
      reconcilePermissionQueue('', activeProjectId.value)
    }
  } catch (error) {
    appendMessage('error', error instanceof Error ? error.message : String(error))
  }
}

async function requestTaskDeletion(taskId: string): Promise<void> {
  const task = taskHistory.tasks.value.find((item) => item.taskId === taskId)
  if (!task) return
  const preview = await taskHistory.previewTaskDeletion(taskId)
  historyConfirmation.value = { kind: 'task-delete', targetId: taskId, title: task.title, preview }
}

function requestProjectRemoval(projectId: string): void {
  const project = workbench.projects.value.find((item) => item.projectId === projectId)
  if (!project) return
  historyConfirmation.value = {
    kind: 'project-remove',
    targetId: projectId,
    title: project.displayName
  }
}

async function requestProjectHistoryDeletion(projectId: string): Promise<void> {
  const project = workbench.projects.value.find((item) => item.projectId === projectId)
  if (!project) return
  const preview = await workbench.registry.previewProjectDeletion(projectId)
  historyConfirmation.value = {
    kind: 'project-history-delete',
    targetId: projectId,
    title: project.displayName,
    preview
  }
}

async function confirmHistoryAction(): Promise<void> {
  const confirmation = historyConfirmation.value
  if (!confirmation || historyConfirmationPending.value) return
  historyConfirmationPending.value = true
  try {
    if (confirmation.kind === 'task-delete' && confirmation.preview) {
      await taskHistory.deleteTask(confirmation.targetId, confirmation.preview.token)
      delete taskViews.value[confirmation.targetId]
      taskOrder.value = taskOrder.value.filter((id) => id !== confirmation.targetId)
      if (activeTaskId.value === confirmation.targetId) {
        activeTaskId.value = ''
        reconcilePermissionQueue('', activeProjectId.value)
      }
    } else if (confirmation.kind === 'project-remove') {
      await workbench.registry.removeProject(confirmation.targetId)
      activeTaskId.value = ''
      if (workbench.selectedProjectId.value) {
        await workbench.retryTaskList()
      }
      reconcilePermissionQueue('', activeProjectId.value)
      syncWorkspaceDisplay()
    } else if (confirmation.preview) {
      await workbench.registry.deleteProjectHistory(
        confirmation.targetId,
        confirmation.preview.token
      )
      for (const [taskId, view] of Object.entries(taskViews.value)) {
        if (view.projectId === confirmation.targetId) delete taskViews.value[taskId]
      }
      if (workbench.selectedProjectId.value === confirmation.targetId) {
        activeTaskId.value = ''
        await workbench.retryTaskList()
        reconcilePermissionQueue('', activeProjectId.value)
      }
    }
    historyConfirmation.value = null
  } catch (error) {
    appendMessage('error', error instanceof Error ? error.message : String(error))
  } finally {
    historyConfirmationPending.value = false
  }
}

function formatHistoryBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function appendStreamChunk(
  role: Extract<ChatMessage['role'], 'assistant' | 'thought'>,
  text: string,
  id: string
): void {
  const lastMessage = messages.value.at(-1)

  if (lastMessage?.id === id && lastMessage.role === role) {
    lastMessage.text += text
    lastMessage.streaming = true
  } else {
    // 新的正式回复开始时，先收起仍在进行的思考气泡，保持时间线干净。
    if (role === 'assistant') {
      for (const message of messages.value) {
        if (message.role === 'thought' && message.streaming) {
          message.streaming = false
        }
      }
    }

    messages.value.push({
      id,
      role,
      text,
      streaming: true
    })
  }

  // 运行中把唯一的总耗时徽章跟随到最新输出，仍然只有一个计时。
  if (isTurnTiming.value) {
    turnDurationAnchorId.value = id
  }

  syncDurationTimer()
  scrollMessagesToBottom()
}

function appendMessage(role: ChatMessage['role'], text: string): void {
  messages.value.push({ id: crypto.randomUUID(), role, text })
  scrollMessagesToBottom()
}

function upsertToolActivity(event: PublicAgentToolEvent): void {
  const id = createAgentToolKey(event)
  const current = toolActivities.value.find((item) => item.id === id)

  if (current) {
    current.title = event.title ?? current.title
    current.status = event.status ?? current.status
  } else {
    toolActivities.value.unshift({
      id,
      title: event.title ?? '正在调用工具',
      status: event.status ?? 'pending'
    })
  }
}

function scrollMessagesToBottom(): void {
  // 对话滚动由 TaskConversation 在用户贴底时自行跟随，避免抢阅读位置。
}
</script>

<template>
  <div class="app-shell">
    <header class="titlebar">
      <div class="titlebar-spacer" />
      <div class="titlebar-brand">
        <Robot :size="16" weight="fill" />
        <span>Agent Studio</span>
      </div>
      <button
        v-if="!showProviderScreen"
        class="icon-button no-drag"
        title="切换检查器"
        aria-label="切换检查器"
        :aria-pressed="showInspector"
        @click="showInspector = !showInspector"
      >
        <SidebarSimple :size="17" />
      </button>
    </header>

    <section v-if="providerBootState === 'loading'" class="provider-loading" aria-live="polite">
      <CircleNotch :size="22" class="spin" />
      <p>正在读取模型配置</p>
    </section>

    <div v-else-if="showProviderScreen" class="provider-screen">
      <ProviderOnboarding
        :initial-summary="providerSummary"
        :list-models="listProviderModels"
        :save-provider="saveProvider"
        :clear-provider="providerSummary?.configured ? clearProvider : undefined"
        :can-cancel="Boolean(providerSummary?.configured)"
        @saved="handleProviderSaved"
        @cancelled="closeProviderSettings"
      />
    </div>

    <div v-else class="workspace-layout" :class="{ 'inspector-hidden': !showInspector }">
      <ProjectSidebar
        :projects="workbench.projects.value"
        :selected-project-id="activeProjectId"
        :running-task-count-by-project-id="workbench.runningTaskCountByProjectId.value"
        :project-load-state="workbench.projectLoadState.value"
        :tasks="taskHistory.tasks.value"
        :selected-task-id="activeSidebarTaskId"
        :active-execution="activeExecution"
        :task-list-load-state="workbench.taskListLoadState.value"
        :new-chat-disabled="newChatDisabled"
        :new-chat-disabled-reason="newChatDisabledReason"
        :history-navigation-disabled="historyNavigationBlocked"
        history-navigation-disabled-reason="正在切换 Project，请稍候。"
        :mutation-actions-disabled="projectInteractionBlocked"
        mutation-actions-disabled-reason="任务执行或主进程操作期间，只读历史仍可查看，修改入口暂不可用。"
        :has-more-tasks="Boolean(taskHistory.taskCursor.value)"
        :loading-more-tasks="taskHistory.loadingMoreTasks.value"
        @new-chat="startNewChat"
        @open-settings="openProviderSettings"
        @select-project="selectProject"
        @choose-project="chooseWorkspace"
        @retry-access="(projectId) => workbench.registry.retryAccess(projectId)"
        @remove-project="requestProjectRemoval"
        @delete-project-history="requestProjectHistoryDeletion"
        @retry-projects="workbench.retryProjects"
        @select-task="selectTask"
        @rename-task="renameOpenedTask"
        @archive-task="archiveOpenedTask"
        @delete-task="requestTaskDeletion"
        @load-more-tasks="taskHistory.loadMoreTasks"
        @retry-task-list="workbench.retryTaskList"
      />

      <main class="chat-panel">
        <TaskHeader
          :facts="taskHeaderFacts"
          :load-error="workbenchLoadError"
          @retry-load="retryWorkbenchLoad"
        />

        <TaskConversation
          :conversation-key="activeTaskId"
          :model="taskTimeline.activeTimeline.value"
          :loading="Boolean(taskTimeline.coordinators.value[activeTaskId]?.loading)"
          :has-more-turns="
            Boolean(activeTaskView?.mode === 'history' && taskHistory.turnCursor.value)
          "
          :loading-more-turns="taskHistory.loadingMoreTurns.value"
          :event-after-sequence-by-turn="taskHistory.eventAfterSequenceByTurn.value"
          :loading-event-turn-ids="taskHistory.loadingEventTurnIds.value"
          :local-errors="localErrorMessages"
          :can-create-task="!newChatDisabled"
          @load-more-turns="loadMoreHistoryTurns"
          @load-more-events="loadMoreHistoryEvents"
          @create-task="startNewChat"
        />

        <TaskComposer
          ref="taskComposer"
          :prompt="prompt"
          :can-send="canSend"
          :action="composerAction"
          :stop-title="stopButtonTitle"
          :disabled-message="composerDisabledMessage"
          :textarea-disabled="composerTextareaDisabled"
          :model="currentModel"
          :load-models="loadSavedModels"
          :select-model="selectProviderModel"
          :model-busy="Boolean(activeExecution) || projectInteractionBlocked"
          :model-disabled="!providerSummary?.configured"
          @update:prompt="prompt = $event"
          @send="sendPrompt"
          @stop="cancelTurn"
          @model-changed="handleModelChanged"
          @model-error="handleModelError"
        />
      </main>

      <aside v-if="showInspector" class="inspector-panel">
        <section class="inspector-section">
          <div class="inspector-heading">
            <strong>执行计划</strong>
            <span>{{ planEntries.length }}</span>
          </div>
          <div v-if="planEntries.length" class="plan-list">
            <div
              v-for="entry in planEntries"
              :key="entry.content"
              class="plan-item"
              :data-status="entry.status"
            >
              <CheckCircle v-if="entry.status === 'completed'" :size="16" weight="fill" />
              <CircleNotch v-else-if="entry.status === 'in_progress'" :size="16" class="spin" />
              <span v-else class="pending-ring" />
              <p>{{ entry.content }}</p>
            </div>
          </div>
          <div v-else class="empty-state" role="status" aria-live="polite">
            <ShieldCheck :size="24" />
            <p>{{ planEmptyMessage }}</p>
          </div>
        </section>

        <section class="inspector-section activity-section">
          <div class="inspector-heading">
            <strong>工具活动</strong>
            <span>{{ toolActivities.length }}</span>
          </div>
          <div v-if="toolActivities.length" class="tool-list">
            <div v-for="tool in toolActivities" :key="tool.id" class="tool-item">
              <TerminalWindow :size="16" />
              <div>
                <strong>{{ tool.title }}</strong>
                <small>{{ tool.status }}</small>
              </div>
            </div>
          </div>
          <div v-else class="empty-state compact" role="status" aria-live="polite">
            <TerminalWindow :size="22" />
            <p>{{ toolEmptyMessage }}</p>
          </div>
        </section>

        <section v-if="activeTaskView?.mode === 'history'" class="inspector-section audit-section">
          <div class="inspector-heading">
            <strong>权限审计</strong>
            <span>{{ taskHistory.permissionAudits.value.length }}</span>
          </div>
          <div v-if="taskHistory.permissionAudits.value.length" class="permission-audit-list">
            <article
              v-for="audit in taskHistory.permissionAudits.value"
              :key="audit.auditId"
              class="permission-audit-item"
              :data-risk="audit.risk"
            >
              <div>
                <strong>{{ audit.title }}</strong>
                <span>
                  {{ audit.risk }} · {{ audit.operationType }} ·
                  {{ permissionAuditInitiatorLabel(audit) }}
                </span>
              </div>
              <p>{{ audit.impact }}</p>
              <ul class="permission-audit-targets">
                <li v-for="target in audit.targetSummaries" :key="target">{{ target }}</li>
              </ul>
              <p v-if="audit.detail" class="permission-audit-detail">{{ audit.detail }}</p>
              <small>
                {{ permissionAuditReasonLabels[audit.reason] }} ·
                {{ permissionAuditScopeLabel(audit.scope) }} ·
                {{ new Date(audit.createdAt).toLocaleString() }}
                <template v-if="audit.truncated"> · 摘要已截断</template>
              </small>
            </article>
            <button
              v-if="taskHistory.permissionAuditCursor.value"
              class="history-load-more"
              :disabled="taskHistory.loadingMorePermissionAudits.value"
              @click="taskHistory.loadMorePermissionAudits"
            >
              {{ taskHistory.loadingMorePermissionAudits.value ? '正在加载…' : '加载更多审计' }}
            </button>
          </div>
          <div v-else class="empty-state compact" role="status" aria-live="polite">
            <ShieldCheck :size="22" />
            <p>当前 Task 暂无权限决策记录。</p>
          </div>
        </section>
      </aside>
    </div>

    <PermissionPrompt
      v-if="permission"
      :key="`${permission.approvalId}:${permission.taskId}:${permission.turnId}`"
      :request="permission"
      :pending="permissionResponsePending"
      :task-title="permissionTaskTitle"
      @respond="respondPermission"
      @cancel-turn="cancelTurn"
    />

    <div
      v-if="historyConfirmation"
      class="modal-backdrop"
      @click.self="!historyConfirmationPending && (historyConfirmation = null)"
    >
      <section
        class="permission-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-confirmation-title"
        aria-describedby="history-confirmation-description"
        @keydown.esc="!historyConfirmationPending && (historyConfirmation = null)"
      >
        <header>
          <div class="permission-icon"><WarningCircle :size="22" weight="fill" /></div>
          <div>
            <h2 id="history-confirmation-title">
              {{
                historyConfirmation.kind === 'project-remove'
                  ? '从项目列表移除'
                  : '删除 Agent Studio 本地历史'
              }}
            </h2>
            <p id="history-confirmation-description">
              <template v-if="historyConfirmation.kind === 'project-remove'">
                将移除“{{
                  historyConfirmation.title
                }}”的列表入口并保留墓碑和已有历史；项目目录不会被删除。
              </template>
              <template v-else>
                将删除“{{ historyConfirmation.title }}”的本地历史：
                {{ historyConfirmation.preview?.fileCount }} 个文件，
                {{ historyConfirmation.preview?.turnCount }} 个 Turn，
                {{ formatHistoryBytes(historyConfirmation.preview?.bytes ?? 0) }}。 不会删除{{
                  historyConfirmation.preview?.exclusions.join('、')
                }}。
              </template>
            </p>
          </div>
        </header>
        <div class="permission-options">
          <button
            class="secondary-button"
            type="button"
            :disabled="historyConfirmationPending"
            @click="historyConfirmation = null"
          >
            取消
          </button>
          <button
            class="primary-button"
            type="button"
            :disabled="historyConfirmationPending"
            @click="confirmHistoryAction"
          >
            {{ historyConfirmationPending ? '正在处理…' : '确认' }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
