<script setup lang="ts">
import { computed } from 'vue'
import type { PermissionAuditRecord } from '../../../shared/task-history'
import type { TaskTimelineViewModel } from '../task-timeline-reducer'
import {
  permissionAuditInitiatorLabel,
  permissionAuditReasonLabel,
  permissionAuditScopeLabel,
  projectInspectorTimelineSummary
} from '../task-inspector'

const props = withDefaults(
  defineProps<{
    paneId: string
    timeline: TaskTimelineViewModel | null
    timelineLoading?: boolean
    permissionAudits?: readonly PermissionAuditRecord[]
    permissionAuditCursor?: string | null
    loadingMorePermissionAudits?: boolean
    showPermissionAudits?: boolean
  }>(),
  {
    timelineLoading: false,
    permissionAudits: () => [],
    permissionAuditCursor: null,
    loadingMorePermissionAudits: false,
    showPermissionAudits: false
  }
)

const emit = defineEmits<{
  loadMorePermissionAudits: []
}>()

const timelineSummary = computed(() => projectInspectorTimelineSummary(props.timeline))
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

  <section v-if="showPermissionAudits" class="inspector-section audit-section">
    <div class="inspector-heading">
      <strong>权限审计</strong>
      <span>{{ permissionAudits.length }}</span>
    </div>
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
  </section>
</template>
