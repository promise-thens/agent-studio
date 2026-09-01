<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AgentToolStatus } from '../../../shared/agent'
import { SUBAGENT_STOP_COPY, subagentStatusLabel } from '../conversation-subagent-view'
import ToolRow from './ToolRow.vue'

const props = defineProps<{
  name: string
  status: 'running' | 'completed' | 'failed'
  tools: readonly {
    key: string
    label: string
    status: AgentToolStatus | 'unknown'
    files?: readonly string[]
    detail?: string
  }[]
}>()

const statusLabel = computed(() => subagentStatusLabel(props.status))
/** 进行中默认展开；完成/失败默认折。用户点 summary 仍可改，Vue 不得把 open 绑死。 */
const expanded = ref(props.status === 'running')

/** 把原生 details 的开合写回，避免完成卡点开后又被 :open=false 折回去。 */
function onToggle(event: Event): void {
  expanded.value = (event.currentTarget as HTMLDetailsElement).open
}
</script>

<template>
  <!-- 第 7 节皮肤：一行标题+状态，一行计数；展开后只有缩进的 ToolRow。 -->
  <details class="subagent-card" :data-status="status" :open="expanded" @toggle="onToggle">
    <summary :title="name" :aria-label="`${name}，${statusLabel}`">
      <span class="subagent-heading">
        <span class="subagent-caret" aria-hidden="true" />
        <span class="subagent-dot" aria-hidden="true" />
        <span class="subagent-name">{{ name }}</span>
        <span class="subagent-status">{{ statusLabel }}</span>
      </span>
      <span class="subagent-count">已运行 {{ tools.length }} 个工具 · 点开查看</span>
    </summary>
    <div class="subagent-tools">
      <ToolRow
        v-for="tool in tools"
        :key="tool.key"
        :label="tool.label"
        :status="tool.status"
        :files="tool.files ?? []"
        :detail="tool.detail"
      />
      <p v-if="status === 'running'" class="subagent-stop-hint">{{ SUBAGENT_STOP_COPY }}</p>
    </div>
  </details>
</template>
