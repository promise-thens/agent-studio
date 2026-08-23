<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PhArrowsIn as ArrowsIn, PhArrowsOut as ArrowsOut, PhX as X } from '@phosphor-icons/vue'
import type { PermissionAuditRecord } from '../../../shared/task-history'
import type { TaskTimelineViewModel } from '../task-timeline-reducer'
import type { TaskChangesController } from '../composables/useTaskChanges'
import {
  INSPECTOR_CARD_MARGIN,
  INSPECTOR_TABS,
  clampInspectorCardRect,
  defaultInspectorCardRect,
  inspectorPlaceholderCopy,
  inspectorReviewWorkspaceClass,
  isInspectorCardDragSource,
  moveInspectorCardRect,
  nextInspectorTab,
  permissionAuditInitiatorLabel,
  permissionAuditReasonLabel,
  permissionAuditScopeLabel,
  projectInspectorTimelineSummary,
  resolveInspectorTab,
  type InspectorCardRect,
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
    changesController?: TaskChangesController | null
  }>(),
  {
    taskId: '',
    timelineLoading: false,
    permissionAudits: () => [],
    permissionAuditCursor: null,
    loadingMorePermissionAudits: false,
    showPermissionAudits: false,
    changesController: null
  }
)

const emit = defineEmits<{
  close: []
  'update:activeTab': [tab: InspectorTab]
  loadMorePermissionAudits: []
}>()

const currentTab = computed(() => resolveInspectorTab(props.activeTab))
const showChangesPanel = computed(
  () => currentTab.value === 'changes' && Boolean(props.taskId) && Boolean(props.changesController)
)
const reviewWorkspaceClass = computed(() => inspectorReviewWorkspaceClass(currentTab.value))
const placeholder = computed(() => {
  if (currentTab.value === 'timeline' || showChangesPanel.value) return null
  return inspectorPlaceholderCopy(currentTab.value)
})
const timelineSummary = computed(() => projectInspectorTimelineSummary(props.timeline))
const cardRef = ref<HTMLElement | null>(null)
const cardLeft = ref<number | null>(null)
const cardTop = ref<number | null>(null)
const expanded = ref(false)
const compactRect = ref<InspectorCardRect | null>(null)
let dragOrigin: { pointerId: number; x: number; y: number; left: number; top: number } | null = null

const cardStyle = computed(() => {
  if (cardLeft.value == null || cardTop.value == null) return undefined
  const style: Record<string, string> = {
    left: `${cardLeft.value}px`,
    top: `${cardTop.value}px`,
    right: 'auto'
  }
  if (expanded.value) {
    const viewport = readViewport()
    style.width = `${Math.max(1, viewport.width - INSPECTOR_CARD_MARGIN * 2)}px`
    style.height = `${Math.max(1, viewport.height - INSPECTOR_CARD_MARGIN * 2)}px`
  }
  return style
})

const expandLabel = computed(() => (expanded.value ? '还原检查器大小' : '放大检查器'))

// Esc 由 App 裁定：执行中先聚焦停止，只有焦点已在卡片内才关检查器。

function readViewport(): { width: number; height: number } {
  const parent = cardRef.value?.offsetParent
  if (parent instanceof HTMLElement) {
    return { width: parent.clientWidth, height: parent.clientHeight }
  }
  return { width: window.innerWidth, height: window.innerHeight }
}

function readCardSize(): { width: number; height: number } {
  return {
    width: cardRef.value?.offsetWidth ?? 380,
    height: cardRef.value?.offsetHeight ?? 520
  }
}

function applyRect(rect: InspectorCardRect): void {
  cardLeft.value = rect.left
  cardTop.value = rect.top
}

function placeDefault(): void {
  const viewport = readViewport()
  const size = readCardSize()
  applyRect(
    defaultInspectorCardRect({
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      width: size.width,
      height: size.height,
      expanded: expanded.value
    })
  )
}

function clampCurrent(): void {
  if (cardLeft.value == null || cardTop.value == null) return
  const viewport = readViewport()
  const size = readCardSize()
  applyRect(
    clampInspectorCardRect({
      left: cardLeft.value,
      top: cardTop.value,
      width: size.width,
      height: size.height,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height
    })
  )
}

/** 从工具条空白处开始拖卡片；点到标签或按钮时不抢事件。 */
function onDragHandlePointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !isInspectorCardDragSource(event.target)) return
  if (cardLeft.value == null || cardTop.value == null) placeDefault()
  dragOrigin = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    left: cardLeft.value ?? 0,
    top: cardTop.value ?? 0
  }
  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  event.preventDefault()
}

function onDragHandlePointerMove(event: PointerEvent): void {
  if (!dragOrigin || dragOrigin.pointerId !== event.pointerId) return
  const viewport = readViewport()
  const size = readCardSize()
  applyRect(
    moveInspectorCardRect(
      {
        left: dragOrigin.left,
        top: dragOrigin.top,
        width: size.width,
        height: size.height
      },
      event.clientX - dragOrigin.x,
      event.clientY - dragOrigin.y,
      { viewportWidth: viewport.width, viewportHeight: viewport.height }
    )
  )
}

function onDragHandlePointerUp(event: PointerEvent): void {
  if (!dragOrigin || dragOrigin.pointerId !== event.pointerId) return
  dragOrigin = null
  if (
    event.currentTarget instanceof HTMLElement &&
    event.currentTarget.hasPointerCapture(event.pointerId)
  ) {
    event.currentTarget.releasePointerCapture(event.pointerId)
  }
}

/** 放大铺满工作区；还原时回到放大前的位置和尺寸。 */
function toggleExpanded(): void {
  const viewport = readViewport()
  const size = readCardSize()
  if (!expanded.value) {
    compactRect.value = {
      left: cardLeft.value ?? INSPECTOR_CARD_MARGIN,
      top: cardTop.value ?? INSPECTOR_CARD_MARGIN,
      width: size.width,
      height: size.height
    }
    expanded.value = true
    void nextTick(() => {
      applyRect(
        defaultInspectorCardRect({
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          width: size.width,
          height: size.height,
          expanded: true
        })
      )
    })
    return
  }
  expanded.value = false
  const previous = compactRect.value
  void nextTick(() => {
    if (!previous) {
      placeDefault()
      return
    }
    applyRect(
      clampInspectorCardRect({
        ...previous,
        viewportWidth: readViewport().width,
        viewportHeight: readViewport().height
      })
    )
  })
}

function onWindowResize(): void {
  if (props.open) clampCurrent()
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      dragOrigin = null
      return
    }
    void nextTick(() => {
      if (cardLeft.value == null) placeDefault()
      else clampCurrent()
    })
  }
)

watch(currentTab, () => {
  if (!props.open) return
  void nextTick(clampCurrent)
})

onMounted(() => {
  window.addEventListener('resize', onWindowResize)
  if (props.open) void nextTick(placeDefault)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
})

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
    ref="cardRef"
    class="task-inspector inspector-panel is-floating-card"
    :class="[reviewWorkspaceClass, expanded ? 'is-expanded' : undefined]"
    :style="cardStyle"
    data-inspector-drawer
    role="complementary"
    aria-label="检查器"
  >
    <header
      class="inspector-toolbar"
      data-inspector-drag-handle
      @pointerdown="onDragHandlePointerDown"
      @pointermove="onDragHandlePointerMove"
      @pointerup="onDragHandlePointerUp"
      @pointercancel="onDragHandlePointerUp"
    >
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
        :title="expandLabel"
        :aria-label="expandLabel"
        @click="toggleExpanded()"
      >
        <ArrowsIn v-if="expanded" :size="16" />
        <ArrowsOut v-else :size="16" />
      </button>
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

      <TaskChangesPanel
        v-else-if="showChangesPanel && changesController"
        :task-id="taskId"
        :controller="changesController"
      />

      <div v-else class="inspector-placeholder" role="status">
        <strong>{{ placeholder?.heading }}</strong>
        <p>{{ placeholder?.detail }}</p>
      </div>
    </section>
  </aside>
</template>
