<script setup lang="ts">
import { computed } from 'vue'
import { describeHistoryTruncation } from '../../../shared/task-history'
import type { TurnTimelineViewModel } from '../task-timeline-reducer'
import ConversationTurn from './ConversationTurn.vue'

const props = defineProps<{
  turn: TurnTimelineViewModel
  hasMoreEvents?: boolean
  loadingMoreEvents?: boolean
}>()
defineEmits<{ loadMoreEvents: [turnId: string] }>()

const truncationCopy = computed(() => describeHistoryTruncation(props.turn.truncationReason))
</script>

<template>
  <article class="timeline-turn" :data-turn-id="turn.turnId" :data-status="turn.status">
    <header class="timeline-turn-header">
      <span class="timeline-turn-status">{{ turn.status }}</span>
      <span v-if="turn.statusConflict" class="timeline-warning">状态冲突</span>
      <span v-if="turn.historyTruncated" class="timeline-warning" :title="truncationCopy.detail">{{
        truncationCopy.shortLabel
      }}</span>
    </header>
    <!-- 检查器只挂过程缩略，计划/工具不再输出 Tool/Plan 调试名。 -->
    <ConversationTurn
      variant="inspector"
      :turn="turn"
      :has-more-events="hasMoreEvents"
      :loading-more-events="loadingMoreEvents"
      @load-more-events="$emit('loadMoreEvents', $event)"
    />
  </article>
</template>
