<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { ConversationToolBlock } from '../conversation-turn-view'
import {
  SUBAGENT_STOP_COPY,
  countSubagentTools,
  flattenSubagentToolsToRows,
  formatSubagentCountLine,
  subagentActivityRows,
  subagentEmptyActivityCopy,
  subagentStatusLabel,
  type SubagentToolRowView
} from '../conversation-subagent-view'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'
import AssistantMarkdown from './AssistantMarkdown.vue'
import ToolRow from './ToolRow.vue'

const props = defineProps<{
  taskId: string
  name: string
  agentType?: string
  shortId?: string
  status: 'running' | 'completed' | 'failed'
  tools: readonly ConversationToolBlock[]
  durationLabel?: string
  groupingNote?: string
}>()

const statusLabel = computed(() => subagentStatusLabel(props.status))
const detailsRef = ref<HTMLDetailsElement | null>(null)
const opened = ref(props.status === 'running')
const userToggled = ref(false)
const loading = ref(false)
const loaded = ref(false)
const activitySource = ref<'pending' | 'grok-session' | 'missing' | undefined>()
const loadedRows = ref<SubagentToolRowView[]>([])
const loadedToolCount = ref(0)
const result = ref<{ text: string; truncated: boolean } | null>(null)

const rows = computed(() =>
  props.tools.length ? flattenSubagentToolsToRows(props.tools) : loadedRows.value
)
const toolCount = computed(() =>
  props.tools.length ? countSubagentTools(props.tools) : loadedToolCount.value
)
const countLine = computed(() => formatSubagentCountLine(toolCount.value))
const summaryMeta = computed(() =>
  [props.agentType, countLine.value, props.durationLabel].filter(Boolean).join(' · ')
)
const emptyCopy = computed(() => subagentEmptyActivityCopy(activitySource.value))
const accessibleLabel = computed(
  () => `${props.name}，${statusLabel.value}，${summaryMeta.value || '点开查看'}`
)

/** 首次展开时才补读子 session；结果与工具都只消费经过 Preload 校验的回包。 */
async function loadActivity(force = false): Promise<void> {
  if (!props.shortId || loading.value || (loaded.value && !force)) return
  loading.value = true
  activitySource.value = 'pending'
  try {
    const page = unwrapDesktopIpcResult(
      await window.task.getSubagentActivity(props.taskId, props.shortId)
    )
    loadedRows.value = subagentActivityRows(page.tools)
    loadedToolCount.value = page.tools.length
    result.value = page.result ?? null
    activitySource.value = page.source
    loaded.value = true
  } catch {
    activitySource.value = 'missing'
  } finally {
    loading.value = false
  }
}

function onToggle(event: Event): void {
  const target = event.currentTarget
  if (!(target instanceof HTMLDetailsElement)) return
  opened.value = target.open
  userToggled.value = true
  if (target.open) void loadActivity()
}

onMounted(() => {
  if (detailsRef.value) detailsRef.value.open = opened.value
  if (opened.value) void loadActivity()
})

watch(
  () => props.status,
  (status, previous) => {
    if (!userToggled.value && status === 'running') {
      opened.value = true
      if (detailsRef.value) detailsRef.value.open = true
    }
    // 子任务刚进入终态时重新读取一次，拿到真实最后回复而不是运行中的半截文本。
    if (previous === 'running' && status !== 'running' && opened.value) void loadActivity(true)
  }
)
</script>

<template>
  <!-- 子代理是父 Turn 内的任务卡：第一眼看状态与结论，工具流水账退到第二层。 -->
  <details ref="detailsRef" class="subagent-card" :data-status="status" @toggle="onToggle">
    <summary class="subagent-summary" :aria-label="accessibleLabel">
      <span class="subagent-heading">
        <span class="subagent-dot" aria-hidden="true" />
        <span class="subagent-identity">
          <span class="subagent-name">{{ name }}</span>
          <span class="subagent-summary-meta">{{ summaryMeta }}</span>
        </span>
        <span class="subagent-status">{{ statusLabel }}</span>
        <span class="subagent-caret" aria-hidden="true" />
      </span>
    </summary>

    <div class="subagent-body">
      <p v-if="groupingNote" class="subagent-meta">{{ groupingNote }}</p>

      <section v-if="result" class="subagent-result" aria-label="子代理执行结果">
        <header class="subagent-section-heading">
          <h4>执行结果</h4>
          <span v-if="result.truncated">内容已截断</span>
        </header>
        <AssistantMarkdown :text="result.text" />
      </section>

      <section class="subagent-activity" aria-label="子代理活动明细">
        <header class="subagent-section-heading">
          <h4>活动明细</h4>
          <span v-if="loading">正在刷新…</span>
        </header>
        <p v-if="!rows.length" class="subagent-meta" role="status">
          {{ emptyCopy }}
        </p>
        <div v-else class="subagent-tools">
          <ToolRow
            v-for="tool in rows"
            :key="tool.key"
            :label="tool.label"
            :status="tool.status"
            :files="tool.files ?? []"
            :detail="tool.detail"
          />
        </div>
      </section>

      <p v-if="status === 'running'" class="subagent-stop-hint">
        {{ SUBAGENT_STOP_COPY }}
      </p>
    </div>
  </details>
</template>
