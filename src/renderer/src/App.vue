<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  PhArrowClockwise as ArrowClockwise,
  PhCaretDown as CaretDown,
  PhCaretRight as CaretRight,
  PhCheckCircle as CheckCircle,
  PhCircleNotch as CircleNotch,
  PhPaperPlaneTilt as PaperPlaneTilt,
  PhRobot as Robot,
  PhShieldCheck as ShieldCheck,
  PhSidebarSimple as SidebarSimple,
  PhStop as Stop,
  PhTerminalWindow as TerminalWindow,
  PhWarningCircle as WarningCircle,
  PhX as X
} from '@phosphor-icons/vue'
import type {
  AgentEvent,
  AgentPermissionRequest,
  AgentPlanEntry,
  AgentRuntimeStatus,
  AgentToolEvent
} from '../../shared/agent'
import type {
  ProviderConfigInput,
  ProviderConfigSummary,
  ProviderConnectionInput,
  ProviderModelOption,
  ProviderTestResult
} from '../../shared/provider'
import {
  createAgentEventGuard,
  createAgentMessageKey,
  createAgentToolKey
} from './agent-event-consumer'
import ModelSelector from './components/ModelSelector.vue'
import ProviderOnboarding from './components/ProviderOnboarding.vue'
import WorkspaceSidebar, {
  type SidebarProjectItem,
  type SidebarSessionItem
} from './components/WorkspaceSidebar.vue'
import { useRuntimeCapabilities } from './composables/useRuntimeCapabilities'
import { canSendRuntimePrompt, rebuildRuntimeSession } from './runtime-session-actions'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'thought' | 'error'
  text: string
  streaming?: boolean
  /**
   * 仅挂在“本轮结果锚点”消息上的整轮总耗时。
   * 一条用户指令只保留一个总时长，不按中间思考/片段拆分计时。
   */
  turnDurationMs?: number
}

/**
 * 会话时间线中的“一轮对话”：
 * 一条用户指令 + 本轮全部思考 + 正式回复 + 错误，聚合为同一组，
 * 用来消除思考/回复碎片各自成卡的割裂感。
 */
interface ConversationTurn {
  id: string
  user?: ChatMessage
  thoughts: ChatMessage[]
  answers: ChatMessage[]
  errors: ChatMessage[]
  /** 本轮冻结总耗时；运行中为空，改读实时计时。 */
  durationMs?: number
  /** 本轮是否仍有流式输出。 */
  streaming: boolean
  /** 是否属于当前正在执行的这一轮。 */
  active: boolean
  /** 是否展示处理区（思考、占位或已有耗时）。 */
  showProcess: boolean
}

interface ToolActivity {
  id: string
  title: string
  status: string
}

const status = ref<AgentRuntimeStatus>({
  runtimeId: 'grok',
  state: 'idle',
  message: '尚未连接 Grok Build'
})
const providerSummary = ref<ProviderConfigSummary | null>(null)
const providerBootState = ref<'loading' | 'needs-provider' | 'ready'>('loading')
const showProviderSettings = ref(false)
const workspace = ref('')
const prompt = ref('')
const permission = ref<AgentPermissionRequest | null>(null)
const showInspector = ref(true)
const composer = ref<HTMLTextAreaElement | null>(null)
const messageList = ref<HTMLElement | null>(null)
/** 当前消息列表滚动位置对应的轮次锚点，驱动左侧导航高亮。 */
const activeTurnAnchorId = ref<string | null>(null)
/** 程序化滚动时暂时忽略滚动监听，避免锚点高亮来回跳。 */
let ignoreAnchorScrollSync = false
let ignoreAnchorScrollTimer: ReturnType<typeof setTimeout> | null = null
const planEntries = ref<AgentPlanEntry[]>([])
const toolActivities = ref<ToolActivity[]>([])
/** 当前激活会话 ID，先用本地 UI 状态驱动侧栏高亮。 */
const activeSessionId = ref('welcome-session')
/** 最近会话列表：发送首条用户消息后写入标题，暂不做持久化。 */
const recentSessions = ref<SidebarSessionItem[]>([
  {
    id: 'welcome-session',
    title: '新对话'
  }
])
const messages = ref<ChatMessage[]>([
  {
    id: 'welcome',
    role: 'assistant',
    text: '选择一个工作目录，我会通过当前模型配置启动 Grok Build Runtime。'
  }
])

const cleanupListeners: Array<() => void> = []
const acceptAgentEvent = createAgentEventGuard()
/** 驱动整轮任务耗时的实时刷新。 */
const nowTick = ref(Date.now())
let durationTimer: ReturnType<typeof setInterval> | null = null
/** 当前这一轮用户指令的开始时间；一条指令只对应一个计时器。 */
const turnStartedAt = ref<number | null>(null)
/** 当前这一轮结束时间；结束后冻结总耗时。 */
const turnEndedAt = ref<number | null>(null)
/** 当前把“整轮耗时”徽章挂在哪条消息上；运行中跟着最新输出走，结束后固定在最终回复。 */
const turnDurationAnchorId = ref<string | null>(null)
/** 本轮开始时的消息分界，结束时只在本轮消息里挑选耗时锚点。 */
const turnMessageStartIndex = ref(0)
/**
 * 思考折叠的用户手动覆盖。
 * 未记录时：执行中默认展开，结束后默认收起（贴近 Codex）。
 */
const thoughtExpandOverride = ref<Record<string, boolean>>({})

/** 是否存在仍在流式输出的消息。 */
const hasStreamingMessage = computed(() => messages.value.some((item) => item.streaming))
/** 已进入执行态，但还没有任何流式消息时，展示占位提示。 */
const showExecutionPlaceholder = computed(
  () => status.value.state === 'busy' && !hasStreamingMessage.value && turnStartedAt.value != null
)
/** 当前这一轮是否仍在计时（发送后到整轮结束前）。 */
const isTurnTiming = computed(() => turnStartedAt.value != null && turnEndedAt.value == null)

/**
 * 把毫秒格式化成用户可读耗时。
 * 小于 1 分钟显示秒，超过后显示分秒，方便判断是否还在执行。
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000
  if (totalSeconds < 60) {
    return `${totalSeconds < 10 ? totalSeconds.toFixed(1) : Math.floor(totalSeconds)}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/** 当前这一轮的总耗时文案；运行中实时跳，结束后读冻结值。 */
const turnDurationLabel = computed(() => {
  if (turnStartedAt.value == null) return ''
  const end = turnEndedAt.value ?? nowTick.value
  return formatDuration(end - turnStartedAt.value)
})

/**
 * 从思考正文提取一行短摘要，让用户先看到“正在想什么”，
 * 而不是只面对大段原始思维文本。
 */
function deriveThoughtSummary(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return '整理思路'
  // 优先取第一句，避免摘要被长段落淹没。
  const sentence = compact.split(/(?<=[。！？.!?])\s+/)[0] ?? compact
  return sentence.length > 42 ? `${sentence.slice(0, 42)}…` : sentence
}

/**
 * 把扁平消息流归并为 Codex 风格的“一轮一组”。
 * 规则：遇到 user 开启新轮；其后的 thought/assistant/error 都归入同一轮，
 * 直到下一条 user。欢迎语这类无用户消息的助手气泡单独成组。
 */
const timelineTurns = computed<ConversationTurn[]>(() => {
  const turns: ConversationTurn[] = []
  let current: ConversationTurn | null = null

  const pushTurn = (turn: ConversationTurn): void => {
    turns.push(turn)
  }

  const ensureTurn = (seedId: string): ConversationTurn => {
    if (current) return current
    current = {
      id: seedId,
      thoughts: [],
      answers: [],
      errors: [],
      streaming: false,
      active: false,
      showProcess: false
    }
    return current
  }

  for (const message of messages.value) {
    if (message.role === 'user') {
      if (current) pushTurn(current)
      current = {
        id: message.id,
        user: message,
        thoughts: [],
        answers: [],
        errors: [],
        streaming: false,
        active: false,
        showProcess: false
      }
      continue
    }

    const turn = ensureTurn(message.id)
    if (message.role === 'thought') turn.thoughts.push(message)
    else if (message.role === 'assistant') turn.answers.push(message)
    else turn.errors.push(message)

    if (message.streaming) turn.streaming = true
    if (message.turnDurationMs != null) turn.durationMs = message.turnDurationMs
  }

  if (current) pushTurn(current)

  // 标记当前执行轮：优先最后一轮带用户指令的分组。
  if (turns.length > 0 && (isTurnTiming.value || showExecutionPlaceholder.value)) {
    const activeTurn = [...turns].reverse().find((item) => item.user) ?? turns.at(-1)
    if (activeTurn) activeTurn.active = true
  }

  for (const turn of turns) {
    // 处理区只在“有思考或仍在执行”时出现；无思考的历史轮直接展示正式回复。
    turn.showProcess = Boolean(
      turn.user && (turn.thoughts.length > 0 || turn.active || turn.streaming)
    )
  }

  return turns
})

/**
 * 左侧锚点只对应“有用户指令”的轮次。
 * 欢迎语等无用户消息的气泡不占锚点，避免导航被系统提示污染。
 */
const turnAnchors = computed(() =>
  timelineTurns.value
    .filter((turn) => Boolean(turn.user))
    .map((turn, index) => {
      const raw = turn.user?.text.replace(/\s+/g, ' ').trim() ?? ''
      const label = raw
        ? raw.length > 24
          ? `${raw.slice(0, 24)}…`
          : raw
        : `第 ${index + 1} 轮对话`
      return {
        id: turn.id,
        index: index + 1,
        label,
        active: turn.active || turn.streaming
      }
    })
)

/** 生成稳定的 DOM 锚点 id，供滚动定位与左侧固定导航共用。 */
function turnAnchorDomId(turnId: string): string {
  return `turn-anchor-${turnId}`
}

/** 根据当前滚动位置，同步左侧锚点高亮到最近的一轮对话。 */
function syncActiveTurnAnchor(): void {
  if (ignoreAnchorScrollSync) return
  const root = messageList.value
  if (!root) return

  const anchors = turnAnchors.value
  if (!anchors.length) {
    activeTurnAnchorId.value = null
    return
  }

  const rootRect = root.getBoundingClientRect()
  // 以视口上方 28% 作为“当前阅读线”，更接近用户实际注视位置。
  const focusY = rootRect.top + root.clientHeight * 0.28
  let currentId = anchors[0]?.id ?? null

  for (const anchor of anchors) {
    const el = root.querySelector<HTMLElement>(`#${CSS.escape(turnAnchorDomId(anchor.id))}`)
    if (!el) continue
    const top = el.getBoundingClientRect().top
    if (top <= focusY) currentId = anchor.id
    else break
  }

  // 滚到接近底部时，直接点亮最后一轮，避免最后一轮很难被激活。
  if (root.scrollTop + root.clientHeight >= root.scrollHeight - 24) {
    currentId = anchors.at(-1)?.id ?? currentId
  }

  activeTurnAnchorId.value = currentId
}

/** 点击左侧锚点后，平滑滚到对应轮次顶部。 */
function scrollToTurnAnchor(turnId: string): void {
  const root = messageList.value
  if (!root) return
  const target = root.querySelector<HTMLElement>(`#${CSS.escape(turnAnchorDomId(turnId))}`)
  if (!target) return

  ignoreAnchorScrollSync = true
  if (ignoreAnchorScrollTimer) clearTimeout(ignoreAnchorScrollTimer)
  activeTurnAnchorId.value = turnId

  const top = Math.max(0, target.offsetTop - 18)
  root.scrollTo({ top, behavior: 'smooth' })

  ignoreAnchorScrollTimer = setTimeout(() => {
    ignoreAnchorScrollSync = false
    syncActiveTurnAnchor()
  }, 360)
}

/** 处理区标题：执行中强调“正在处理”，结束后改为“已处理”。 */
function processTitle(turn: ConversationTurn): string {
  if (turn.active || turn.streaming) return '正在处理'
  return '已处理'
}

/** 读取某一轮应展示的耗时文案；活跃轮用实时值，历史轮用冻结值。 */
function turnDurationText(turn: ConversationTurn): string {
  // 当前执行轮优先读实时总计时，保证用户始终只看到“这一条指令”的进度。
  if (turn.active || turn.streaming) return turnDurationLabel.value
  if (turn.durationMs != null) return formatDuration(turn.durationMs)
  return ''
}

/** 本轮是否显示耗时徽章。 */
function shouldShowTurnDuration(turn: ConversationTurn): boolean {
  return Boolean(turnDurationText(turn))
}

/** 折叠态下展示的思考摘要，多段思考时拼成一段可读预览。 */
function turnThoughtSummary(turn: ConversationTurn): string {
  const merged = turn.thoughts
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join(' ')
  if (!merged) {
    return turn.active || turn.streaming ? '已收到任务，正在组织思路与下一步动作' : '查看思考过程'
  }
  return deriveThoughtSummary(merged)
}

/**
 * 思考区是否展开。
 * 用户点过折叠按钮后以手动状态为准；否则执行中展开、结束后收起。
 */
function isThoughtExpanded(turn: ConversationTurn): boolean {
  const override = thoughtExpandOverride.value[turn.id]
  if (override != null) return override
  return turn.active || turn.streaming
}

/** 切换某一轮思考过程的展开/收起。 */
function toggleThoughtExpanded(turnId: string): void {
  const turn = timelineTurns.value.find((item) => item.id === turnId)
  if (!turn) return
  const next = !isThoughtExpanded(turn)
  thoughtExpandOverride.value = {
    ...thoughtExpandOverride.value,
    [turnId]: next
  }
}

/** 启动/停止整轮耗时刷新定时器。 */
function syncDurationTimer(): void {
  if (isTurnTiming.value || status.value.state === 'busy' || hasStreamingMessage.value) {
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
function completeCurrentTurn(): void {
  if (turnStartedAt.value == null) {
    finalizeStreamingMessages()
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
  turnStartedAt.value = null
  turnEndedAt.value = null
  turnMessageStartIndex.value = messages.value.length
  syncDurationTimer()
}

/** 开始新一轮用户指令的计时。 */
function beginCurrentTurn(): void {
  const now = Date.now()
  turnStartedAt.value = now
  turnEndedAt.value = null
  turnDurationAnchorId.value = null
  // 记录分界：本轮耗时锚点只会落在此索引之后的消息上。
  turnMessageStartIndex.value = messages.value.length
  nowTick.value = now
  syncDurationTimer()
}

const isConnected = computed(() => status.value.state === 'ready' || status.value.state === 'busy')
const isBusy = computed(() => status.value.state === 'busy' || status.value.state === 'connecting')
const { resolveCapability, isAvailable } = useRuntimeCapabilities(status)
const promptCapability = computed(() => resolveCapability('session.prompt.text', '发送文本 Prompt'))
const planCapability = computed(() => resolveCapability('event.plan', '展示执行计划'))
const toolCapability = computed(() => resolveCapability('event.tool', '展示工具活动'))
const createSessionCapability = computed(() => resolveCapability('session.create', '创建新对话'))
const connectCapability = computed(() => resolveCapability('runtime.connect', '连接 Runtime'))
const canSend = computed(() =>
  canSendRuntimePrompt(prompt.value, status.value, promptCapability.value.available)
)
const promptCapabilityMessage = computed(
  () => promptCapability.value.reason ?? promptCapability.value.notice
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
  () => isBusy.value || !isAvailable('runtime.connect') || !isAvailable('session.create')
)
const newChatDisabledReason = computed(() => {
  if (isBusy.value) return 'Runtime 正在执行或连接中，暂时不能创建新对话。'
  return connectCapability.value.reason ?? createSessionCapability.value.reason ?? ''
})
const workspaceName = computed(() => {
  // Windows 与 POSIX 路径都按最后一级目录名展示，避免侧栏出现完整盘符路径。
  const segments = workspace.value.split(/[\\/]/).filter(Boolean)
  return segments.at(-1) ?? '未选择目录'
})
/** 侧栏项目列表目前只映射当前工作区，后续再扩展多项目历史。 */
const sidebarProjects = computed<SidebarProjectItem[]>(() => {
  if (!workspace.value) return []
  return [
    {
      id: workspace.value,
      name: workspaceName.value,
      path: workspace.value
    }
  ]
})
const activeProjectId = computed(() => workspace.value || '')
const currentModel = computed<ProviderModelOption | null>(() => {
  const summary = providerSummary.value
  if (!summary?.modelId) return null
  return {
    modelId: summary.modelId,
    ...(summary.modelDisplayName ? { displayName: summary.modelDisplayName } : {})
  }
})
const showProviderScreen = computed(
  () => providerBootState.value !== 'ready' || showProviderSettings.value
)
const statusLabel = computed(() => {
  const labels: Record<AgentRuntimeStatus['state'], string> = {
    idle: '未连接',
    connecting: '连接中',
    ready: '已连接',
    busy: '执行中',
    error: '连接异常'
  }
  return labels[status.value.state]
})

// 轮次增减时校正锚点高亮，避免指向已消失的历史 id。
watch(
  turnAnchors,
  (anchors) => {
    if (!anchors.length) {
      activeTurnAnchorId.value = null
      return
    }
    if (!anchors.some((item) => item.id === activeTurnAnchorId.value)) {
      activeTurnAnchorId.value = anchors.at(-1)?.id ?? null
    }
    void nextTick(() => syncActiveTurnAnchor())
  },
  { deep: true }
)

// Runtime 进入/离开执行态时，维护“一条指令一个总计时”。
watch([hasStreamingMessage, () => status.value.state], ([, state], previous) => {
  const previousState = previous?.[1]
  // 发送时可能已经 beginCurrentTurn；这里只在尚未计时时补启动。
  if (state === 'busy' && previousState !== 'busy' && turnStartedAt.value == null) {
    beginCurrentTurn()
  }
  if (state !== 'busy' && previousState === 'busy') {
    completeCurrentTurn()
  }
  syncDurationTimer()
})

onMounted(async () => {
  cleanupListeners.push(
    window.grok.onStatus((nextStatus) => {
      status.value = nextStatus
      workspace.value = nextStatus.workspace ?? workspace.value
    }),
    window.grok.onEvent(handleAgentEvent),
    window.grok.onPermission((request) => {
      permission.value = request
    })
  )

  try {
    providerSummary.value = await window.provider.getSummary()
    providerBootState.value = providerSummary.value.configured ? 'ready' : 'needs-provider'
  } catch {
    providerBootState.value = 'needs-provider'
  }

  status.value = await window.grok.getStatus()
  workspace.value = status.value.workspace ?? ''
})

onBeforeUnmount(() => {
  cleanupListeners.forEach((cleanup) => cleanup())
  if (durationTimer) {
    clearInterval(durationTimer)
    durationTimer = null
  }
  if (ignoreAnchorScrollTimer) {
    clearTimeout(ignoreAnchorScrollTimer)
    ignoreAnchorScrollTimer = null
  }
})

/** 从用户首条消息生成侧栏最近项标题，超长时截断保持列表清爽。 */
function deriveSessionTitle(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return '新对话'
  return compact.length > 28 ? `${compact.slice(0, 28)}…` : compact
}

/** 只有 Runtime 确认建立新会话后才重置本地视图，避免 UI 清空但上下文仍延续。 */
async function startNewChat(): Promise<void> {
  if (newChatDisabled.value) return

  try {
    const result = await rebuildRuntimeSession({
      status: status.value,
      workspace: workspace.value,
      chooseWorkspace: window.grok.chooseWorkspace,
      connect: window.grok.connect,
      disconnect: window.grok.disconnect
    })
    if (!result) return

    workspace.value = result.workspace
    status.value = result.status
    resetConversationForRuntimeSession(result.status.runtimeSessionId)
  } catch (error) {
    appendMessage('error', error instanceof Error ? error.message : String(error))
  }
}

/** 清理仅属于旧 Runtime session 的 Renderer 状态，并保留不可恢复的最近记录。 */
function resetConversationForRuntimeSession(sessionId: string): void {
  activeSessionId.value = sessionId
  recentSessions.value = [
    { id: sessionId, title: '新对话' },
    ...recentSessions.value.filter(
      (item) => item.id !== sessionId && item.id !== 'welcome-session' && item.title !== '新对话'
    )
  ].slice(0, 12)
  planEntries.value = []
  toolActivities.value = []
  // 新会话清空折叠覆盖，避免旧轮次状态串到新对话。
  thoughtExpandOverride.value = {}
  messages.value = [
    {
      id: 'welcome',
      role: 'assistant',
      text: '新的 Grok Runtime 会话已就绪。直接描述你想改动或排查的内容即可。'
    }
  ]
}

/** 选择项目时复用现有选目录流程；已选中的当前项目不重复弹窗。 */
async function selectProject(projectId: string): Promise<void> {
  if (projectId && projectId === workspace.value) return
  await chooseWorkspace()
}

async function chooseWorkspace(): Promise<void> {
  const selected = await window.grok.chooseWorkspace()
  if (!selected) return
  workspace.value = selected
  await connectAgent()
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
  providerSummary.value = await window.provider.clear()
  providerBootState.value = 'needs-provider'
  showProviderSettings.value = false
  workspace.value = ''
}

async function connectAgent(): Promise<void> {
  if (!workspace.value) {
    await chooseWorkspace()
    return
  }

  try {
    await window.grok.connect(workspace.value)
  } catch (error) {
    appendMessage('error', error instanceof Error ? error.message : String(error))
  }
}

async function disconnectAgent(): Promise<void> {
  await window.grok.disconnect()
}

async function sendPrompt(): Promise<void> {
  const text = prompt.value.trim()
  if (!text || !canSend.value) return

  prompt.value = ''
  // 一条用户指令只开一个总计时，从发送当下就开始。
  beginCurrentTurn()
  // 用首条有效用户消息刷新侧栏“最近”标题，贴近 Codex 的会话列表体感。
  const current = recentSessions.value.find((item) => item.id === activeSessionId.value)
  if (current && (current.title === '新对话' || current.title.startsWith('新对话'))) {
    current.title = deriveSessionTitle(text)
    recentSessions.value = [
      current,
      ...recentSessions.value.filter((item) => item.id !== current.id)
    ]
  }
  appendMessage('user', text)
  await nextTick()
  composer.value?.focus()

  try {
    await window.grok.sendPrompt(text)
  } catch (error) {
    completeCurrentTurn()
    appendMessage('error', error instanceof Error ? error.message : String(error))
  }
}

async function cancelTurn(): Promise<void> {
  await window.grok.cancel()
  // 取消后立即收束本轮总计时，避免界面一直显示“已执行”。
  completeCurrentTurn()
}

async function respondPermission(optionId?: string): Promise<void> {
  if (!permission.value) return
  await window.grok.respondPermission(permission.value.id, optionId)
  permission.value = null
}

/** 输入法正在确认候选词时保留 Enter，等待 compositionend 完成 v-model 更新。 */
function handleComposerKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  if (event.isComposing || event.keyCode === 229) return

  event.preventDefault()
  void sendPrompt()
}

function handleAgentEvent(event: AgentEvent): void {
  if (!acceptAgentEvent(event)) return

  if (event.kind === 'agent-message' && event.text) {
    appendStreamChunk('assistant', event.text, createAgentMessageKey(event))
  } else if (event.kind === 'agent-thought' && event.text) {
    appendStreamChunk('thought', event.text, createAgentMessageKey(event))
  } else if (event.kind === 'tool-call' || event.kind === 'tool-update') {
    upsertToolActivity(event)
  } else if (event.kind === 'plan') {
    planEntries.value = event.entries
  } else if (event.kind === 'turn-complete') {
    if (permission.value?.taskId === event.taskId && permission.value.turnId === event.turnId) {
      permission.value = null
    }
    // 整轮完成：只沉淀一个总耗时，不给中间片段分别计时。
    completeCurrentTurn()
  } else if (event.kind === 'error') {
    completeCurrentTurn()
    appendMessage('error', event.message)
  }
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

function upsertToolActivity(event: AgentToolEvent): void {
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
  void nextTick(() => {
    if (!messageList.value) return
    messageList.value.scrollTop = messageList.value.scrollHeight
    // 新消息到来后同步锚点高亮，保证最新一轮始终可被点亮。
    syncActiveTurnAnchor()
  })
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
      <WorkspaceSidebar
        brand-name="Agent Studio"
        :workspace-path="workspace"
        :workspace-name="workspaceName"
        :projects="sidebarProjects"
        :sessions="recentSessions"
        :active-session-id="activeSessionId"
        :active-project-id="activeProjectId"
        :new-chat-disabled="newChatDisabled"
        :new-chat-disabled-reason="newChatDisabledReason"
        :recent-sessions-disabled="true"
        recent-sessions-disabled-reason="历史恢复将在 P0-06 接入；当前条目仅为本地记录。"
        @new-chat="startNewChat"
        @open-project="chooseWorkspace"
        @open-settings="openProviderSettings"
        @select-project="selectProject"
      />

      <main class="chat-panel">
        <header class="chat-header">
          <div>
            <h1>{{ workspaceName }}</h1>
            <p>{{ status.message }}</p>
          </div>
          <div class="chat-actions">
            <span class="status-chip" :data-state="status.state">
              <CircleNotch v-if="isBusy" :size="14" class="spin" />
              <CheckCircle v-else-if="status.state === 'ready'" :size="14" weight="fill" />
              <WarningCircle v-else-if="status.state === 'error'" :size="14" weight="fill" />
              <span>{{ statusLabel }}</span>
            </span>
            <button v-if="isConnected" class="secondary-button" @click="disconnectAgent">
              断开
            </button>
            <button v-else class="primary-button" :disabled="isBusy" @click="connectAgent">
              <ArrowClockwise :size="15" />
              连接 Grok
            </button>
          </div>
        </header>

        <!-- 消息舞台：左侧固定锚点轨，右侧才是会滚动的对话列表 -->
        <div class="message-stage" :class="{ 'has-anchors': turnAnchors.length > 0 }">
          <nav v-if="turnAnchors.length" class="turn-anchor-rail" aria-label="对话轮次锚点">
            <div class="turn-anchor-track" aria-hidden="true" />
            <button
              v-for="anchor in turnAnchors"
              :key="anchor.id"
              type="button"
              class="turn-anchor-dot"
              :class="{
                active: activeTurnAnchorId === anchor.id,
                live: anchor.active
              }"
              :title="`第 ${anchor.index} 轮：${anchor.label}`"
              :aria-label="`跳转到第 ${anchor.index} 轮对话`"
              :aria-current="activeTurnAnchorId === anchor.id ? 'true' : undefined"
              @click="scrollToTurnAnchor(anchor.id)"
            >
              <span class="turn-anchor-index">{{ anchor.index }}</span>
            </button>
          </nav>

          <section
            ref="messageList"
            class="message-list"
            aria-live="polite"
            @scroll.passive="syncActiveTurnAnchor"
          >
            <!-- 按“一轮指令”聚合渲染；锚点目标 id 仍挂在轮次容器上 -->
            <article
              v-for="turn in timelineTurns"
              :id="turn.user ? turnAnchorDomId(turn.id) : undefined"
              :key="turn.id"
              class="turn-group"
              :data-anchor="turn.user ? 'true' : 'false'"
              :data-active-anchor="turn.user && activeTurnAnchorId === turn.id ? 'true' : 'false'"
            >
              <div v-if="turn.user" class="turn-user">
                <div class="turn-user-bubble">
                  <p>{{ turn.user.text }}</p>
                </div>
              </div>

              <div
                v-if="turn.showProcess"
                class="turn-process"
                :data-active="turn.active || turn.streaming ? 'true' : 'false'"
              >
                <button
                  type="button"
                  class="turn-process-toggle"
                  :aria-expanded="isThoughtExpanded(turn) ? 'true' : 'false'"
                  :title="isThoughtExpanded(turn) ? '收起思考过程' : '展开思考过程'"
                  @click="toggleThoughtExpanded(turn.id)"
                >
                  <span class="turn-process-leading">
                    <CircleNotch v-if="turn.active || turn.streaming" :size="14" class="spin" />
                    <CaretDown v-else-if="isThoughtExpanded(turn)" :size="14" />
                    <CaretRight v-else :size="14" />
                    <span class="turn-process-title">{{ processTitle(turn) }}</span>
                    <span
                      v-if="shouldShowTurnDuration(turn)"
                      class="message-duration"
                      :data-live="turn.active || turn.streaming ? 'true' : 'false'"
                    >
                      <span
                        >{{ turn.active || turn.streaming ? '已执行' : '耗时' }}
                        {{ turnDurationText(turn) }}</span
                      >
                    </span>
                  </span>
                  <span class="message-summary" :title="turnThoughtSummary(turn)">
                    {{ turnThoughtSummary(turn) }}
                  </span>
                </button>

                <div v-if="isThoughtExpanded(turn)" class="turn-process-body">
                  <div v-if="turn.thoughts.length" class="turn-thoughts">
                    <p v-for="thought in turn.thoughts" :key="thought.id">
                      {{ thought.text }}<span v-if="thought.streaming" class="stream-caret" />
                    </p>
                  </div>
                  <p v-else class="turn-process-placeholder">
                    任务处理中，思考内容会在这里完整展开，也可随时收起。
                  </p>
                </div>
              </div>

              <div
                v-if="turn.answers.length"
                class="turn-answer"
                :data-streaming="turn.answers.some((item) => item.streaming) ? 'true' : 'false'"
              >
                <div class="turn-answer-avatar">
                  <Robot :size="17" weight="fill" />
                </div>
                <div class="turn-answer-body">
                  <div class="message-meta">
                    <span class="message-author">Grok Build</span>
                    <!-- 无思考的轮次把整轮耗时挂在最终回复上，保证一条指令仍只有一个计时 -->
                    <span
                      v-if="!turn.showProcess && shouldShowTurnDuration(turn)"
                      class="message-duration"
                      :data-live="turn.active || turn.streaming ? 'true' : 'false'"
                    >
                      <span
                        >{{ turn.active || turn.streaming ? '已执行' : '耗时' }}
                        {{ turnDurationText(turn) }}</span
                      >
                    </span>
                  </div>
                  <div class="turn-answer-content">
                    <p v-for="answer in turn.answers" :key="answer.id">
                      {{ answer.text }}<span v-if="answer.streaming" class="stream-caret" />
                    </p>
                  </div>
                </div>
              </div>

              <div v-if="turn.errors.length" class="turn-error">
                <div class="turn-answer-avatar" data-role="error">
                  <WarningCircle :size="17" weight="fill" />
                </div>
                <div class="turn-answer-body">
                  <div class="message-meta">
                    <span class="message-author">运行提示</span>
                  </div>
                  <div class="turn-answer-content">
                    <p v-for="error in turn.errors" :key="error.id">{{ error.text }}</p>
                  </div>
                </div>
              </div>
            </article>
          </section>
        </div>

        <footer class="composer-wrap">
          <div class="composer" :class="{ disabled: !isConnected }">
            <textarea
              ref="composer"
              v-model="prompt"
              :disabled="status.state !== 'ready' || !promptCapability.available"
              :aria-describedby="promptCapabilityMessage ? 'prompt-capability-message' : undefined"
              rows="1"
              placeholder="让 Grok Build 阅读、修改或验证这个项目"
              @keydown="handleComposerKeydown"
            />
            <div class="composer-footer">
              <div class="composer-context">
                <ModelSelector
                  :model="currentModel"
                  :load-models="loadSavedModels"
                  :select-model="selectProviderModel"
                  :busy="isBusy"
                  :disabled="!providerSummary?.configured"
                  @changed="handleModelChanged"
                  @error="handleModelError"
                />
                <span class="composer-shortcuts">
                  <kbd>Enter</kbd> 发送，<kbd>Shift Enter</kbd> 换行
                </span>
              </div>
              <button v-if="status.state === 'busy'" class="stop-button" @click="cancelTurn">
                <Stop :size="15" weight="fill" />停止
              </button>
              <button
                v-else
                class="send-button"
                :disabled="!canSend"
                :title="promptCapabilityMessage || '发送'"
                :aria-describedby="
                  promptCapabilityMessage ? 'prompt-capability-message' : undefined
                "
                @click="sendPrompt"
              >
                <PaperPlaneTilt :size="17" weight="fill" />
              </button>
            </div>
          </div>
          <p
            v-if="promptCapabilityMessage"
            id="prompt-capability-message"
            class="capability-message"
            role="status"
          >
            {{ promptCapabilityMessage }}
          </p>
        </footer>
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
      </aside>
    </div>

    <div v-if="permission" class="modal-backdrop" @click.self="respondPermission()">
      <section
        class="permission-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="permission-title"
        aria-describedby="permission-description"
      >
        <header>
          <div class="permission-icon"><ShieldCheck :size="22" weight="fill" /></div>
          <div>
            <h2 id="permission-title">需要你的确认</h2>
            <p id="permission-description">{{ permission.title }}</p>
          </div>
          <button
            class="icon-button"
            title="取消权限请求"
            aria-label="取消权限请求"
            @click="respondPermission()"
          >
            <X :size="17" />
          </button>
        </header>
        <div class="permission-options">
          <button
            v-for="option in permission.options"
            :key="option.optionId"
            :class="option.kind.startsWith('allow') ? 'primary-button' : 'secondary-button'"
            @click="respondPermission(option.optionId)"
          >
            {{ option.name }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
