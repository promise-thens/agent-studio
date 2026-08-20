<script setup lang="ts">
import type { AgentPlanEntry } from '../../../shared/agent'

defineProps<{
  entries: AgentPlanEntry[]
  active: boolean
}>()

/** 只解释步骤状态，不把 priority 画成彩灯。 */
function entryStatusLabel(status: AgentPlanEntry['status']): string {
  if (status === 'completed') return '已完成'
  if (status === 'in_progress') return '进行中'
  return '未开始'
}
</script>

<template>
  <ol class="plan-checklist" :data-active="active ? 'true' : undefined">
    <li
      v-for="(entry, index) in entries"
      :key="`${index}:${entry.content}`"
      class="plan-check-item"
      :data-status="entry.status"
    >
      <span class="plan-check-mark" aria-hidden="true" :data-status="entry.status" />
      <span class="plan-check-text">
        <span class="visually-hidden">{{ entryStatusLabel(entry.status) }}：</span>
        {{ entry.content }}
      </span>
    </li>
  </ol>
</template>
