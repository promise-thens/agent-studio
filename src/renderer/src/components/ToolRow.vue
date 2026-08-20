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
  }>(),
  { files: () => [], detail: '' }
)

const busy = computed(() => props.status === 'in_progress' || props.status === 'pending')
const hint = computed(() => props.detail || props.label)
const accessibleLabel = computed(() =>
  props.detail ? `${props.label}，点开查看详情` : props.label
)
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
      </summary>
      <ul class="tool-row-files">
        <li v-for="file in files" :key="file">{{ file }}</li>
      </ul>
    </details>
    <details v-else-if="detail" class="tool-row-details">
      <summary>
        <span v-if="busy" class="conversation-spinner" aria-hidden="true" />
        <span>▸ {{ label }}</span>
      </summary>
      <pre class="tool-row-detail">{{ detail }}</pre>
    </details>
    <div v-else class="tool-row-line">
      <span v-if="busy" class="conversation-spinner" aria-hidden="true" />
      <span>▸ {{ label }}</span>
    </div>
  </div>
</template>
