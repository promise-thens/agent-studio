<script setup lang="ts">
import { computed } from 'vue'
import type { AgentToolStatus } from '../../../shared/agent'
import { subagentStatusLabel } from '../conversation-subagent-view'
import ToolRow from './ToolRow.vue'

const props = defineProps<{
  name: string
  status: 'running' | 'completed' | 'failed'
  tools: readonly {
    key?: string
    label: string
    status: AgentToolStatus | 'unknown'
    files?: readonly string[]
  }[]
}>()

const statusLabel = computed(() => subagentStatusLabel(props.status))
</script>

<template>
  <!-- 第 7 节皮肤：一行标题+状态，一行计数；展开后只有缩进的 ToolRow。 -->
  <details class="subagent-card" :data-status="status" :open="status === 'running'">
    <summary :title="name" :aria-label="`${name}，${statusLabel}`">
      <span class="subagent-heading">
        <span class="subagent-dot" aria-hidden="true" />
        <span class="subagent-name">{{ name }}</span>
        <span class="subagent-status">{{ statusLabel }}</span>
      </span>
      <span class="subagent-count">已运行 {{ tools.length }} 个工具 · 点开查看</span>
    </summary>
    <div class="subagent-tools">
      <ToolRow
        v-for="(tool, index) in tools"
        :key="tool.key || `${tool.label}:${index}`"
        :label="tool.label"
        :status="tool.status"
        :files="tool.files ?? []"
      />
    </div>
  </details>
</template>
