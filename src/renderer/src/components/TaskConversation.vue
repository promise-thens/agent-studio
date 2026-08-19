<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { TaskTimelineViewModel, TurnTimelineViewModel } from '../task-timeline-reducer'
import {
  collectTurnAssistantTexts,
  collectTurnErrorMessages,
  conversationFollowSignature,
  isActiveConversationTurn,
  isConversationPinnedToBottom,
  isTurnProcessExpandedByDefault,
  nextConversationPinnedState,
  nextPinnedConversationScrollTop,
  timelineModelForTurn,
  turnHasCollapsibleProcess
} from '../task-conversation-view'
import ExecutionTimeline from './ExecutionTimeline.vue'
import TaskResultReview from './TaskResultReview.vue'

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
    canCreateTask?: boolean
  }>(),
  {
    loading: false,
    hasMoreTurns: false,
    loadingMoreTurns: false,
    localErrors: () => [],
    canCreateTask: false
  }
)

defineEmits<{
  loadMoreTurns: []
  loadMoreEvents: [turnId: string]
  createTask: []
}>()

const messageList = ref<HTMLElement | null>(null)
const processOpenByTurn = ref<Record<string, boolean>>({})
/** 用户离开底部后不再抢滚动；切 Task 时重新贴底。 */
let pinnedToBottom = true
/** 指针按住时把随后的 scroll 当成用户拖条，而不是内容增高。 */
let pointerTracking = false

function isProcessOpen(turn: Pick<TurnTimelineViewModel, 'turnId' | 'status'>): boolean {
  return processOpenByTurn.value[turn.turnId] ?? isTurnProcessExpandedByDefault(turn)
}

function rememberProcessOpen(turnId: string, event: Event): void {
  const target = event.currentTarget
  if (!(target instanceof HTMLDetailsElement)) return
  processOpenByTurn.value = { ...processOpenByTurn.value, [turnId]: target.open }
}

function applyPinSource(source: 'user-input' | 'layout-scroll'): void {
  const root = messageList.value
  if (!root) return
  pinnedToBottom = nextConversationPinnedState({
    pinned: pinnedToBottom,
    source,
    nearBottom: isConversationPinnedToBottom(root)
  })
}

function handleUserScrollIntent(): void {
  applyPinSource('user-input')
}

function handlePointerDown(): void {
  pointerTracking = true
}

function handlePointerUp(): void {
  pointerTracking = false
}

onMounted(() => {
  window.addEventListener('pointerup', handlePointerUp)
  window.addEventListener('pointercancel', handlePointerUp)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerup', handlePointerUp)
  window.removeEventListener('pointercancel', handlePointerUp)
})

function handleScroll(): void {
  applyPinSource(pointerTracking ? 'user-input' : 'layout-scroll')
}

function scrollToLatestIfPinned(): void {
  const root = messageList.value
  if (!root) return
  const nextTop = nextPinnedConversationScrollTop(root, pinnedToBottom)
  if (nextTop == null) return
  root.scrollTop = nextTop
}

watch(
  () => props.conversationKey,
  () => {
    pinnedToBottom = true
    processOpenByTurn.value = {}
    void nextTick(scrollToLatestIfPinned)
  }
)

watch(
  () => conversationFollowSignature(props.model, props.localErrors),
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
    @wheel.passive="handleUserScrollIntent"
    @touchmove.passive="handleUserScrollIntent"
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
    <div v-else-if="!model?.turns.length" class="conversation-empty">
      从下面输入第一条消息，开始这一轮对话。
    </div>

    <article
      v-for="(turn, index) in model?.turns ?? []"
      :key="`${turn.taskId}:${turn.turnId}`"
      class="conversation-turn"
      :data-conversation-turn-id="turn.turnId"
      :data-active="isActiveConversationTurn(turn) ? 'true' : undefined"
    >
      <div class="conversation-user">
        <p>{{ turn.prompt }}</p>
      </div>

      <details
        v-if="model && turnHasCollapsibleProcess(turn)"
        class="conversation-process"
        :open="isProcessOpen(turn)"
        @toggle="rememberProcessOpen(turn.turnId, $event)"
      >
        <summary>执行过程</summary>
        <ExecutionTimeline
          :model="timelineModelForTurn(model, turn)"
          :event-after-sequence-by-turn="eventAfterSequenceByTurn"
          :loading-event-turn-ids="loadingEventTurnIds"
          @load-more-events="$emit('loadMoreEvents', $event)"
        />
      </details>

      <div
        v-for="(text, answerIndex) in collectTurnAssistantTexts(turn)"
        :key="`${turn.turnId}:answer:${answerIndex}`"
        class="conversation-assistant"
      >
        <p>{{ text }}</p>
      </div>

      <p
        v-for="(message, errorIndex) in collectTurnErrorMessages(turn)"
        :key="`${turn.turnId}:error:${errorIndex}`"
        class="conversation-error"
        role="status"
      >
        {{ message }}
      </p>

      <TaskResultReview
        v-if="model && index === model.turns.length - 1"
        :model="model.resultReview"
        :can-resume="false"
        :can-create-task="canCreateTask"
        @create-task="$emit('createTask')"
      />
    </article>

    <p
      v-for="(message, index) in localErrors"
      :key="`local-error:${index}:${message}`"
      class="conversation-error conversation-local-error"
      role="status"
    >
      {{ message }}
    </p>
  </section>
</template>
