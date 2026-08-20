<script setup lang="ts">
import { computed } from 'vue'
import type {
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentPermissionRisk
} from '../../../shared/agent'
import {
  resolvePermissionCardPresentation,
  resolvePermissionPrimaryAction
} from '../conversation-turn-view'

const props = defineProps<{
  request: AgentPermissionRequest
  pending: boolean
  taskTitle?: string
}>()

const emit = defineEmits<{
  respond: [decision: AgentPermissionDecision]
  cancelTurn: []
}>()

const presentation = resolvePermissionCardPresentation()

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

/** Esc 只在焦点位于本卡时拒绝，不锁 Tab，也不在挂载时抢焦点。 */
function handleCardKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  respond('deny')
}
</script>

<template>
  <section
    class="permission-inline-card"
    :role="presentation.role"
    :data-variant="presentation.variant"
    :data-density="presentation.density"
    :aria-busy="pending"
    aria-labelledby="permission-title"
    aria-describedby="permission-description"
    @keydown="handleCardKeydown"
  >
    <p id="permission-title" class="permission-inline-title">{{ request.title }}</p>
    <p id="permission-description" class="permission-inline-meta" :title="taskTitle">
      {{ compactMeta }}
    </p>
    <p v-if="request.impact" class="permission-inline-impact">{{ request.impact }}</p>
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
