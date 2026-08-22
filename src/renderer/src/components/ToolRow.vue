<script setup lang="ts">
import { computed } from 'vue'
import type { AgentToolStatus } from '../../../shared/agent'

const props = withDefaults(
  defineProps<{
    label: string
    status: AgentToolStatus | 'unknown'
    files?: readonly string[]
    /** 长命令或路径，默认折叠；summary 只留短标签。 */
    detail?: string
    /** 标题与退出事实冲突时主列可见。 */
    warning?: string
  }>(),
  { files: () => [], detail: '', warning: '' }
)

const busy = computed(() => props.status === 'in_progress' || props.status === 'pending')
const hint = computed(() => props.detail || props.label)
const accessibleLabel = computed(() => {
  const parts = [props.label]
  if (props.warning) parts.push(props.warning)
  if (props.detail) parts.push('点开查看详情')
  return parts.join('，')
})
</script>

<template>
  <div
    class="tool-row"
    data-kind="tool"
    :data-status="status"
    :title="hint"
    :aria-label="accessibleLabel"
  >
    <details v-if="files.length > 1" class="tool-row-details">
      <summary>
        <span v-if="busy" class="conversation-spinner" aria-hidden="true" />
        <span>▸ {{ label }}</span>
        <span v-if="warning" class="tool-row-warning">{{ warning }}</span>
      </summary>
      <ul class="tool-row-files">
        <li v-for="file in files" :key="file">{{ file }}</li>
      </ul>
    </details>
    <details v-else-if="detail" class="tool-row-details">
      <summary>
        <span v-if="busy" class="conversation-spinner" aria-hidden="true" />
        <span>▸ {{ label }}</span>
        <span v-if="warning" class="tool-row-warning">{{ warning }}</span>
      </summary>
      <pre class="tool-row-detail">{{ detail }}</pre>
    </details>
    <div v-else class="tool-row-line">
      <span v-if="busy" class="conversation-spinner" aria-hidden="true" />
      <span>▸ {{ label }}</span>
      <span v-if="warning" class="tool-row-warning">{{ warning }}</span>
    </div>
  </div>
</template>
