<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentToolStatus } from '../../../shared/agent'
import {
  SUBAGENT_STOP_COPY,
  createSubagentCardExpansion,
  subagentStatusLabel
} from '../conversation-subagent-view'
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
/** 未手势覆盖时跟随 running；用户点过 summary 后不再被 status 绑死。 */
const expansion = createSubagentCardExpansion(props.status)
const expanded = ref(expansion.open)

watch(
  () => props.status,
  (status) => {
    expansion.applyStatus(status)
    expanded.value = expansion.open
  }
)

/** 原生 details 开合写回控制器；与当前 open 相同的事件是 :open 同步，不是手势。 */
function onToggle(event: Event): void {
  expansion.applyToggle((event.currentTarget as HTMLDetailsElement).open)
  expanded.value = expansion.open
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
