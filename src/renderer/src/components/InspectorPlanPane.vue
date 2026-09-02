<script setup lang="ts">
import { computed } from 'vue'
import type { TaskTimelineViewModel } from '../task-timeline-reducer'
import { projectInspectorPlan } from '../task-inspector'
import PlanChecklist from './PlanChecklist.vue'

const props = withDefaults(
  defineProps<{
    timeline: TaskTimelineViewModel | null
    focusTurnId?: string | null
  }>(),
  {
    focusTurnId: null
  }
)

/** 计划标签只消费 Timeline reducer 的公开快照，不再从对话状态复制一份清单。 */
const inspectorPlan = computed(() => projectInspectorPlan(props.timeline, props.focusTurnId))
</script>

<template>
  <section v-if="inspectorPlan" class="inspector-section inspector-plan-section">
    <div class="inspector-heading">
      <strong>计划</strong>
      <span>{{ inspectorPlan.completedCount }}/{{ inspectorPlan.entries.length }}</span>
      <small>随 Runtime 事件更新</small>
    </div>
    <PlanChecklist :entries="inspectorPlan.entries" active />
  </section>

  <div v-else class="timeline-state" role="status">
    当前 Task 还没有可展示的计划。
  </div>
</template>
