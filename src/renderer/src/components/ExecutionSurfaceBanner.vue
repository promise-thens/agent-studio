<script setup lang="ts">
import { computed } from 'vue'
import { resolveExecutionSurfaceBanner, type WorkbenchPrimaryView } from '../workbench-primary-view'

const props = defineProps<{
  primaryView: WorkbenchPrimaryView
  activeExecution: { taskId: string; state: string } | null
  takeoverHud?: string | null
}>()

defineEmits<{
  returnToConversation: []
}>()

const banner = computed(() =>
  resolveExecutionSurfaceBanner({
    primaryView: props.primaryView,
    activeExecution: props.activeExecution
  })
)

const copy = computed(() => {
  if (banner.value.kind === 'waiting-permission') return '任务等待审批'
  if (banner.value.kind === 'running') return props.takeoverHud || '任务正在执行'
  return ''
})
</script>

<template>
  <aside
    v-if="banner.kind !== 'none'"
    class="execution-surface-banner"
    role="status"
    :data-kind="banner.kind"
  >
    <p>{{ copy }}</p>
    <button
      type="button"
      title="返回对话"
      aria-label="返回对话"
      @click="$emit('returnToConversation')"
    >
      返回对话
    </button>
  </aside>
</template>

<style scoped>
.execution-surface-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-1);
  color: var(--text-1);
}

.execution-surface-banner p {
  margin: 0;
  min-width: 0;
  font-size: 12px;
  line-height: 1.45;
}

.execution-surface-banner button {
  flex: 0 0 auto;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-chip);
  color: var(--text-1);
  background: var(--surface-2);
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}

.execution-surface-banner button:hover {
  background: var(--hover-fill);
}

@media (prefers-reduced-motion: reduce) {
  .execution-surface-banner button {
    transition: none;
  }
}
</style>
