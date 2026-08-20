<script setup lang="ts">
import { computed } from 'vue'
import type { AgentToolStatus } from '../../../shared/agent'
import ToolRow from './ToolRow.vue'

const props = defineProps<{
  name: string
  status: 'running' | 'completed' | 'failed'
  tools: readonly {
    label: string
    status: AgentToolStatus | 'unknown'
    files?: readonly string[]
  }[]
}>()

const statusLabel = computed(() => {
  if (props.status === 'running') return '进行中'
  if (props.status === 'failed') return '失败'
  return '完成'
})
</script>

<template>
  <details
    class="subagent-card"
    :data-status="status"
    :open="status === 'running'"
    :aria-label="`${name}，${statusLabel}`"
  >
    <summary :title="name">
      <span class="subagent-dot" aria-hidden="true" />
      <span class="subagent-name">{{ name }}</span>
      <span class="subagent-status">{{ statusLabel }}</span>
      <span class="subagent-count">{{ tools.length }} 个工具</span>
    </summary>
    <div class="subagent-tools">
      <ToolRow
        v-for="(tool, index) in tools"
        :key="`${tool.label}:${index}`"
        :label="tool.label"
        :status="tool.status"
        :files="tool.files ?? []"
      />
    </div>
  </details>
</template>
