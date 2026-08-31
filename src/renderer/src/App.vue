<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  PhCircleNotch as CircleNotch,
  PhSidebarSimple as SidebarSimple,
  PhWarningCircle as WarningCircle
} from '@phosphor-icons/vue'
import type {
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentPlanEntry,
  AgentRuntimeStatus,
  AgentTaskRuntimeState
} from '../../shared/agent'
import {
  resolveTakeoverHudCopy,
  taskPermissionModeFromSnapshot,
  type TaskPermissionMode
} from '../../shared/task-takeover'
import type {
  AgentAvailableCommand,
  AgentAvailableCommandSnapshot
} from '../../shared/agent-available-command'
import type { PublicAgentEvent, PublicAgentToolEvent } from '../../shared/agent-event'
import type { AppAppearanceMode, AppAppearanceState } from '../../shared/app-appearance'
import type {
  ProviderConfigInput,
  ProviderConfigSummary,
  ProviderConnectionInput,
  ProviderModelOption,
  ProviderTestResult
} from '../../shared/provider'
import type { ConversationEntryState, DeletionPreview } from '../../shared/task-history'
import type { TaskAttachmentDescriptor } from '../../shared/task-attachment'
import {
  createAgentEventGuard,
  createAgentMessageKey,
  createAgentToolKey
} from './agent-event-consumer'
import { unwrapDesktopIpcResult, type RendererDesktopIpcError } from './desktop-ipc-result'
import { describeProjectFolderRevealFailure } from './project-folder-reveal'
import BrandMark from './components/BrandMark.vue'
import ProviderOnboarding from './components/ProviderOnboarding.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import ExecutionSurfaceBanner from './components/ExecutionSurfaceBanner.vue'
import PluginsPage from './components/PluginsPage.vue'
import ProjectSidebar from './components/ProjectSidebar.vue'
import TaskComposer from './components/TaskComposer.vue'
import TaskConversation from './components/TaskConversation.vue'
import TaskHeader from './components/TaskHeader.vue'
import TaskInspector from './components/TaskInspector.vue'
import { useRuntimeCapabilities } from './composables/useRuntimeCapabilities'
import { useTaskArtifacts } from './composables/useTaskArtifacts'
import { useTaskChanges } from './composables/useTaskChanges'
import { useTaskTimeline } from './composables/useTaskTimeline'
import { createAttachmentPreviewUrl } from './attachment-preview-url'
import { useTaskWorkbench } from './composables/useTaskWorkbench'
import {
  evaluateTaskComposerSend,
  isForeignExecutionBlockingSend,
  pickLatestContextUsage,
  resolveCancelTurnRequest,
  resolveComposerChrome,
  resolveComposerContextUsage,
  resolveStopButtonAriaLabel,
  resolveStopButtonTitle,
  resolveTaskHeaderFacts,
  restoreComposerPromptAfterFailure
} from './task-composer-actions'
import {
  collectLocalComposerErrors,
  collectTurnErrorMessages,
  resolveConversationConnectFailure,
  shouldMirrorLiveAgentErrorLocally
} from './task-conversation-view'
import { projectTaskHistory } from './task-history-projector'
import {
  INSPECTOR_DEFAULT_OPEN,
  INSPECTOR_DEFAULT_TAB,
  inspectorToggleLabel,
  openChangesReview,
  toggleInspectorOpen,
  type InspectorTab
} from './task-inspector'
import { presentChangeCard } from './task-changes-presentation'
import {
  DEFAULT_PLUGIN_HUB_TAB,
  DEFAULT_PLUGIN_PANE,
  resolveProductSlashPluginTarget,
  type PluginHubTab,
  type PluginPane
} from './plugins-page'
import {
  applyResolvedAppearance,
  DEFAULT_SETTINGS_SECTION,
  type SettingsSection
} from './settings-dialog'
import {
  isFocusInsideInspector,
  overlayConsumesEscape,
  resolveEscapeWorkbenchTarget,
  shouldIgnoreWorkbenchEscape
} from './workbench-keyboard'
import { resolveExecutionSurfaceBanner } from './workbench-primary-view'
import {
  applyAvailableCommandFetchIfCurrent,
  applyAvailableCommandSnapshotIfCurrent,
  matchProductSlashSubmit,
  type SlashCommandItem
} from './slash-command-palette'
import {
  createAndSelectTask,
  deriveSessionTitle,
  isUntitledTaskTitle,
  resolvePermissionTaskTitle,
  resolveSidebarTaskSelection
} from './task-navigation'
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
const showSettingsDialog = ref(false)
const settingsSection = ref<SettingsSection>(DEFAULT_SETTINGS_SECTION)
const pluginHubTab = ref<PluginHubTab>(DEFAULT_PLUGIN_HUB_TAB)
const pluginHubPane = ref<PluginPane>(DEFAULT_PLUGIN_PANE)
const appearance = ref<AppAppearanceState>({ mode: 'dark', resolved: 'dark' })
const appearancePending = ref(false)
const workspace = ref('')
type HistoryConfirmationKind = 'task-delete' | 'project-remove' | 'project-history-delete'
const historyConfirmation = ref<{
  kind: HistoryConfirmationKind
  targetId: string
  title: string
  preview?: DeletionPreview
} | null>(null)
const historyConfirmationPending = ref(false)
const folderNotice = ref<{ title: string; description: string } | null>(null)
const conversationEntry = ref<ConversationEntryState | null>(null)
let conversationEnterGeneration = 0
let conversationEnterPromise: Promise<ConversationEntryState | null> | null = null
const prompt = ref('')
const draftAttachments = ref<TaskAttachmentDescriptor[]>([])
const draftPreviewUrls = ref<Record<string, string>>({})
const runtimeSlashCommands = ref<AgentAvailableCommand[]>([])
/** 当前命令板已应用的快照 revision；切 Task 时归零，避免旧 GET 盖住更新的 push。 */
const runtimeSlashRevision = ref(0)
const taskComposer = ref<{
  focus: () => void
  focusStop?: () => void
  openPermissionModeFromSlash?: () => void
} | null>(null)
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
/** 检查器默认关上，从标题栏抽屉盖住右侧，不占第三列。 */
const showInspector = ref(INSPECTOR_DEFAULT_OPEN)
const inspectorTab = ref<InspectorTab>(INSPECTOR_DEFAULT_TAB)
const inspectorToggleTitle = computed(() => inspectorToggleLabel(showInspector.value))
const taskChanges = useTaskChanges(() => activeTaskId.value)
const taskArtifacts = useTaskArtifacts(() => activeTaskId.value)
const changeCard = computed(() => presentChangeCard(taskChanges.changeSet.value))
const restoreBusy = taskChanges.restoreBusy

function openChangeReview(path?: string): void {
  const next = openChangesReview()
  showInspector.value = next.open
  inspectorTab.value = next.tab
  if (path) void taskChanges.selectPath(path)
}

function startChangeRestore(): void {
  openChangeReview()
  void taskChanges.openRestorePreview()
}
const taskViews = ref<Record<string, TaskViewState>>({})
const taskOrder = ref<string[]>([])
/** 以 workbench 的查看身份驱动 Timeline；保留后台 facts，但绝不将旧 Task 展示到新 Project。 */
watch(activeTaskId, (taskId) => taskTimeline.setActiveTask(taskId), { flush: 'sync' })
/** 尚未建立 Task 时只承接真实错误消息，不伪造 Runtime 欢迎回复。 */
const welcomeMessages = ref<ChatMessage[]>([])
const emptyPlanEntries = ref<AgentPlanEntry[]>([])
const emptyToolActivities = ref<ToolActivity[]>([])
const activeTaskView = computed(() => taskViews.value[activeTaskId.value] ?? null)
/** 审批标题按请求真实 taskId 解析，优先用首条 Prompt 派生的视图标题。 */
const permissionTaskTitle = computed(() => {
  const request = permission.value
  if (!request) return ''
  const view = taskViews.value[request.taskId]
  return resolvePermissionTaskTitle({
    viewTitle: view?.title,
    storeTitle: taskHistory.tasks.value.find((task) => task.taskId === request.taskId)?.title,
    firstPrompt: view?.messages.find((item) => item.role === 'user')?.text,
    taskId: request.taskId
  })
})

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
    hasAttachments: draftAttachments.value.length > 0,
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
const composerChrome = computed(() =>
  resolveComposerChrome({
    activeExecution: activeExecution.value,
    projectInteractionBlocked: projectInteractionBlocked.value
  })
)
const composerAction = computed(() => composerChrome.value.action)
const composerContextUsage = computed(() =>
  resolveComposerContextUsage(pickLatestContextUsage(taskTimeline.activeTimeline.value))
)
const promptMediaHint = computed(() =>
  status.value.promptMedia && status.value.promptMedia.image === false
    ? '当前 Runtime 未声明识图，图片将按文件附件发送。'
    : ''
)
const taskPermission = ref<
  Record<
    string,
    {
      mode: TaskPermissionMode
      takeoverEnabled: boolean
      takeoverApplied: boolean
      takeoverMayStillBeActive?: boolean
    }
  >
>({})
const permissionModeBusy = ref(false)
const activePermissionState = computed(() => taskPermission.value[activeTaskId.value] ?? null)
const composerPermissionMode = computed<TaskPermissionMode>(
  () => activePermissionState.value?.mode ?? 'assist'
)
const composerTakeoverHud = computed(() => {
  const state = activePermissionState.value
  if (!state) return null
  return resolveTakeoverHudCopy({
    takeoverEnabled: state.takeoverEnabled,
    takeoverApplied: state.takeoverApplied,
    takeoverMayStillBeActive: state.takeoverMayStillBeActive,
    executing: Boolean(activeExecution.value)
  })
})

function applyPermissionRuntime(task: AgentTaskRuntimeState): void {
  taskPermission.value = {
    ...taskPermission.value,
    [task.taskId]: {
      mode: taskPermissionModeFromSnapshot({
        takeoverEnabled: task.takeoverEnabled === true,
        permissionPromptStyle: task.permissionPromptStyle === 'ask' ? 'ask' : 'assist'
      }),
      takeoverEnabled: task.takeoverEnabled === true,
      takeoverApplied: task.takeoverApplied === true,
      ...(task.takeoverMayStillBeActive ? { takeoverMayStillBeActive: true } : {})
    }
  }
}

/** 等主进程成功后再改 UI，禁止乐观切换接管。无 Task 时先创建再 IPC，busy 必须抛错不得静默。 */
async function setTaskPermissionMode(mode: TaskPermissionMode): Promise<void> {
  if (permissionModeBusy.value || composerChrome.value.modelBusy) {
    throw new Error('任务执行中不能切换批准模式。')
  }
  permissionModeBusy.value = true
  try {
    const taskId = activeTaskId.value || (await ensureActiveTask())
    applyPermissionRuntime(
      unwrapDesktopIpcResult(
        await window.agent.setPermissionMode({
          taskId,
          mode,
          ...(mode === 'takeover' ? { confirmed: true as const } : {})
        })
      ).task
    )
  } catch (error) {
    appendMessage('error', error instanceof Error ? error.message : String(error))
    throw error
  } finally {
    permissionModeBusy.value = false
  }
}

const composerAttachmentViews = computed(() =>
  draftAttachments.value.map((item) => ({
    attachmentId: item.attachmentId,
    originalName: item.originalName,
    kind: item.kind,
    previewUrl: draftPreviewUrls.value[item.attachmentId]
  }))
)
const stopButtonTitle = computed(() => resolveStopButtonTitle(activeExecution.value))
const stopButtonAriaLabel = computed(() =>
  resolveStopButtonAriaLabel(activeExecution.value, runningTaskTitle.value)
)
const localErrorMessages = computed(() => {
  const timelineErrors = (taskTimeline.activeTimeline.value?.turns ?? []).flatMap((turn) =>
    collectTurnErrorMessages(turn)
  )
  return collectLocalComposerErrors(messages.value, timelineErrors)
})
const composerTextareaDisabled = computed(
  () =>
    projectSelectionPending.value ||
    conversationEntry.value?.restore === 'unavailable' ||
    !promptCapability.value.available ||
    !providerSummary.value?.configured
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
  () => providerBootState.value !== 'ready' && workbench.projects.value.length === 0
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
    workbenchLoadMessage: workbenchLoadMessage.value,
    providerConfigured: Boolean(providerSummary.value?.configured)
  })
})
const workbenchLoadError = computed(
  () =>
    workbench.projectLoadState.value.status === 'error' ||
    workbench.taskListLoadState.value.status === 'error' ||
    workbench.taskDetailLoadState.value.status === 'error'
)
const executionSurfaceBanner = computed(() =>
  resolveExecutionSurfaceBanner({
    primaryView: workbench.primaryView.value,
    activeExecution: activeExecution.value
      ? { taskId: activeExecution.value.taskId, state: activeExecution.value.state }
      : null
  })
)
/** 连接失败进对话流短错误+重试；页眉只留弱状态，避免两个主按钮。 */
const conversationConnectFailure = computed(() =>
  resolveConversationConnectFailure({
    runtimeState: status.value.state,
    runtimeMessage: status.value.message,
    providerConfigured: Boolean(providerSummary.value?.configured),
    hasActiveExecution: Boolean(activeExecution.value),
    localErrors: localErrorMessages.value
  })
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
  window.addEventListener('keydown', onWorkbenchKeydown)
  cleanupListeners.push(() => window.removeEventListener('keydown', onWorkbenchKeydown))
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
    window.agent.onTaskRuntimeState((task) => {
      applyPermissionRuntime(task)
    }),
    window.agent.onPermissionCancelled((request) => {
      removePermission(request)
      respondingPermission.value = clearRespondingPermission(respondingPermission.value, request)
    }),
    window.app.onAppearanceChanged(applyAppearanceState),
    window.agent.onAvailableCommands((snapshot) => {
      applySlashCommandSnapshot(snapshot)
    })
  )

  try {
    applyAppearanceState(unwrapDesktopIpcResult(await window.app.getAppearance()))
  } catch {
    applyResolvedAppearance('dark')
  }

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
  clearDraftAttachmentPreviews()
  workbench.dispose()
  taskTimeline.dispose()
  taskChanges.dispose()
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

/** 新对话先 createTask，再走同一条 selectTask / enterTask，不再另开只读入口。 */
async function startNewChat(projectId?: string): Promise<void> {
  const targetProjectId =
    typeof projectId === 'string' && projectId ? projectId : activeProjectId.value
  if (newChatDisabled.value || projectSelectionPending.value || !targetProjectId) return

  try {
    if (targetProjectId !== activeProjectId.value) {
      await selectProject(targetProjectId)
      if (activeProjectId.value !== targetProjectId) return
    }
    await createAndSelectTask({
      projectId: targetProjectId,
      createTask: async (id) => unwrapDesktopIpcResult(await window.agent.createTask(id)),
      selectTask,
      refreshTasks: () => taskHistory.refreshTasks()
    })
  } catch (error) {
    appendMessage('error', error instanceof Error ? error.message : String(error))
  }
}

/** 点具体对话才切项目；点目录展开不会走这里。 */
async function selectTaskFromSidebar(taskId: string): Promise<void> {
  const next = resolveSidebarTaskSelection({
    taskId,
    selectedProjectId: activeProjectId.value,
    selectedTasks: taskHistory.tasks.value,
    browseTasks: workbench.browseTasks.value
  })
  if (next.shouldSwitchProject) {
    await selectProject(next.projectId)
    if (activeProjectId.value !== next.projectId) return
  }
  await selectTask(taskId)
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
  applyPermissionRuntime(task)
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
    void taskTimeline.refreshCommandEvidence(taskId)
    reconcilePermissionQueue(taskId, detail.projectId)
    conversationEntry.value = {
      taskId,
      historyReady: true,
      restore: 'connecting',
      verification: 'unverified',
      reason: '正在接回上次上下文…'
    }
    if (activeTaskId.value !== taskId) return
    if (activeExecution.value && activeExecution.value.taskId !== taskId) {
      conversationEntry.value = {
        taskId,
        historyReady: true,
        restore: 'idle',
        verification: 'unverified',
        reason: '先停掉当前任务。'
      }
      return
    }
    const pendingEnter = window.agent
      .enterTask(taskId)
      .then((result) => unwrapDesktopIpcResult(result))
    conversationEnterPromise = pendingEnter
    const entry = await pendingEnter
    if (enterGeneration !== conversationEnterGeneration || activeTaskId.value !== taskId) return
    conversationEntry.value = entry
    try {
      applyPermissionRuntime(unwrapDesktopIpcResult(await window.agent.getTaskRuntimeState(taskId)))
    } catch {
      // 进入对话已成功；批准模式刷新失败时保持上次快照，不阻断浏览。
    }
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

/** Project 选择只切换本地历史身份；不重建 Runtime session。 */
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

/** 目录不可用时弹提示，不把失败写进对话。 */
async function revealProjectFolder(projectId: string): Promise<void> {
  const project = workbench.projects.value.find((item) => item.projectId === projectId)
  const displayName = project?.displayName?.trim() || '该项目'
  if (project && project.availability.state !== 'available') {
    folderNotice.value = describeProjectFolderRevealFailure({
      displayName,
      availabilityState: project.availability.state
    })
    return
  }
  try {
    unwrapDesktopIpcResult(await window.app.revealProject(projectId))
  } catch (error) {
    folderNotice.value = describeProjectFolderRevealFailure({
      displayName,
      errorCode: (error as RendererDesktopIpcError).code
    })
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

function openSettingsDialog(): void {
  settingsSection.value = DEFAULT_SETTINGS_SECTION
  showSettingsDialog.value = true
}

function openSettingsSection(section: SettingsSection): void {
  settingsSection.value = section
  showSettingsDialog.value = true
}

function closeSettingsDialog(): void {
  showSettingsDialog.value = false
}

/**
 * 产品别名只做桌面导航，必须清空草稿，避免下次 Enter 把 /plugins 发给 Runtime。
 */
function openPluginHub(
  tab: PluginHubTab = DEFAULT_PLUGIN_HUB_TAB,
  pane: PluginPane = DEFAULT_PLUGIN_PANE
): void {
  pluginHubTab.value = tab
  pluginHubPane.value = pane
  workbench.openPlugins()
}

function handleProductSlashAction(action: NonNullable<SlashCommandItem['productAction']>): void {
  prompt.value = ''
  if (action === 'open-permission-mode') {
    taskComposer.value?.openPermissionModeFromSlash?.()
    return
  }
  const pluginTarget = resolveProductSlashPluginTarget(action)
  if (pluginTarget) {
    openPluginHub(pluginTarget.tab, pluginTarget.pane)
    return
  }
  if (action === 'open-settings-memory') openSettingsSection('memory')
  else if (action === 'open-settings-grok-config') openSettingsSection('grok-config')
  else openSettingsDialog()
}

async function startSettingsGrokAction(command: string): Promise<void> {
  prompt.value = command
  await sendPrompt()
}

/** 丢弃 taskId 对不上或 revision 不新的推送，避免切 Task 后命令板闪到上一份 Grok 广告。 */
function applySlashCommandSnapshot(snapshot: AgentAvailableCommandSnapshot): void {
  const applied = applyAvailableCommandSnapshotIfCurrent({
    selectedTaskId: activeTaskId.value,
    currentRevision: runtimeSlashRevision.value,
    snapshot
  })
  if (!applied.apply) return
  runtimeSlashCommands.value = applied.commands
  runtimeSlashRevision.value = applied.revision
}

/**
 * 切 Task 后重拉快照；只在 selectedTaskId 仍是这次请求的目标、且 revision 更新时写入。
 * IPC 失败不崩 UI，保持空列表，产品别名仍可从 merge 出现。
 */
async function loadAvailableCommands(taskId: string): Promise<void> {
  if (!taskId) return
  try {
    const snapshot = unwrapDesktopIpcResult(await window.agent.getAvailableCommands(taskId))
    const applied = applyAvailableCommandFetchIfCurrent({
      selectedTaskId: activeTaskId.value,
      requestedTaskId: taskId,
      currentRevision: runtimeSlashRevision.value,
      incoming: { ok: true, snapshot }
    })
    if (applied.apply) {
      runtimeSlashCommands.value = applied.commands
      runtimeSlashRevision.value = applied.revision
    }
  } catch {
    applyAvailableCommandFetchIfCurrent({
      selectedTaskId: activeTaskId.value,
      requestedTaskId: taskId,
      currentRevision: runtimeSlashRevision.value,
      incoming: { ok: false }
    })
  }
}

watch(activeTaskId, (taskId) => {
  runtimeSlashCommands.value = []
  runtimeSlashRevision.value = 0
  void loadAvailableCommands(taskId)
  void refreshDraftAttachments(taskId)
})

function applyAppearanceState(state: AppAppearanceState): void {
  appearance.value = state
  applyResolvedAppearance(state.resolved)
}

async function changeAppearance(mode: AppAppearanceMode): Promise<void> {
  appearancePending.value = true
  try {
    applyAppearanceState(unwrapDesktopIpcResult(await window.app.setAppearance(mode)))
  } catch (error) {
    appendMessage('error', error instanceof Error ? error.message : String(error))
  } finally {
    appearancePending.value = false
  }
}

async function clearProvider(): Promise<void> {
  conversationEnterGeneration += 1
  conversationEnterPromise = null
  conversationEntry.value = null
  projectSelection.invalidate()
  providerSummary.value = await window.provider.clear()
  providerBootState.value = 'needs-provider'
  showSettingsDialog.value = false
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
  // 活动执行占用唯一槽位时禁止重连，避免切视图时拆掉后台 Task。
  if (activeExecution.value) return false
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

/** 对话流连接失败重试；有活动执行时不得为查看其它 Project 去抢执行槽。 */
async function retryRuntimeConnect(): Promise<void> {
  if (activeExecution.value || !activeProjectId.value) return
  await ensureProjectConnected(activeProjectId.value)
}

/** 发送只针对当前选中 Task；单飞门禁避免重复提交双 Turn。 */
async function sendPrompt(): Promise<void> {
  const productAction = matchProductSlashSubmit(prompt.value)
  if (productAction) {
    handleProductSlashAction(productAction)
    return
  }

  const text = prompt.value.trim()
  const attachmentIds = draftAttachments.value.map((item) => item.attachmentId)
  if ((!text && attachmentIds.length === 0) || !canSend.value) return
  const displayText =
    text || (draftAttachments.value[0] ? `附件：${draftAttachments.value[0].originalName}` : '')

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
      if (current && isUntitledTaskTitle(current.title)) {
        current.title = deriveSessionTitle(displayText)
        taskOrder.value = [taskId, ...taskOrder.value.filter((id) => id !== taskId)]
      }

      appendMessage('user', displayText)
      await nextTick()
      taskComposer.value?.focus()
      const admitted = unwrapDesktopIpcResult(
        await window.agent.startTurn(taskId, text, attachmentIds)
      )
      clearDraftAttachmentPreviews()
      draftAttachments.value = []
      // admission 也必须经过 epoch/revision watermark，不能覆盖已经先到的较新 Push。
      workbench.acceptExecutionSnapshot(admitted)
      // 实时 Timeline 只靠 AgentEvent 看不到用户 Prompt；admission 成功后立刻写入同一投影。
      const execution = admitted.execution
      if (execution) {
        taskTimeline.acceptAdmission({
          taskId: execution.taskId,
          turnId: execution.turnId,
          executionId: execution.executionId,
          promptDisplayText: displayText,
          model: execution.model,
          acceptedAt: execution.acceptedAt,
          ...(attachmentIds.length ? { attachmentIds } : {})
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

function clearDraftAttachmentPreviews(): void {
  draftPreviewUrls.value = {}
}

async function hydrateDraftPreviews(items: TaskAttachmentDescriptor[]): Promise<void> {
  const next: Record<string, string> = {}
  for (const item of items) {
    if (item.kind !== 'image') continue
    try {
      const preview = unwrapDesktopIpcResult(
        await window.task.getAttachmentPreview(item.taskId, item.attachmentId)
      )
      if (!preview.thumbnailBase64 || !preview.thumbnailMime) continue
      const url = createAttachmentPreviewUrl(preview.thumbnailBase64, preview.thumbnailMime)
      if (url) next[item.attachmentId] = url
    } catch {
      continue
    }
  }
  clearDraftAttachmentPreviews()
  draftPreviewUrls.value = next
}

async function refreshDraftAttachments(taskId?: string): Promise<void> {
  const id = taskId || activeTaskId.value
  if (!id) {
    draftAttachments.value = []
    clearDraftAttachmentPreviews()
    return
  }
  try {
    const items = unwrapDesktopIpcResult(await window.task.listDraftAttachments(id))
    draftAttachments.value = items
    await hydrateDraftPreviews(items)
  } catch {
    draftAttachments.value = []
    clearDraftAttachmentPreviews()
  }
}

async function pickComposerAttachments(): Promise<void> {
  const taskId = await ensureActiveTask()
  unwrapDesktopIpcResult(await window.task.pickAttachments(taskId))
  await refreshDraftAttachments(taskId)
}

async function importDroppedAttachmentPaths(paths: string[]): Promise<void> {
  const taskId = await ensureActiveTask()
  unwrapDesktopIpcResult(await window.task.importDroppedPaths(taskId, paths))
  await refreshDraftAttachments(taskId)
}

async function importClipboardAttachments(): Promise<void> {
  const taskId = await ensureActiveTask()
  unwrapDesktopIpcResult(await window.task.importClipboard(taskId))
  await refreshDraftAttachments(taskId)
}

async function removeDraftAttachment(attachmentId: string): Promise<void> {
  const taskId = activeTaskId.value
  if (!taskId) return
  unwrapDesktopIpcResult(await window.task.removeAttachment(taskId, attachmentId))
  await refreshDraftAttachments(taskId)
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

function toggleInspector(): void {
  showInspector.value = toggleInspectorOpen(showInspector.value)
}

/**
 * 全局 Esc：执行中优先把焦点放到停止按钮；
 * 焦点已在检查器内或空闲时才关抽屉。权限卡/确认框自己处理 Esc。
 */
function onWorkbenchKeydown(event: KeyboardEvent): void {
  if (
    shouldIgnoreWorkbenchEscape({
      key: event.key,
      isComposing: event.isComposing,
      keyCode: event.keyCode,
      defaultPrevented: event.defaultPrevented,
      overlayConsumesEscape: overlayConsumesEscape(event.target) && !showSettingsDialog.value
    })
  ) {
    return
  }
  if (showSettingsDialog.value) {
    event.preventDefault()
    closeSettingsDialog()
    return
  }
  if (historyConfirmation.value) return
  const target = resolveEscapeWorkbenchTarget({
    turnExecuting: composerAction.value === 'stop',
    inspectorOpen: showInspector.value,
    focusInsideInspector: isFocusInsideInspector(event.target)
  })
  if (target === 'none') return
  event.preventDefault()
  if (target === 'stop-button') {
    taskComposer.value?.focusStop?.()
    return
  }
  showInspector.value = false
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
    // 基线/检查点在主进程 Turn 终态后才齐，刷新对话卡，避免继续展示打开项目前的脏文件。
    void taskChanges.reload()
  } else if (event.kind === 'error') {
    completeCurrentTurn(event.taskId)
    if (shouldMirrorLiveAgentErrorLocally()) appendMessage('error', event.message)
    void taskChanges.reload()
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
  void taskTimeline.refreshCommandEvidence(taskId)
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
        <BrandMark :size="16" />
        <span>Agent Studio</span>
      </div>
      <button
        v-if="!showProviderScreen"
        class="icon-button no-drag"
        type="button"
        data-inspector-toggle
        :title="inspectorToggleTitle"
        :aria-label="inspectorToggleTitle"
        :aria-pressed="showInspector"
        @click="toggleInspector"
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
        @saved="handleProviderSaved"
      />
    </div>

    <div v-else class="workspace-layout">
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
        :browse-project-id="workbench.browseProjectId.value"
        :browse-tasks="workbench.browseTasks.value"
        :browse-load-state="workbench.browseLoadState.value"
        :browse-has-more="workbench.browseHasMore.value"
        :browse-loading-more="workbench.browseLoadingMore.value"
        :primary-view="workbench.primaryView.value"
        @new-chat="startNewChat"
        @open-settings="openSettingsDialog"
        @open-plugins="openPluginHub('plugins')"
        @select-project="selectProject"
        @choose-project="chooseWorkspace"
        @retry-access="(projectId) => workbench.registry.retryAccess(projectId)"
        @open-project-folder="revealProjectFolder"
        @remove-project="requestProjectRemoval"
        @delete-project-history="requestProjectHistoryDeletion"
        @retry-projects="workbench.retryProjects"
        @select-task="selectTaskFromSidebar"
        @rename-task="renameOpenedTask"
        @archive-task="archiveOpenedTask"
        @delete-task="requestTaskDeletion"
        @load-more-tasks="taskHistory.loadMoreTasks"
        @retry-task-list="workbench.retryTaskList"
        @browse-project="(projectId) => void workbench.browseProject(projectId)"
        @load-more-browse-tasks="workbench.loadMoreBrowseTasks"
        @retry-browse-tasks="workbench.retryBrowseTasks"
      />

      <main class="chat-panel" :class="{ 'is-plugins': workbench.primaryView.value === 'plugins' }">
        <!-- 插件页只换主列：不卸载 workbench 状态，也不停后台 Turn。 -->
        <template v-if="workbench.primaryView.value === 'plugins'">
          <ExecutionSurfaceBanner
            v-if="executionSurfaceBanner.kind !== 'none'"
            :primary-view="workbench.primaryView.value"
            :active-execution="activeExecution"
            :takeover-hud="composerTakeoverHud"
            @return-to-conversation="workbench.returnToConversation"
          />
          <PluginsPage
            :project-id="activeProjectId"
            :initial-tab="pluginHubTab"
            :initial-pane="pluginHubPane"
          />
        </template>
        <template v-else>
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
            :connect-failure="conversationConnectFailure"
            :permission="permission"
            :permission-pending="permissionResponsePending"
            :permission-task-title="permissionTaskTitle"
            :change-card="changeCard"
            :restore-busy="restoreBusy"
            @load-more-turns="loadMoreHistoryTurns"
            @load-more-events="loadMoreHistoryEvents"
            @retry-connect="retryRuntimeConnect"
            @respond-permission="respondPermission"
            @cancel-turn="cancelTurn"
            @review-changes="openChangeReview()"
            @restore-changes="startChangeRestore"
            @review-file="openChangeReview"
          />

          <TaskComposer
            ref="taskComposer"
            :prompt="prompt"
            :can-send="canSend"
            :action="composerAction"
            :stop-title="stopButtonTitle"
            :stop-aria-label="stopButtonAriaLabel"
            :disabled-message="composerDisabledMessage"
            :textarea-disabled="composerTextareaDisabled"
            :model="currentModel"
            :load-models="loadSavedModels"
            :select-model="selectProviderModel"
            :model-busy="composerChrome.modelBusy || permissionModeBusy"
            :model-disabled="!providerSummary?.configured"
            :permission-mode="composerPermissionMode"
            :takeover-applied="activePermissionState?.takeoverApplied === true"
            :takeover-may-still-be-active="activePermissionState?.takeoverMayStillBeActive === true"
            :takeover-hud="composerTakeoverHud"
            :set-permission-mode="setTaskPermissionMode"
            :context-usage="composerContextUsage"
            :runtime-commands="runtimeSlashCommands"
            :attachments="composerAttachmentViews"
            :prompt-media-hint="promptMediaHint"
            @update:prompt="prompt = $event"
            @send="sendPrompt"
            @stop="cancelTurn"
            @pick-attachments="pickComposerAttachments"
            @import-dropped-paths="importDroppedAttachmentPaths"
            @import-clipboard="importClipboardAttachments"
            @remove-attachment="removeDraftAttachment"
            @open-plugins="handleProductSlashAction('open-plugins')"
            @open-plugins-mcp="handleProductSlashAction('open-plugins-mcp')"
            @open-plugins-marketplace="handleProductSlashAction('open-plugins-marketplace')"
            @open-settings="handleProductSlashAction('open-settings')"
            @open-settings-memory="handleProductSlashAction('open-settings-memory')"
            @open-settings-grok-config="handleProductSlashAction('open-settings-grok-config')"
            @model-changed="handleModelChanged"
            @model-error="handleModelError"
          />
        </template>
      </main>

      <TaskInspector
        :open="showInspector"
        :active-tab="inspectorTab"
        :task-id="activeTaskId"
        :timeline="taskTimeline.activeTimeline.value"
        :timeline-loading="Boolean(taskTimeline.coordinators.value[activeTaskId]?.loading)"
        :permission-audits="taskHistory.permissionAudits.value"
        :permission-audit-cursor="taskHistory.permissionAuditCursor.value"
        :loading-more-permission-audits="taskHistory.loadingMorePermissionAudits.value"
        :show-permission-audits="activeTaskView?.mode === 'history'"
        :changes-controller="taskChanges"
        :artifacts-controller="taskArtifacts"
        @close="showInspector = false"
        @update:active-tab="inspectorTab = $event"
        @load-more-permission-audits="taskHistory.loadMorePermissionAudits"
      />
    </div>

    <SettingsDialog
      v-if="showSettingsDialog"
      :section="settingsSection"
      :appearance="appearance"
      :appearance-pending="appearancePending"
      :initial-summary="providerSummary"
      :list-models="listProviderModels"
      :save-provider="saveProvider"
      :clear-provider="providerSummary?.configured ? clearProvider : undefined"
      :selected-task-id="activeTaskId"
      :grok-actions-available="
        Boolean(activeTaskId) && status.state === 'ready' && !activeExecution
      "
      :project-hint="workbench.selectedProject.value?.displayName"
      @close="closeSettingsDialog"
      @update:section="settingsSection = $event"
      @change-appearance="changeAppearance"
      @saved="handleProviderSaved"
      @start-turn="startSettingsGrokAction"
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

    <div v-if="folderNotice" class="modal-backdrop" @click.self="folderNotice = null">
      <section
        class="permission-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-notice-title"
        aria-describedby="folder-notice-description"
        @keydown.esc="folderNotice = null"
      >
        <header>
          <div class="permission-icon"><WarningCircle :size="22" weight="fill" /></div>
          <div>
            <h2 id="folder-notice-title">{{ folderNotice.title }}</h2>
            <p id="folder-notice-description">{{ folderNotice.description }}</p>
          </div>
        </header>
        <div class="permission-options">
          <button class="primary-button" type="button" @click="folderNotice = null">知道了</button>
        </div>
      </section>
    </div>
  </div>
</template>
