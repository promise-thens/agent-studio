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
import type { GrokAgentEvent, GrokPermissionRequest, GrokStatus } from '../../shared/grok'

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

const status = ref<GrokStatus>({ state: 'idle', message: '尚未连接 Grok Build' })
const workspace = ref('')
const prompt = ref('')
const permission = ref<GrokPermissionRequest | null>(null)
const showInspector = ref(true)
const composer = ref<HTMLTextAreaElement | null>(null)
const messageList = ref<HTMLElement | null>(null)
const planEntries = ref<Array<{ content: string; priority: string; status: string }>>([])
const toolActivities = ref<ToolActivity[]>([])
const messages = ref<ChatMessage[]>([
  {
    id: 'welcome',
    role: 'assistant',
    text: '选择一个工作目录，我会通过 ACP 连接本机的 Grok Build。'
  }
])

const cleanupListeners: Array<() => void> = []

const isConnected = computed(() => status.value.state === 'ready' || status.value.state === 'busy')
const isBusy = computed(() => status.value.state === 'busy' || status.value.state === 'connecting')
const canSend = computed(() => Boolean(prompt.value.trim()) && status.value.state === 'ready')
const workspaceName = computed(
  () => workspace.value.split('/').filter(Boolean).at(-1) ?? '未选择目录'
)
const statusLabel = computed(() => {
  const labels: Record<GrokStatus['state'], string> = {
    idle: '未连接',
    connecting: '连接中',
    ready: '已连接',
    busy: '执行中',
    error: '连接异常'
  }
  return labels[status.value.state]
})

onMounted(async () => {
  status.value = await window.grok.getStatus()
  workspace.value = status.value.workspace ?? ''

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
})

onBeforeUnmount(() => cleanupListeners.forEach((cleanup) => cleanup()))

async function chooseWorkspace(): Promise<void> {
  const selected = await window.grok.chooseWorkspace()
  if (!selected) return
  workspace.value = selected
  await connectAgent()
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

function handleComposerKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void sendPrompt()
  }
}

function handleAgentEvent(event: GrokAgentEvent): void {
  if (event.kind === 'agent-message' && event.text) {
    appendStreamChunk('assistant', event.text, event.messageId)
  } else if (event.kind === 'agent-thought' && event.text) {
    appendStreamChunk('thought', event.text, event.messageId)
  } else if (event.kind === 'tool-call' || event.kind === 'tool-update') {
    upsertToolActivity(event)
  } else if (event.kind === 'plan') {
    planEntries.value = event.entries ?? []
  } else if (event.kind === 'turn-complete') {
    const lastMessage = messages.value.at(-1)
    if (lastMessage) lastMessage.streaming = false
  }
}

function appendStreamChunk(
  role: Extract<ChatMessage['role'], 'assistant' | 'thought'>,
  text: string,
  messageId?: string
): void {
  const id = messageId ?? `${role}-stream`
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

function upsertToolActivity(event: GrokAgentEvent): void {
  const id = event.toolCallId ?? crypto.randomUUID()
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
        <span>Grok Build Desktop</span>
      </div>
      <button
        class="icon-button no-drag"
        title="切换检查器"
        @click="showInspector = !showInspector"
      >
        <SidebarSimple :size="17" />
      </button>
    </header>

    <div class="workspace-layout" :class="{ 'inspector-hidden': !showInspector }">
      <nav class="activity-rail" aria-label="主导航">
        <button class="rail-button active" title="对话">
          <ChatCircleDots :size="21" weight="fill" />
        </button>
        <button class="rail-button" title="文件"><FileCode :size="21" /></button>
        <button class="rail-button" title="终端"><TerminalWindow :size="21" /></button>
        <button class="rail-button" title="Git"><GitBranch :size="21" /></button>
        <span class="rail-spacer" />
        <button class="rail-button" title="设置"><GearSix :size="21" /></button>
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
              <span><kbd>Enter</kbd> 发送，<kbd>Shift Enter</kbd> 换行</span>
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
