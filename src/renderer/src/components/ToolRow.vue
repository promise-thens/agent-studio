<script setup lang="ts">
import { computed } from 'vue'
import type { AgentToolStatus } from '../../../shared/agent'
import { resolveToolRowChrome } from '../conversation-tool-presentation'

const props = withDefaults(
  defineProps<{
    label: string
    status: AgentToolStatus | 'unknown'
    files?: readonly string[]
    /** 长命令或路径，默认折叠；summary 只留短标签。 */
    detail?: string
    /** 标题与退出事实冲突时主列可见。 */
    warning?: string
    /** 缺省视为前台；只有明确 background 才出徽章，禁止用进行中猜后台。 */
    execution?: 'background'
  }>(),
  { files: () => [], detail: '', warning: '' }
)

/** 折叠徽章与状态走同一 helper，避免取消后源码里仍同时写着「进行中」。 */
const chrome = computed(() =>
  resolveToolRowChrome({ status: props.status, execution: props.execution })
)
const busy = computed(() => chrome.value.busy)
const isBackground = computed(() => chrome.value.isBackground)
const statusLabel = computed(() => chrome.value.statusLabel)
const hint = computed(() => {
  const base = props.detail || props.label
  return isBackground.value ? `${base}，后台` : base
})
const accessibleLabel = computed(() => {
  const parts = [props.label, statusLabel.value]
  if (isBackground.value) parts.push('后台')
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
    :data-execution="isBackground ? 'background' : undefined"
    :title="hint"
    :aria-label="accessibleLabel"
  >
    <details v-if="files.length > 1" class="tool-row-details">
      <summary>
        <span class="tool-row-caret" aria-hidden="true" />
        <span v-if="busy" class="conversation-spinner" aria-hidden="true" />
        <span class="tool-row-label">{{ label }}</span>
        <span v-if="warning" class="tool-row-warning">{{ warning }}</span>
        <span v-if="isBackground" class="tool-row-execution">后台</span>
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
        <span v-if="isBackground" class="tool-row-execution">后台</span>
        <span class="tool-row-status">{{ statusLabel }}</span>
      </summary>
      <pre class="tool-row-detail">{{ detail }}</pre>
    </details>
    <div v-else class="tool-row-line">
      <span class="tool-row-caret-placeholder" aria-hidden="true" />
      <span v-if="busy" class="conversation-spinner" aria-hidden="true" />
      <span class="tool-row-label">{{ label }}</span>
      <span v-if="warning" class="tool-row-warning">{{ warning }}</span>
      <span v-if="isBackground" class="tool-row-execution">后台</span>
      <span class="tool-row-status">{{ statusLabel }}</span>
    </div>
  </div>
</template>
