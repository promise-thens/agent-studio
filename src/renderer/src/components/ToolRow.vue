<script setup lang="ts">
import { computed } from 'vue'
import type { AgentToolStatus } from '../../../shared/agent'

const props = withDefaults(
  defineProps<{
    label: string
    status: AgentToolStatus | 'unknown'
    files?: readonly string[]
  }>(),
  { files: () => [] }
)

const busy = computed(() => props.status === 'in_progress' || props.status === 'pending')
</script>

<template>
  <div class="tool-row" data-kind="tool" :data-status="status" :title="label" :aria-label="label">
    <details v-if="files.length > 1" class="tool-row-details">
      <summary>
        <span v-if="busy" class="conversation-spinner" aria-hidden="true" />
        <span>▸ {{ label }}</span>
      </summary>
      <ul class="tool-row-files">
        <li v-for="file in files" :key="file">{{ file }}</li>
      </ul>
    </details>
    <div v-else class="tool-row-line">
      <span v-if="busy" class="conversation-spinner" aria-hidden="true" />
      <span>▸ {{ label }}</span>
    </div>
  </div>
</template>
