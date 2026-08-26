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
/** 把 Runtime 工具终态翻成稳定短文案，让调用链无需靠颜色猜状态。 */
const statusLabel = computed(() => {
  switch (props.status) {
    case 'pending':
      return '等待中'
    case 'in_progress':
      return '进行中'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    default:
      return '状态未知'
  }
})
const accessibleLabel = computed(() => {
  const parts = [props.label, statusLabel.value]
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
        <span class="tool-row-caret" aria-hidden="true" />
        <span v-if="busy" class="conversation-spinner" aria-hidden="true" />
        <span class="tool-row-label">{{ label }}</span>
        <span v-if="warning" class="tool-row-warning">{{ warning }}</span>
        <span class="tool-row-status">{{ statusLabel }}</span>
      </summary>
      <ul class="tool-row-files">
        <li v-for="file in files" :key="file">{{ file }}</li>
      </ul>
    </details>
    <details v-else-if="detail" class="tool-row-details">
      <summary>
        <span class="tool-row-caret" aria-hidden="true" />
        <span v-if="busy" class="conversation-spinner" aria-hidden="true" />
        <span class="tool-row-label">{{ label }}</span>
        <span v-if="warning" class="tool-row-warning">{{ warning }}</span>
        <span class="tool-row-status">{{ statusLabel }}</span>
      </summary>
      <pre class="tool-row-detail">{{ detail }}</pre>
    </details>
    <div v-else class="tool-row-line">
      <span class="tool-row-caret-placeholder" aria-hidden="true" />
      <span v-if="busy" class="conversation-spinner" aria-hidden="true" />
      <span class="tool-row-label">{{ label }}</span>
      <span v-if="warning" class="tool-row-warning">{{ warning }}</span>
      <span class="tool-row-status">{{ statusLabel }}</span>
    </div>
  </div>
</template>
