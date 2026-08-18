<script setup lang="ts">
import type { TaskTimelineViewModel } from '../task-timeline-reducer'
import TurnSummaryCard from './TurnSummaryCard.vue'

defineProps<{
  model: TaskTimelineViewModel
  loading?: boolean
  eventAfterSequenceByTurn?: Record<string, number | null>
  loadingEventTurnIds?: readonly string[]
}>()

defineEmits<{
  loadMoreTurns: []
  loadMoreEvents: [turnId: string]
}>()
</script>

<template>
  <section class="execution-timeline" aria-label="执行时间线">
    <div v-if="loading" class="timeline-state" role="status" aria-live="polite">
      正在加载执行历史…
    </div>
    <div v-else-if="!model.turns.length" class="timeline-state">暂无执行记录</div>
    <template v-else>
      <TurnSummaryCard
        v-for="turn in model.turns"
        :key="`${turn.taskId}:${turn.turnId}`"
        :turn="turn"
        :has-more-events="eventAfterSequenceByTurn?.[turn.turnId] != null"
        :loading-more-events="loadingEventTurnIds?.includes(turn.turnId) ?? false"
        @load-more-events="$emit('loadMoreEvents', $event)"
      />
    </template>
  </section>
</template>
