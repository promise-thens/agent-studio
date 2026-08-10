<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  PhArrowClockwise as ArrowClockwise,
  PhCaretRight as CaretRight,
  PhChatCircleDots as ChatCircleDots,
  PhCheckCircle as CheckCircle,
  PhCircleNotch as CircleNotch,
  PhCode as Code,
  PhFileCode as FileCode,
  PhFolderOpen as FolderOpen,
  PhGearSix as GearSix,
  PhGitBranch as GitBranch,
  PhMagnifyingGlass as MagnifyingGlass,
  PhPaperPlaneTilt as PaperPlaneTilt,
  PhPlus as Plus,
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

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'thought' | 'error'
  text: string
  streaming?: boolean
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
const planEntries = ref<AgentPlanEntry[]>([])
const toolActivities = ref<ToolActivity[]>([])
const messages = ref<ChatMessage[]>([
  {
    id: 'welcome',
    role: 'assistant',
    text: '选择一个工作目录，我会通过当前模型配置启动 Grok Build Runtime。'
  }
])

const cleanupListeners: Array<() => void> = []
const acceptAgentEvent = createAgentEventGuard()

const isConnected = computed(() => status.value.state === 'ready' || status.value.state === 'busy')
const isBusy = computed(() => status.value.state === 'busy' || status.value.state === 'connecting')
const canSend = computed(() => Boolean(prompt.value.trim()) && status.value.state === 'ready')
const workspaceName = computed(
  () => workspace.value.split('/').filter(Boolean).at(-1) ?? '未选择目录'
)
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

onBeforeUnmount(() => cleanupListeners.forEach((cleanup) => cleanup()))

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
  appendMessage('user', text)
  await nextTick()
  composer.value?.focus()

  try {
    await window.grok.sendPrompt(text)
  } catch (error) {
    appendMessage('error', error instanceof Error ? error.message : String(error))
  }
}

async function cancelTurn(): Promise<void> {
  await window.grok.cancel()
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
    const lastMessage = messages.value.at(-1)
    if (lastMessage) lastMessage.streaming = false
  } else if (event.kind === 'error') {
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
  } else {
    messages.value.push({ id, role, text, streaming: true })
  }
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
    if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight
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
      <nav class="activity-rail" aria-label="主导航">
        <button class="rail-button active" title="对话">
          <ChatCircleDots :size="21" weight="fill" />
        </button>
        <button class="rail-button" title="文件"><FileCode :size="21" /></button>
        <button class="rail-button" title="终端"><TerminalWindow :size="21" /></button>
        <button class="rail-button" title="Git"><GitBranch :size="21" /></button>
        <span class="rail-spacer" />
        <button class="rail-button" title="设置" @click="openProviderSettings">
          <GearSix :size="21" />
        </button>
      </nav>

      <aside class="session-sidebar">
        <div class="sidebar-header">
          <strong>会话</strong>
          <button class="icon-button" title="新建会话"><Plus :size="16" /></button>
        </div>

        <label class="search-field">
          <MagnifyingGlass :size="15" />
          <input aria-label="搜索会话" placeholder="搜索会话" />
        </label>

        <button class="session-item active">
          <span class="session-icon"><Code :size="16" /></span>
          <span class="session-copy">
            <strong>新会话</strong>
            <small>{{ workspaceName }}</small>
          </span>
          <CaretRight :size="14" />
        </button>

        <div class="workspace-card">
          <div class="workspace-card-copy">
            <FolderOpen :size="17" />
            <div>
              <strong>{{ workspaceName }}</strong>
              <small>{{ workspace || '选择项目目录后开始工作' }}</small>
            </div>
          </div>
          <button class="secondary-button" @click="chooseWorkspace">选择目录</button>
        </div>
      </aside>

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

        <section ref="messageList" class="message-list" aria-live="polite">
          <article
            v-for="message in messages"
            :key="message.id"
            class="message"
            :data-role="message.role"
          >
            <div class="message-avatar">
              <Robot v-if="message.role === 'assistant'" :size="17" weight="fill" />
              <Code v-else-if="message.role === 'thought'" :size="17" />
              <WarningCircle v-else-if="message.role === 'error'" :size="17" weight="fill" />
              <span v-else>你</span>
            </div>
            <div class="message-body">
              <span class="message-author">
                {{
                  message.role === 'user'
                    ? '你'
                    : message.role === 'thought'
                      ? '思考过程'
                      : message.role === 'error'
                        ? '运行提示'
                        : 'Grok Build'
                }}
              </span>
              <p>{{ message.text }}</p>
              <span v-if="message.streaming" class="stream-caret" />
            </div>
          </article>
        </section>

        <footer class="composer-wrap">
          <div class="composer" :class="{ disabled: !isConnected }">
            <textarea
              ref="composer"
              v-model="prompt"
              :disabled="!isConnected || isBusy"
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
                title="发送"
                @click="sendPrompt"
              >
                <PaperPlaneTilt :size="17" weight="fill" />
              </button>
            </div>
          </div>
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
          <div v-else class="empty-state">
            <ShieldCheck :size="24" />
            <p>复杂任务开始后，计划会显示在这里。</p>
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
          <div v-else class="empty-state compact">
            <TerminalWindow :size="22" />
            <p>工具调用和文件操作会实时出现。</p>
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
      >
        <header>
          <div class="permission-icon"><ShieldCheck :size="22" weight="fill" /></div>
          <div>
            <h2 id="permission-title">需要你的确认</h2>
            <p>{{ permission.title }}</p>
          </div>
          <button class="icon-button" title="取消" @click="respondPermission()">
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
