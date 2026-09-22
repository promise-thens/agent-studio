<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { PermissionAuditRecord } from '../../../shared/task-history'
import type { TaskTimelineViewModel } from '../task-timeline-reducer'
import { projectInspectorTurns } from '../inspector-turn-list'
import {
  permissionAuditInitiatorLabel,
  permissionAuditReasonLabel,
  permissionAuditScopeLabel,
  projectInspectorTimelineSummary
} from '../task-inspector'
import type { InspectorConversationTarget } from '../task-inspector'

const props = withDefaults(
  defineProps<{
    paneId: string
    focusTurnId?: string | null
    focusNodeId?: string | null
    focusRequestId?: number
    timeline: TaskTimelineViewModel | null
    timelineLoading?: boolean
    permissionAudits?: readonly PermissionAuditRecord[]
    permissionAuditCursor?: string | null
    loadingMorePermissionAudits?: boolean
    showPermissionAudits?: boolean
  }>(),
  {
    timelineLoading: false,
    focusTurnId: null,
    focusNodeId: null,
    focusRequestId: 0,
    permissionAudits: () => [],
    permissionAuditCursor: null,
    loadingMorePermissionAudits: false,
    showPermissionAudits: false
  }
)

const emit = defineEmits<{
  loadMorePermissionAudits: []
  focusTarget: [target: InspectorConversationTarget]
}>()

const timelineSummary = computed(() => projectInspectorTimelineSummary(props.timeline))
const turnItems = computed(() => projectInspectorTurns(props.timeline))
const turnList = ref<HTMLElement | null>(null)

/** 对话打开 Inspector 时展开并聚焦真实工具节点；同一节点可通过 requestId 重复定位。 */
async function focusRequestedTool(): Promise<void> {
  const nodeId = props.focusNodeId
  if (!nodeId) return
  await nextTick()
  const target = Array.from(
    turnList.value?.querySelectorAll<HTMLElement>('[data-inspector-node-id]') ?? []
  ).find((element) => element.dataset.inspectorNodeId === nodeId)
  if (!target) return
  // 用户可能手动收起工具组；重复定位时必须先恢复可见性，再移动焦点。
  const details = target.closest<HTMLDetailsElement>('details.inspector-turn-tools')
  if (details) details.open = true
  target.focus({ preventScroll: true })
  target.scrollIntoView({ block: 'center', behavior: 'instant' })
}

watch(
  () => [props.focusNodeId, props.focusRequestId, turnItems.value] as const,
  () => void focusRequestedTool(),
  { immediate: true, flush: 'post' }
)
</script>

<template>
  <!-- Timeline 只读执行摘要；完整计划由独立 Plan 标签承载，避免和审计信息混在一起。 -->
  <div v-if="timelineLoading && timelineSummary.empty" class="timeline-state" role="status">
    正在加载执行历史…
  </div>
  <div v-else-if="timelineSummary.empty" class="timeline-state" role="status">
    {{ timelineSummary.statusLabel }}
  </div>
  <div v-else class="inspector-timeline-summary" role="status">
    <p>{{ timelineSummary.turnCount }} 轮 · {{ timelineSummary.statusLabel }}</p>
    <p v-if="timelineSummary.planLine">{{ timelineSummary.planLine }}</p>
    <p v-if="timelineSummary.toolCount">{{ timelineSummary.toolCount }} 次工具</p>
  </div>

  <ol v-if="turnItems.length" ref="turnList" class="inspector-turn-list" aria-label="对话轮次">
    <li v-for="turn in turnItems" :key="turn.turnId">
      <button
        type="button"
        class="inspector-turn-link"
        :class="{ 'is-selected': focusTurnId === turn.turnId, 'is-active': turn.active }"
        :aria-current="focusTurnId === turn.turnId ? 'true' : undefined"
        :title="`回到对话：${turn.title}`"
        @click="emit('focusTarget', { turnId: turn.turnId, nodeId: null })"
      >
        <span>{{ turn.title }}</span>
        <small>{{ turn.statusLabel }}</small>
      </button>
      <details
        v-if="turn.tools.length"
        class="inspector-turn-tools"
        :open="
          turn.turnId === focusTurnId && turn.tools.some((tool) => tool.nodeId === focusNodeId)
        "
      >
        <summary>{{ turn.tools.length }} 项操作</summary>
        <ul>
          <li v-for="tool in turn.tools" :key="tool.nodeId">
            <button
              type="button"
              :class="{ 'is-selected': focusNodeId === tool.nodeId }"
              :title="tool.title"
              :aria-current="focusNodeId === tool.nodeId ? 'true' : undefined"
              :data-inspector-node-id="tool.nodeId"
              @click="emit('focusTarget', { turnId: turn.turnId, nodeId: tool.nodeId })"
            >
              {{ tool.title }}
            </button>
          </li>
        </ul>
      </details>
    </li>
  </ol>

  <details v-if="showPermissionAudits" class="inspector-section audit-section">
    <summary class="inspector-heading">
      <strong>权限审计</strong>
      <span>{{ permissionAudits.length }}</span>
    </summary>
    <div v-if="permissionAudits.length" class="permission-audit-list">
      <article
        v-for="audit in permissionAudits"
        :key="`${paneId}-${audit.auditId}`"
        class="permission-audit-item"
        :data-risk="audit.risk"
      >
        <div>
          <strong>{{ audit.title }}</strong>
          <span>
            {{ audit.risk }} · {{ audit.operationType }} ·
            {{ permissionAuditInitiatorLabel(audit) }}
          </span>
        </div>
        <p>{{ audit.impact }}</p>
        <ul class="permission-audit-targets">
          <li v-for="target in audit.targetSummaries" :key="target">{{ target }}</li>
        </ul>
        <p v-if="audit.detail" class="permission-audit-detail">{{ audit.detail }}</p>
        <small>
          {{ permissionAuditReasonLabel(audit.reason) }} ·
          {{ permissionAuditScopeLabel(audit.scope) }} ·
          {{ new Date(audit.createdAt).toLocaleString() }}
          <template v-if="audit.truncated"> · 摘要已截断</template>
        </small>
      </article>
      <button
        v-if="permissionAuditCursor"
        class="history-load-more"
        type="button"
        :disabled="loadingMorePermissionAudits"
        @click="emit('loadMorePermissionAudits')"
      >
        {{ loadingMorePermissionAudits ? '正在加载…' : '加载更多审计' }}
      </button>
    </div>
    <div v-else class="empty-state compact" role="status" aria-live="polite">
      <p>当前 Task 暂无权限决策记录。</p>
    </div>
  </details>
</template>

<style scoped>
.inspector-turn-list {
  display: grid;
  gap: 8px;
  margin: 12px 0;
  padding: 0;
  list-style: none;
}
.inspector-turn-link {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-chip);
  background: transparent;
  color: var(--text-1);
  text-align: left;
  cursor: pointer;
}
.inspector-turn-link > span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.inspector-turn-link small {
  flex-shrink: 0;
  color: var(--text-3);
}
.inspector-turn-link:hover,
.inspector-turn-link.is-selected {
  background: var(--surface-2);
  border-color: var(--border);
}
.inspector-turn-link.is-active small {
  color: var(--accent);
}
.inspector-turn-tools {
  padding: 0 10px 8px;
  color: var(--text-3);
  font-size: 12px;
}
summary {
  cursor: pointer;
}
.inspector-turn-tools ul {
  padding-left: 14px;
}
.inspector-turn-tools button {
  max-width: 100%;
  border: 0;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  text-align: left;
  overflow-wrap: anywhere;
}
.inspector-turn-tools button.is-selected {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}
</style>
