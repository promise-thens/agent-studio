<script setup lang="ts">
import { computed } from 'vue'
import type {
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentPermissionRisk
} from '../../../shared/agent'
import {
  resolvePermissionCardKeyDecision,
  resolvePermissionCardPresentation,
  resolvePermissionEvidenceNotice,
  resolvePermissionOriginLabel,
  resolvePermissionPrimaryAction
} from '../conversation-turn-view'

const props = withDefaults(
  defineProps<{
    request: AgentPermissionRequest
    pending: boolean
    taskTitle?: string
    /** 贴在当前 Turn 上时保持紧凑；错位卡才露出「来自「任务名」」。 */
    attachedToViewedTurn?: boolean
  }>(),
  {
    taskTitle: '',
    attachedToViewedTurn: true
  }
)

const emit = defineEmits<{
  respond: [decision: AgentPermissionDecision]
  cancelTurn: []
}>()

const presentation = resolvePermissionCardPresentation()

/** 只在查看身份与审批身份不一致时露出来源，当前 Turn 上的卡不加这一行。 */
const originLabel = computed(() =>
  resolvePermissionOriginLabel({
    taskTitle: props.taskTitle,
    attachedToViewedTurn: props.attachedToViewedTurn
  })
)
const evidenceNotice = computed(() => resolvePermissionEvidenceNotice(props.request))
const describedBy = computed(() => {
  const parts = [
    originLabel.value ? 'permission-origin' : null,
    'permission-description',
    evidenceNotice.value ? 'permission-evidence' : null
  ]
  return parts.filter(Boolean).join(' ')
})

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

const compactMeta = computed(() => {
  const parts = [operationLabel.value, riskLabel.value]
  const target = props.request.targets[0]
  if (target) parts.push(target)
  if (props.request.targets.length > 1) parts.push(`等 ${props.request.targets.length} 项`)
  return parts.join(' · ')
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

/** 流内小卡仍保留停止，避免只能允许或拒绝。 */
function cancelTurn(): void {
  if (!props.pending) emit('cancelTurn')
}

/** Esc 拒绝；Enter 走主按钮。焦点在次按钮上时不抢原生激活。 */
function handleCardKeydown(event: KeyboardEvent): void {
  const target = event.target
  const targetIsNonPrimaryButton =
    target instanceof HTMLButtonElement && !target.classList.contains('primary-button')
  const decision = resolvePermissionCardKeyDecision(event, primaryAction.value.decision, {
    targetIsNonPrimaryButton
  })
  if (!decision) return
  event.preventDefault()
  respond(decision)
}
</script>

<template>
  <section
    class="permission-inline-card"
    :role="presentation.role"
    :data-variant="presentation.variant"
    :data-density="presentation.density"
    :aria-busy="pending"
    tabindex="0"
    aria-labelledby="permission-title"
    :aria-describedby="describedBy"
    @keydown="handleCardKeydown"
  >
    <p v-if="originLabel" id="permission-origin" class="permission-inline-origin">
      {{ originLabel }}
    </p>
    <p id="permission-title" class="permission-inline-title">{{ request.title }}</p>
    <p id="permission-description" class="permission-inline-meta">
      {{ compactMeta }}
    </p>
    <ul v-if="request.targets.length > 1" class="permission-inline-targets">
      <li v-for="target in request.targets" :key="target">{{ target }}</li>
    </ul>
    <p v-if="request.impact" class="permission-inline-impact">{{ request.impact }}</p>
    <p
      v-if="evidenceNotice"
      id="permission-evidence"
      class="permission-inline-warning"
      role="status"
    >
      {{ evidenceNotice }}
    </p>
    <p v-if="request.risk === 'L3'" class="permission-inline-warning" role="alert">
      高风险操作只能允许本次，请确认目标后再继续。
    </p>
    <div class="permission-inline-actions">
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
