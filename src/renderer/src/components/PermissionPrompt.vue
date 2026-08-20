<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  PhShieldCheck as ShieldCheck,
  PhWarningCircle as WarningCircle,
  PhX as X
} from '@phosphor-icons/vue'
import type {
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentPermissionRisk
} from '../../../shared/agent'
import { resolvePermissionPrimaryAction } from '../conversation-turn-view'

const props = defineProps<{
  request: AgentPermissionRequest
  pending: boolean
  taskTitle?: string
}>()

const emit = defineEmits<{
  respond: [decision: AgentPermissionDecision]
  cancelTurn: []
}>()

const riskLabel = computed(() => {
  const labels: Record<AgentPermissionRisk, string> = {
    L0: 'L0 观察',
    L1: 'L1 可恢复修改',
    L2: 'L2 明确副作用',
    L3: 'L3 高风险'
  }
  return labels[props.request.risk]
})

const operationLabel = computed(() => {
  const labels: Record<AgentPermissionRequest['operationType'], string> = {
    'read-project': '读取 Project',
    'write-file': '写入文件',
    'execute-command': '执行命令',
    'delete-path': '删除路径',
    'git-read': '读取 Git 状态',
    'git-mutate': '修改 Git 状态',
    'worktree-create': '创建 Worktree',
    'worktree-remove': '移除 Worktree',
    'network-egress': '网络外发',
    browser: '浏览器访问',
    screen: '屏幕访问',
    clipboard: '剪贴板访问',
    unknown: '未知操作'
  }
  return labels[props.request.operationType]
})

const runtimeLabel = computed(() => {
  if (props.request.initiator === 'runtime') {
    if (props.request.runtimeId === 'grok') return 'Grok Build Runtime'
    if (props.request.runtimeId === 'codex') return 'Codex Runtime'
    return 'Agent Runtime'
  }
  const labels: Record<NonNullable<AgentPermissionRequest['appService']>, string> = {
    'command-runner': 'Agent Studio Command Runner',
    git: 'Agent Studio Git',
    worktree: 'Agent Studio Worktree',
    other: 'Agent Studio'
  }
  return props.request.appService ? labels[props.request.appService] : 'Agent Studio'
})

const expiryLabel = computed(() => {
  const expiresAt = new Date(props.request.expiresAt)
  return Number.isFinite(expiresAt.getTime())
    ? expiresAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '即将过期'
})

/** 主按钮文案锁死「本任务允许」；L3 没有 task 范围时才退回仅本次。 */
const primaryAction = computed(() => resolvePermissionPrimaryAction(props.request))
const showOnceAsSecondary = computed(
  () =>
    primaryAction.value.decision === 'allow-task' && props.request.allowedScopes.includes('once')
)

function respond(decision: AgentPermissionDecision): void {
  if (!props.pending) emit('respond', decision)
}

/** 流内审批仍保留停止入口，避免用户只能允许或拒绝、看不见对话。 */
function cancelTurn(): void {
  if (!props.pending) emit('cancelTurn')
}

const dialog = ref<HTMLElement | null>(null)
const denyButton = ref<HTMLButtonElement | null>(null)
let previouslyFocused: HTMLElement | null = null

/** 审批默认聚焦安全的拒绝操作，并在切换队列头时重新建立键盘上下文。 */
async function focusSafeAction(): Promise<void> {
  await nextTick()
  if (!props.pending && denyButton.value) {
    denyButton.value.focus()
    return
  }
  dialog.value?.focus()
}

/** 流内卡片不锁 Tab，Esc 只在焦点位于本卡时拒绝，避免挡输入框。 */
function handleDialogKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  respond('deny')
}

onMounted(() => {
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  void focusSafeAction()
})

watch(
  () => props.request.approvalId,
  () => void focusSafeAction()
)

watch(
  () => props.pending,
  (pending, previous) => {
    if (!pending && previous) void focusSafeAction()
  }
)

onBeforeUnmount(() => previouslyFocused?.focus())
</script>

<template>
  <section
    ref="dialog"
    class="permission-dialog runtime-permission-dialog permission-inline-card"
    role="dialog"
    tabindex="-1"
    :aria-busy="pending"
    aria-labelledby="permission-title"
    aria-describedby="permission-description permission-impact"
    @keydown="handleDialogKeydown"
  >
    <header>
      <div class="permission-icon" :data-risk="request.risk">
        <WarningCircle v-if="request.risk === 'L3'" :size="22" weight="fill" />
        <ShieldCheck v-else :size="22" weight="fill" />
      </div>
      <div>
        <h2 id="permission-title">需要你的确认</h2>
        <p id="permission-description">{{ request.title }}</p>
      </div>
      <button
        ref="denyButton"
        class="icon-button"
        title="拒绝权限请求"
        aria-label="拒绝权限请求"
        :disabled="pending"
        @click="respond('deny')"
      >
        <X :size="17" />
      </button>
    </header>

    <div class="permission-summary">
      <div>
        <span>发起者</span>
        <strong>{{ runtimeLabel }}</strong>
      </div>
      <div>
        <span>Task</span>
        <strong :title="taskTitle || request.taskId">{{ taskTitle || request.taskId }}</strong>
      </div>
      <div>
        <span>操作</span>
        <strong>{{ operationLabel }}</strong>
      </div>
      <div>
        <span>风险</span>
        <strong :data-risk="request.risk">{{ riskLabel }}</strong>
      </div>
      <div>
        <span>有效至</span>
        <strong>{{ expiryLabel }}</strong>
      </div>
    </div>

    <div class="permission-targets">
      <strong>受限目标</strong>
      <ul>
        <li v-for="target in request.targets" :key="target" :title="target">{{ target }}</li>
      </ul>
    </div>

    <p id="permission-impact" class="permission-impact">{{ request.impact }}</p>
    <p v-if="request.risk === 'L3'" class="permission-risk-warning" role="alert">
      这是高风险或无法准确描述的操作，只能允许本次。请确认目标和影响后再继续。
    </p>

    <div class="permission-options">
      <button class="secondary-button" :disabled="pending" @click="cancelTurn">停止</button>
      <button class="secondary-button" :disabled="pending" @click="respond('deny')">
        {{ pending ? '正在提交…' : '拒绝' }}
      </button>
      <button
        v-if="showOnceAsSecondary"
        class="secondary-button"
        :disabled="pending"
        title="只允许这一次操作，不复用到当前 Task"
        @click="respond('allow-once')"
      >
        仅允许这一次
      </button>
      <button class="primary-button" :disabled="pending" @click="respond(primaryAction.decision)">
        {{ pending ? '正在提交…' : primaryAction.label }}
      </button>
    </div>
    <p v-if="pending" class="permission-submit-status" role="status" aria-live="polite">
      正在提交权限决定…
    </p>
  </section>
</template>
