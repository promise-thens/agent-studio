<script setup lang="ts">
import { computed, nextTick } from 'vue'
import { PhX as X } from '@phosphor-icons/vue'
import type { PermissionAuditRecord } from '../../../shared/task-history'
import type { TaskTimelineViewModel } from '../task-timeline-reducer'
import {
  INSPECTOR_TABS,
  inspectorPlaceholderCopy,
  nextInspectorTab,
  permissionAuditInitiatorLabel,
  permissionAuditReasonLabel,
  permissionAuditScopeLabel,
  projectInspectorTimelineSummary,
  resolveInspectorTab,
  type InspectorTab
} from '../task-inspector'
import TaskChangesPanel from './TaskChangesPanel.vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    activeTab: InspectorTab
    taskId?: string
    timeline: TaskTimelineViewModel | null
    timelineLoading?: boolean
    permissionAudits?: readonly PermissionAuditRecord[]
    permissionAuditCursor?: string | null
    loadingMorePermissionAudits?: boolean
    showPermissionAudits?: boolean
  }>(),
  {
    taskId: '',
    timelineLoading: false,
    permissionAudits: () => [],
    permissionAuditCursor: null,
    loadingMorePermissionAudits: false,
    showPermissionAudits: false
  }
)

const emit = defineEmits<{
  close: []
  'update:activeTab': [tab: InspectorTab]
  loadMorePermissionAudits: []
}>()

const currentTab = computed(() => resolveInspectorTab(props.activeTab))
const showChangesPanel = computed(() => currentTab.value === 'changes' && Boolean(props.taskId))
const placeholder = computed(() => {
  if (currentTab.value === 'timeline' || showChangesPanel.value) return null
  return inspectorPlaceholderCopy(currentTab.value)
})
const timelineSummary = computed(() => projectInspectorTimelineSummary(props.timeline))
// Esc 由 App 裁定：执行中先聚焦停止，只有焦点已在抽屉内才关检查器。

function selectTab(tab: InspectorTab, focus = false): void {
  const next = resolveInspectorTab(tab)
  emit('update:activeTab', next)
  if (!focus) return
  void nextTick(() => {
    document.getElementById(`inspector-tab-${next}`)?.focus()
  })
}

function onTabListKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowRight') {
    event.preventDefault()
    selectTab(nextInspectorTab(currentTab.value, 1), true)
    return
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    selectTab(nextInspectorTab(currentTab.value, -1), true)
    return
  }
  if (event.key === 'Home') {
    event.preventDefault()
    selectTab('timeline', true)
    return
  }
  if (event.key === 'End') {
    event.preventDefault()
    selectTab('artifacts', true)
  }
}
</script>

<template>
  <aside
    v-if="open"
    class="task-inspector inspector-panel"
    data-inspector-drawer
    role="complementary"
    aria-label="检查器"
  >
    <header class="inspector-toolbar">
      <div
        class="inspector-tabs"
        role="tablist"
        aria-label="检查器标签"
        @keydown="onTabListKeydown"
      >
        <button
          v-for="tab in INSPECTOR_TABS"
          :id="`inspector-tab-${tab.id}`"
          :key="tab.id"
          class="inspector-tab"
          type="button"
          role="tab"
          :aria-controls="`inspector-panel-${tab.id}`"
          :aria-selected="currentTab === tab.id"
          :tabindex="currentTab === tab.id ? 0 : -1"
          @click="selectTab(tab.id)"
        >
          {{ tab.label }}
        </button>
      </div>
      <button
        class="icon-button inspector-close"
        type="button"
        title="关闭检查器"
        aria-label="关闭检查器"
        @click="emit('close')"
      >
        <X :size="16" />
      </button>
    </header>

    <section
      :id="`inspector-panel-${currentTab}`"
      class="inspector-body"
      role="tabpanel"
      :aria-labelledby="`inspector-tab-${currentTab}`"
    >
      <template v-if="currentTab === 'timeline'">
        <!-- Timeline 只读摘要：不挂计划主副本，P0-12/13/15 走其它标签。 -->
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
              :key="audit.auditId"
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

      <TaskChangesPanel v-else-if="showChangesPanel" :task-id="taskId" />

      <div v-else class="inspector-placeholder" role="status">
        <strong>{{ placeholder?.heading }}</strong>
        <p>{{ placeholder?.detail }}</p>
      </div>
    </section>
  </aside>
</template>
