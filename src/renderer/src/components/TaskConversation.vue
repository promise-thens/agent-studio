<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { TaskTimelineViewModel, TurnTimelineViewModel } from '../task-timeline-reducer'
import {
  collectTurnAssistantTexts,
  collectTurnErrorMessages,
  isActiveConversationTurn,
  isConversationPinnedToBottom,
  isTurnProcessExpandedByDefault,
  latestActiveTurnId,
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

function isProcessOpen(turn: Pick<TurnTimelineViewModel, 'turnId' | 'status'>): boolean {
  return processOpenByTurn.value[turn.turnId] ?? isTurnProcessExpandedByDefault(turn)
}

function rememberProcessOpen(turnId: string, event: Event): void {
  const target = event.currentTarget
  if (!(target instanceof HTMLDetailsElement)) return
  processOpenByTurn.value = { ...processOpenByTurn.value, [turnId]: target.open }
}

function handleScroll(): void {
  const root = messageList.value
  if (!root) return
  pinnedToBottom = isConversationPinnedToBottom(root)
}

function scrollToLatestIfPinned(): void {
  if (!pinnedToBottom) return
  const root = messageList.value
  if (!root) return
  const turnId = props.model ? latestActiveTurnId(props.model.turns) : null
  const target = turnId
    ? root.querySelector<HTMLElement>(`[data-conversation-turn-id="${CSS.escape(turnId)}"]`)
    : null
  if (target) {
    const top = Math.max(0, target.offsetTop - 12)
    root.scrollTo({ top })
    return
  }
  root.scrollTop = root.scrollHeight
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
  () => [
    props.model?.taskId,
    props.model?.turns.length,
    props.model?.turns.at(-1)?.nodes.length,
    props.model?.turns.at(-1)?.status,
    props.localErrors.length
  ],
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
