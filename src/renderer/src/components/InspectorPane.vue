<script setup lang="ts">
import { computed } from 'vue'
import type { PermissionAuditRecord } from '../../../shared/task-history'
import type { TaskTimelineViewModel } from '../task-timeline-reducer'
import type { TaskArtifactsController } from '../composables/useTaskArtifacts'
import type { TaskChangesController } from '../composables/useTaskChanges'
import { inspectorPlaceholderCopy, resolveInspectorTab, type InspectorTab } from '../task-inspector'
import TaskArtifactsPanel from './TaskArtifactsPanel.vue'
import TaskChangesPanel from './TaskChangesPanel.vue'
import InspectorTimelinePane from './InspectorTimelinePane.vue'

const props = withDefaults(
  defineProps<{
    paneId: string
    activeTab: InspectorTab
    taskId?: string
    timeline: TaskTimelineViewModel | null
    timelineLoading?: boolean
    permissionAudits?: readonly PermissionAuditRecord[]
    permissionAuditCursor?: string | null
    loadingMorePermissionAudits?: boolean
    showPermissionAudits?: boolean
    changesController?: TaskChangesController | null
    artifactsController?: TaskArtifactsController | null
  }>(),
  {
    taskId: '',
    timelineLoading: false,
    permissionAudits: () => [],
    permissionAuditCursor: null,
    loadingMorePermissionAudits: false,
    showPermissionAudits: false,
    changesController: null,
    artifactsController: null
  }
)

const emit = defineEmits<{
  loadMorePermissionAudits: []
}>()

const currentTab = computed(() => resolveInspectorTab(props.activeTab))
const showChangesPanel = computed(
  () => currentTab.value === 'changes' && Boolean(props.taskId) && Boolean(props.changesController)
)
const showArtifactsPanel = computed(
  () =>
    currentTab.value === 'artifacts' && Boolean(props.taskId) && Boolean(props.artifactsController)
)
const placeholder = computed(() => {
  if (currentTab.value === 'timeline' || showChangesPanel.value || showArtifactsPanel.value) {
    return null
  }
  return inspectorPlaceholderCopy(currentTab.value)
})
/** 为每个分栏生成独立的可访问标签，避免双栏出现重复 aria-controls。 */
function tabPanelId(): string {
  return `inspector-panel-${props.paneId}-${currentTab.value}`
}
</script>

<template>
  <section
    :id="tabPanelId()"
    class="inspector-pane"
    :data-pane-id="paneId"
    :data-inspector-tab="currentTab"
    role="tabpanel"
    :aria-labelledby="`inspector-tab-${paneId === 'secondary' ? 'secondary-' : ''}${currentTab}`"
  >
    <InspectorTimelinePane
      v-if="currentTab === 'timeline'"
      :pane-id="paneId"
      :timeline="timeline"
      :timeline-loading="timelineLoading"
      :permission-audits="permissionAudits"
      :permission-audit-cursor="permissionAuditCursor"
      :loading-more-permission-audits="loadingMorePermissionAudits"
      :show-permission-audits="showPermissionAudits"
      @load-more-permission-audits="emit('loadMorePermissionAudits')"
    />

    <TaskChangesPanel
      v-else-if="showChangesPanel && changesController"
      :task-id="taskId"
      :controller="changesController"
    />

    <TaskArtifactsPanel
      v-else-if="showArtifactsPanel && artifactsController"
      :task-id="taskId"
      :controller="artifactsController"
    />

    <div v-else class="inspector-placeholder" role="status">
      <strong>{{ placeholder?.heading }}</strong>
      <p>{{ placeholder?.detail }}</p>
    </div>
  </section>
</template>
