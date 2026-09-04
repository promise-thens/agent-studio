<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AgentPermissionDecision, AgentPermissionRequest } from '../../../shared/agent'
import type { AgentQuestionRequest } from '../../../shared/agent-question'
import type { AgentRespondQuestionRequest } from '../../../shared/agent-ipc'
import type { ComposerPlanMode } from '../../../shared/session-plan-mode'
import {
  resolveConversationPlanEmptyClass,
  resolveConversationPlanEmptyCopy
} from '../conversation-plan-empty'
import type { TaskTimelineViewModel, TurnTimelineViewModel } from '../task-timeline-reducer'
import {
  conversationFollowSignature,
  isActiveConversationTurn,
  isConversationPinnedToBottom,
  nextConversationPinnedState,
  nextConversationScrollIntent,
  nextPinnedConversationScrollTop,
  nextProgrammaticFollowFlag,
  resolveConversationEmptyCopy,
  resolveConversationScrollSource,
  resolveConversationStickyQuestion,
  shouldHoldPinnedFollow,
  type ConversationConnectFailure,
  type ConversationScrollIntent,
  type ConversationScrollInteraction
} from '../task-conversation-view'
import type { ChangeCardView } from '../task-changes-presentation'
import ConversationTurn from './ConversationTurn.vue'
import PermissionPrompt from './PermissionPrompt.vue'
import QuestionPrompt from './QuestionPrompt.vue'
import TaskChangeCard from './TaskChangeCard.vue'

const props = withDefaults(
  defineProps<{
    conversationKey: string
    model: TaskTimelineViewModel | null
    loading?: boolean
    hasMoreTurns?: boolean
    loadingMoreTurns?: boolean
    eventAfterSequenceByTurn?: Record<string, number | null>
    loadingEventTurnIds?: readonly string[]
    localErrors?: readonly string[]
    connectFailure?: ConversationConnectFailure | null
    permission?: AgentPermissionRequest | null
    permissionPending?: boolean
    permissionTaskTitle?: string
    question?: AgentQuestionRequest | null
    questionPending?: boolean
    changeCard?: ChangeCardView | null
    restoreBusy?: boolean
    planMode?: ComposerPlanMode
    /** App 共享时钟，用来刷新活动 Turn 的耗时。 */
    clockTick?: number
  }>(),
  {
    loading: false,
    hasMoreTurns: false,
    loadingMoreTurns: false,
    localErrors: () => [],
    connectFailure: null,
    permission: null,
    permissionPending: false,
    permissionTaskTitle: '',
    question: null,
    questionPending: false,
    changeCard: null,
    restoreBusy: false,
    planMode: 'normal',
    clockTick: 0
  }
)

defineEmits<{
  loadMoreTurns: []
  loadMoreEvents: [turnId: string]
  retryConnect: []
  respondPermission: [decision: AgentPermissionDecision]
  respondQuestion: [request: AgentRespondQuestionRequest]
  cancelTurn: []
  reviewChanges: []
  restoreChanges: []
  reviewFile: [path: string]
  openPlan: [turnId: string]
}>()

const messageList = ref<HTMLElement | null>(null)
/** 用户离开底部后不再抢滚动；切 Task 时重新贴底。 */
let pinnedToBottom = true
/** wheel/touchmove 预告用户滚动；pointerdown 只跟踪拖条，不得武装 pending。 */
let scrollIntent: ConversationScrollIntent = {
  pendingUserScroll: false,
  pointerTracking: false
}
/** 仅 scrollToLatestIfPinned 写入 scrollTop 时为 true，避免把跟随当成用户上翻。 */
let programmaticFollow = false
/** 已预告但未产生 scroll 时，用双 rAF 解除 pending，避免冻住贴底。 */
let pendingUserScrollIdleId = 0

/** 只把队首审批插进对应 Turn，避免每轮都复制一张权限卡。 */
function permissionForTurn(
  turn: Pick<TurnTimelineViewModel, 'taskId' | 'turnId'>
): AgentPermissionRequest | null {
  const request = props.permission
  if (!request) return null
  return request.taskId === turn.taskId && request.turnId === turn.turnId ? request : null
}

/** 当前对话底部固定展示问答卡，避免只挂在已滚出视野的历史 Turn。 */
const stickyQuestion = computed(() =>
  resolveConversationStickyQuestion({
    question: props.question,
    taskId: props.model?.taskId
  })
)

/** 审批 Turn 还不在当前流里时，仍把卡挂在底部，并标「来自」以免当成当前对话的请求。 */
const unmatchedPermission = computed(() => {
  const request = props.permission
  if (!request) return null
  const matched = (props.model?.turns ?? []).some(
    (turn) => turn.taskId === request.taskId && turn.turnId === request.turnId
  )
  return matched ? null : request
})

/** 空态只投影 UI，不写 Timeline；有 plan 节点时交给 PlanChecklist。 */
const planEmptyCopy = computed(() =>
  resolveConversationPlanEmptyCopy({
    planMode: props.planMode ?? 'normal',
    model: props.model,
    loading: props.loading
  })
)
/** 已有 Turn 时不用满高空态，避免把等待计划的句子撑满剩余视口。 */
const planEmptyClass = computed(() =>
  resolveConversationPlanEmptyClass(Boolean(props.model?.turns.length))
)

function applyPinSource(source: 'user-input' | 'layout-scroll'): void {
  const root = messageList.value
  if (!root) return
  pinnedToBottom = nextConversationPinnedState({
    pinned: pinnedToBottom,
    source,
    nearBottom: isConversationPinnedToBottom(root)
  })
}

function applyScrollIntent(interaction: ConversationScrollInteraction): ConversationScrollIntent {
  scrollIntent = nextConversationScrollIntent(scrollIntent, interaction)
  return scrollIntent
}

function cancelPendingUserScrollIdle(): void {
  if (pendingUserScrollIdleId === 0) return
  cancelAnimationFrame(pendingUserScrollIdleId)
  pendingUserScrollIdleId = 0
}

/** 双 rAF：同步 overflow scroll 会先到 handleScroll；到第二帧仍无 scroll 则放行贴底。 */
function schedulePendingUserScrollIdle(): void {
  cancelPendingUserScrollIdle()
  pendingUserScrollIdleId = requestAnimationFrame(() => {
    pendingUserScrollIdleId = requestAnimationFrame(() => {
      pendingUserScrollIdleId = 0
      if (!scrollIntent.pendingUserScroll) return
      applyScrollIntent('pending-idle')
      applyPinSource('user-input')
      scrollToLatestIfPinned()
    })
  })
}

function markNextScrollAsUserInput(): void {
  applyScrollIntent('wheel')
  schedulePendingUserScrollIdle()
}

function handlePointerDown(): void {
  applyScrollIntent('pointerdown')
}

function handlePointerUp(): void {
  applyScrollIntent('pointerup')
}

onMounted(() => {
  window.addEventListener('pointerup', handlePointerUp)
  window.addEventListener('pointercancel', handlePointerUp)
})

onBeforeUnmount(() => {
  cancelPendingUserScrollIdle()
  window.removeEventListener('pointerup', handlePointerUp)
  window.removeEventListener('pointercancel', handlePointerUp)
})

function handleScroll(): void {
  cancelPendingUserScrollIdle()
  const source = resolveConversationScrollSource({
    pendingUserScroll: scrollIntent.pendingUserScroll || scrollIntent.pointerTracking,
    programmaticFollow
  })
  applyScrollIntent('scroll')
  programmaticFollow = false
  applyPinSource(source)
}

function scrollToLatestIfPinned(): void {
  const root = messageList.value
  if (!root) return
  if (shouldHoldPinnedFollow(scrollIntent)) return
  const nextTop = nextPinnedConversationScrollTop(root, pinnedToBottom)
  if (nextTop == null) return
  const previousTop = root.scrollTop
  // 先按是否位移武装，避免同步 scroll 在赋值期间被当成用户翻页。
  programmaticFollow = previousTop !== nextTop
  root.scrollTop = nextTop
  programmaticFollow = nextProgrammaticFollowFlag({
    previousTop,
    nextTop,
    assignedTop: root.scrollTop
  })
}

watch(
  () => props.conversationKey,
  () => {
    pinnedToBottom = true
    cancelPendingUserScrollIdle()
    scrollIntent = { pendingUserScroll: false, pointerTracking: scrollIntent.pointerTracking }
    programmaticFollow = false
    void nextTick(scrollToLatestIfPinned)
  }
)

watch(
  () =>
    `${conversationFollowSignature(props.model, props.localErrors)}:${props.permission?.approvalId ?? ''}:${props.question?.questionId ?? ''}`,
  () => {
    void nextTick(scrollToLatestIfPinned)
  }
)
</script>

<template>
  <section
    ref="messageList"
    class="message-list task-conversation"
    aria-live="polite"
    @wheel.passive="markNextScrollAsUserInput"
    @touchmove.passive="markNextScrollAsUserInput"
    @pointerdown="handlePointerDown"
    @pointerup="handlePointerUp"
    @pointercancel="handlePointerUp"
    @scroll.passive="handleScroll"
  >
    <button
      v-if="hasMoreTurns"
      class="history-load-more"
      type="button"
      :disabled="loadingMoreTurns"
      :aria-busy="loadingMoreTurns"
      @click="$emit('loadMoreTurns')"
    >
      {{ loadingMoreTurns ? '正在加载…' : '加载更早轮次' }}
    </button>

    <div v-if="loading && !model?.turns.length" class="conversation-empty" role="status">
      正在加载对话…
    </div>
    <div v-else-if="!model?.turns.length && !planEmptyCopy" class="conversation-empty">
      {{ resolveConversationEmptyCopy(Boolean(model?.turns.length)) }}
    </div>

    <article
      v-for="(turn, index) in model?.turns ?? []"
      :key="`${turn.taskId}:${turn.turnId}`"
      class="conversation-turn"
      :data-conversation-turn-id="turn.turnId"
      :data-active="isActiveConversationTurn(turn) ? 'true' : undefined"
    >
      <ConversationTurn
        :turn="turn"
        :active="isActiveConversationTurn(turn)"
        :permission="permissionForTurn(turn)"
        :permission-pending="permissionPending"
        :permission-task-title="permissionTaskTitle"
        :question-pending="questionPending"
        :has-pending-question="Boolean(stickyQuestion)"
        :has-more-events="eventAfterSequenceByTurn?.[turn.turnId] != null"
        :loading-more-events="loadingEventTurnIds?.includes(turn.turnId) ?? false"
        :clock-tick="clockTick"
        @respond-permission="$emit('respondPermission', $event)"
        @respond-question="$emit('respondQuestion', $event)"
        @cancel-turn="$emit('cancelTurn')"
        @load-more-events="$emit('loadMoreEvents', $event)"
        @open-plan="$emit('openPlan', $event)"
      />

      <TaskChangeCard
        v-if="changeCard && index === (model?.turns.length ?? 0) - 1"
        :task-id="turn.taskId"
        :model="changeCard"
        :restore-busy="restoreBusy"
        @review="$emit('reviewChanges')"
        @restore="$emit('restoreChanges')"
        @review-file="$emit('reviewFile', $event)"
      />
    </article>

    <div v-if="unmatchedPermission" class="conversation-turn">
      <PermissionPrompt
        :key="`${unmatchedPermission.approvalId}:${unmatchedPermission.taskId}:${unmatchedPermission.turnId}`"
        :request="unmatchedPermission"
        :pending="permissionPending"
        :task-title="permissionTaskTitle"
        :attached-to-viewed-turn="false"
        @respond="$emit('respondPermission', $event)"
        @cancel-turn="$emit('cancelTurn')"
      />
    </div>

    <div v-if="stickyQuestion" class="conversation-turn">
      <QuestionPrompt
        :key="stickyQuestion.questionId"
        :request="stickyQuestion"
        :pending="questionPending"
        @respond="$emit('respondQuestion', $event)"
      />
    </div>

    <div v-if="planEmptyCopy" :class="planEmptyClass" role="status">
      {{ planEmptyCopy }}
    </div>

    <p
      v-for="(message, index) in localErrors"
      :key="`local-error:${index}:${message}`"
      class="conversation-error conversation-local-error"
      role="status"
    >
      {{ message }}
    </p>

    <div
      v-if="connectFailure && (connectFailure.message || connectFailure.canRetry)"
      class="conversation-connect-failure"
    >
      <p v-if="connectFailure.message" class="conversation-error" role="status">
        {{ connectFailure.message }}
      </p>
      <button
        v-if="connectFailure.canRetry"
        class="conversation-retry"
        type="button"
        title="重新连接 Runtime"
        aria-label="重新连接 Runtime"
        @click="$emit('retryConnect')"
      >
        {{ connectFailure.retryLabel }}
      </button>
    </div>
  </section>
</template>
