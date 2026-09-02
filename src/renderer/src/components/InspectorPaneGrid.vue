<script setup lang="ts">
import type { PermissionAuditRecord } from '../../../shared/task-history'
import type { TaskTimelineViewModel } from '../task-timeline-reducer'
import type { TaskArtifactsController } from '../composables/useTaskArtifacts'
import type { TaskChangesController } from '../composables/useTaskChanges'
import type { InspectorTab } from '../task-inspector'
import InspectorPane from './InspectorPane.vue'
import InspectorToolbar from './InspectorToolbar.vue'

withDefaults(
  defineProps<{
    primaryTab: InspectorTab
    secondaryTab: InspectorTab
    split: boolean
    taskId?: string
    focusTurnId?: string | null
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
    focusTurnId: null,
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
  'update:primaryTab': [tab: InspectorTab]
  'update:secondaryTab': [tab: InspectorTab]
  loadMorePermissionAudits: []
}>()

function loadMorePermissionAudits(): void {
  emit('loadMorePermissionAudits')
}
</script>

<template>
  <div
    class="inspector-pane-grid"
    :class="{ 'is-split': split }"
    :data-inspector-split="split ? 'true' : 'false'"
  >
    <div class="inspector-pane-column">
      <InspectorPane
        pane-id="primary"
        :active-tab="primaryTab"
        :task-id="taskId"
        :focus-turn-id="focusTurnId"
        :timeline="timeline"
        :timeline-loading="timelineLoading"
        :permission-audits="permissionAudits"
        :permission-audit-cursor="permissionAuditCursor"
        :loading-more-permission-audits="loadingMorePermissionAudits"
        :show-permission-audits="showPermissionAudits"
        :changes-controller="changesController"
        :artifacts-controller="artifactsController"
        @load-more-permission-audits="loadMorePermissionAudits"
      />
    </div>

    <div v-if="split" class="inspector-pane-divider" role="separator" aria-orientation="vertical" />

    <div v-if="split" class="inspector-pane-column is-secondary">
      <!-- 副栏工具条保持独立横向容器，避免内部 flex: 1 在纵向分栏里撑满半屏。 -->
      <header class="inspector-toolbar inspector-pane-toolbar">
        <InspectorToolbar
          :active-tab="secondaryTab"
          compact
          :show-controls="false"
          @update:active-tab="emit('update:secondaryTab', $event)"
        />
      </header>
      <InspectorPane
        pane-id="secondary"
        :active-tab="secondaryTab"
        :task-id="taskId"
        :focus-turn-id="focusTurnId"
        :timeline="timeline"
        :timeline-loading="timelineLoading"
        :permission-audits="permissionAudits"
        :permission-audit-cursor="permissionAuditCursor"
        :loading-more-permission-audits="loadingMorePermissionAudits"
        :show-permission-audits="false"
        :changes-controller="changesController"
        :artifacts-controller="artifactsController"
        @load-more-permission-audits="loadMorePermissionAudits"
      />
    </div>
  </div>
</template>
