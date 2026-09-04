<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AgentPermissionDecision, AgentPermissionRequest } from '../../../shared/agent'
import type { AgentQuestionRequest } from '../../../shared/agent-question'
import type { AgentRespondQuestionRequest } from '../../../shared/agent-ipc'
import { shouldMountSubagentCard } from '../conversation-subagent-view'
import {
  formatToolVerbPhrase,
  projectConversationTurn,
  type ConversationToolBlock
} from '../conversation-turn-view'
import type { TurnTimelineViewModel } from '../task-timeline-reducer'
import {
  conversationStatusLabel,
  conversationTurnDurationMs,
  formatConversationActivityAge,
  formatConversationDuration,
  isConversationWaitingForEvent,
  resolveConversationActivityHint,
  resolveConversationStep,
  turnLastActivityAt
} from '../conversation-progress'
import AssistantMarkdown from './AssistantMarkdown.vue'
import ConversationMedia from './ConversationMedia.vue'
import PermissionPrompt from './PermissionPrompt.vue'
import QuestionPrompt from './QuestionPrompt.vue'
import PlanChecklist from './PlanChecklist.vue'
import SubagentCard from './SubagentCard.vue'
import ToolRow from './ToolRow.vue'

const props = withDefaults(
  defineProps<{
    turn: TurnTimelineViewModel
    variant?: 'conversation' | 'inspector'
    permission?: AgentPermissionRequest | null
    permissionPending?: boolean
    permissionTaskTitle?: string
    question?: AgentQuestionRequest | null
    questionPending?: boolean
    /** 问答卡贴底展示时仍要让当前 Turn 元信息显示“等待你的回答”。 */
    hasPendingQuestion?: boolean
    active?: boolean
    hasMoreEvents?: boolean
    loadingMoreEvents?: boolean
    /** App 共享时钟；只用于活动 Turn 的实时耗时与事件静默提示。 */
    clockTick?: number
  }>(),
  {
    variant: 'conversation',
    permission: null,
    permissionPending: false,
    permissionTaskTitle: '',
    question: null,
    questionPending: false,
    hasPendingQuestion: false,
    active: false,
    hasMoreEvents: false,
    loadingMoreEvents: false,
    clockTick: 0
  }
)

defineEmits<{
  respondPermission: [decision: AgentPermissionDecision]
  respondQuestion: [request: AgentRespondQuestionRequest]
  cancelTurn: []
  loadMoreEvents: [turnId: string]
  openPlan: [turnId: string]
}>()

/** 主列走完整对话块；检查器只留过程缩略，避免再当主界面。 */
const blocks = computed(() => {
  let projected = projectConversationTurn(props.turn, {
    pendingPermission: props.variant === 'conversation' ? props.permission : null
  })
  if (props.variant === 'conversation') {
    // 对话主列不重复展示上下文用量，完整详情由 Composer 圆环按需提供。
    projected = projected.filter((block) => block.kind !== 'usage')
  }
  if (props.variant !== 'inspector') return projected
  return projected.filter(
    (block) =>
      block.kind !== 'user' &&
      block.kind !== 'message' &&
      block.kind !== 'attachment' &&
      block.kind !== 'permission' &&
      block.kind !== 'plan'
  )
})

const localClockTick = ref(props.clockTick || Date.now())
let localClockTimer: ReturnType<typeof setInterval> | null = null

/** 当前对话组件独立兜底时钟，避免历史回放依赖 App 的旧消息计时状态。 */
function syncLocalClock(): void {
  const shouldTick =
    props.active && !['completed', 'failed', 'cancelled', 'interrupted'].includes(props.turn.status)
  if (shouldTick && !localClockTimer) {
    localClockTimer = setInterval(() => {
      localClockTick.value = Date.now()
    }, 500)
    return
  }
  if (!shouldTick && localClockTimer) {
    clearInterval(localClockTimer)
    localClockTimer = null
  }
}

onMounted(syncLocalClock)
onBeforeUnmount(() => {
  if (localClockTimer) clearInterval(localClockTimer)
})

watch(
  () => [props.active, props.turn.status, props.clockTick] as const,
  ([active, status, clockTick]) => {
    if (clockTick) localClockTick.value = clockTick
    void active
    void status
    syncLocalClock()
  }
)

const effectiveClockTick = computed(() => props.clockTick || localClockTick.value)
const elapsedLabel = computed(() => {
  const duration = conversationTurnDurationMs(props.turn, effectiveClockTick.value)
  return duration == null ? '耗时未知' : formatConversationDuration(duration)
})
const activityAgeLabel = computed(() =>
  formatConversationActivityAge(turnLastActivityAt(props.turn), effectiveClockTick.value)
)
const currentStepLabel = computed(() => resolveConversationStep(props.turn.nodes))
const waitingForEvent = computed(() =>
  isConversationWaitingForEvent(props.turn, effectiveClockTick.value)
)
const activityHint = computed(() =>
  resolveConversationActivityHint({
    waitingForEvent: waitingForEvent.value,
    hasPendingQuestion: Boolean(props.question) || props.hasPendingQuestion,
    currentStepLabel: currentStepLabel.value
  })
)
const activeThoughtNodeId = computed(
  () => [...props.turn.nodes].reverse().find((node) => node.kind === 'thought')?.nodeId
)
const statusLabel = computed(() => conversationStatusLabel(props.turn.status))

function mergedReadFiles(block: ConversationToolBlock): string[] {
  if (!block.mergedReadCount || block.mergedReadCount < 2) return []
  return block.tools.map((item) => formatToolVerbPhrase(item.title).replace(/^读了\s+/, ''))
}
</script>

<template>
  <div class="conversation-blocks" :data-variant="variant">
    <header
      v-if="variant === 'conversation'"
      class="conversation-turn-meta"
      :data-status="turn.status"
      :data-waiting="waitingForEvent ? 'true' : undefined"
      role="status"
      aria-live="polite"
    >
      <div class="conversation-turn-meta-main">
        <span class="conversation-turn-meta-dot" aria-hidden="true" />
        <strong>{{ statusLabel }}</strong>
        <span class="conversation-turn-meta-duration">{{ elapsedLabel }}</span>
        <span class="conversation-turn-meta-step">
          {{ activityHint }}
        </span>
      </div>
      <div class="conversation-turn-meta-subline">
        <span>{{ activityAgeLabel }}</span>
        <span v-if="turn.statusConflict" class="conversation-turn-meta-warning">状态冲突</span>
        <span v-if="turn.historyTruncated" class="conversation-turn-meta-warning">历史已截断</span>
      </div>
    </header>

    <template v-for="block in blocks" :key="block.nodeId">
      <div v-if="block.kind === 'user'" class="conversation-user" data-kind="user">
        <p v-if="block.text">{{ block.text }}</p>
        <ConversationMedia
          v-if="block.taskId && block.attachmentIds?.length"
          :task-id="block.taskId"
          :attachment-ids="block.attachmentIds"
          variant="user"
        />
      </div>

      <div
        v-else-if="block.kind === 'attachment'"
        class="conversation-assistant-media"
        data-kind="attachment"
      >
        <ConversationMedia
          :task-id="block.taskId"
          :attachment-ids="block.attachmentIds"
          variant="assistant"
        />
      </div>

      <details
        v-else-if="block.kind === 'thought'"
        class="conversation-thought conversation-process-step"
        data-kind="thought"
        data-process-kind="thought"
        :data-status="active && block.nodeId === activeThoughtNodeId ? 'running' : undefined"
      >
        <summary>
          <span class="conversation-process-caret" aria-hidden="true" />
          <span class="conversation-process-label">{{ block.summary }}</span>
        </summary>
        <p class="conversation-thought-body">{{ block.text }}</p>
      </details>

      <details
        v-else-if="block.kind === 'plan'"
        class="conversation-plan conversation-process-step"
        data-kind="plan"
        data-process-kind="plan"
        :open="block.defaultExpanded"
      >
        <summary title="在检查器中查看完整计划" @click="$emit('openPlan', turn.turnId)">
          <span class="conversation-process-caret" aria-hidden="true" />
          <span class="conversation-process-label">{{ block.summary }}</span>
          <span class="conversation-plan-open-hint">查看完整计划</span>
        </summary>
        <PlanChecklist :entries="block.entries" :active="block.defaultExpanded" />
      </details>

      <ToolRow
        v-else-if="block.kind === 'tool'"
        class="conversation-process-step"
        data-process-kind="tool"
        :label="block.label"
        :status="block.status"
        :files="mergedReadFiles(block)"
        :detail="block.detail"
        :warning="block.warning"
      />

      <SubagentCard
        v-else-if="block.kind === 'subagent' && shouldMountSubagentCard(block)"
        class="conversation-process-step"
        data-process-kind="subagent"
        :task-id="turn.taskId"
        :name="block.name"
        :agent-type="block.agentType"
        :short-id="block.shortId"
        :status="block.status"
        :tools="block.tools"
        :duration-label="block.durationLabel"
        :grouping-note="block.groupingNote"
      />

      <div v-else-if="block.kind === 'message'" class="conversation-assistant" data-kind="message">
        <AssistantMarkdown :text="block.text" />
      </div>

      <p
        v-else-if="block.kind === 'error'"
        class="conversation-error"
        data-kind="error"
        role="status"
      >
        {{ block.message }}
      </p>

      <div
        v-else-if="block.kind === 'permission-audit'"
        class="conversation-permission-audit conversation-process-step"
        data-kind="permission-audit"
        data-process-kind="permission-audit"
      >
        <span class="conversation-process-label">{{ block.summary }}</span>
      </div>

      <PermissionPrompt
        v-else-if="block.kind === 'permission'"
        :request="block.request"
        :pending="permissionPending"
        :task-title="permissionTaskTitle"
        @respond="$emit('respondPermission', $event)"
        @cancel-turn="$emit('cancelTurn')"
      />

      <details
        v-else-if="block.kind === 'usage'"
        class="conversation-usage conversation-process-step"
        data-kind="usage"
        data-process-kind="usage"
      >
        <summary>
          <span class="conversation-process-caret" aria-hidden="true" />
          <span class="conversation-process-label">{{ block.summary }}</span>
        </summary>
      </details>

      <p
        v-else-if="block.kind === 'availability'"
        class="conversation-availability"
        data-kind="availability"
        role="status"
      >
        {{ block.message }}
      </p>
    </template>
    <QuestionPrompt
      v-if="variant === 'conversation' && question"
      :request="question"
      :pending="questionPending"
      @respond="$emit('respondQuestion', $event)"
    />
  </div>
</template>
