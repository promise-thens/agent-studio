<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PermissionAuditRecord } from '../../../shared/task-history'
import type { TaskTimelineViewModel } from '../task-timeline-reducer'
import type { TaskArtifactsController } from '../composables/useTaskArtifacts'
import type { TaskChangesController } from '../composables/useTaskChanges'
import {
  INSPECTOR_CARD_MARGIN,
  clampInspectorCardRect,
  defaultInspectorCardRect,
  inspectorReviewWorkspaceClass,
  isInspectorCardDragSource,
  moveInspectorCardRect,
  resolveInspectorTab,
  type InspectorCardRect,
  type InspectorTab
} from '../task-inspector'
import InspectorPaneGrid from './InspectorPaneGrid.vue'
import InspectorToolbar from './InspectorToolbar.vue'
// TaskChangesPanel / TaskArtifactsPanel 由 InspectorPane 负责路由，保留在组件边界之外以便拓展。

const INSPECTOR_SNAP_DISTANCE = 28

const props = withDefaults(
  defineProps<{
    open: boolean
    activeTab: InspectorTab
    docked?: boolean
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
    docked: false,
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
  close: []
  'update:activeTab': [tab: InspectorTab]
  'update:docked': [docked: boolean]
  loadMorePermissionAudits: []
}>()

const currentTab = computed(() => resolveInspectorTab(props.activeTab))
const reviewWorkspaceClass = computed(() => inspectorReviewWorkspaceClass(currentTab.value))
const cardRef = ref<HTMLElement | null>(null)
const cardLeft = ref<number | null>(null)
const cardTop = ref<number | null>(null)
const expanded = ref(false)
const splitEnabled = ref(false)
const secondaryTab = ref<InspectorTab>('changes')
const compactRect = ref<InspectorCardRect | null>(null)
let dragOrigin: { pointerId: number; x: number; y: number; left: number; top: number } | null = null

const cardStyle = computed(() => {
  if (props.docked || cardLeft.value == null || cardTop.value == null) return undefined
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
  if (props.docked || cardLeft.value == null || cardTop.value == null) return
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

/** 从工具条空白处拖动浮层；按钮和标签不会抢走点击事件。 */
function onDragHandlePointerDown(event: PointerEvent): void {
  if (props.docked || event.button !== 0 || !isInspectorCardDragSource(event.target)) return
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

/** 松开在右侧吸附区时转为三列布局，让聊天列自动让出空间。 */
function onDragHandlePointerUp(event: PointerEvent): void {
  if (!dragOrigin || dragOrigin.pointerId !== event.pointerId) return
  const viewport = readViewport()
  const size = readCardSize()
  const rightGap = viewport.width - (cardLeft.value ?? 0) - size.width
  if (!props.docked && !expanded.value) {
    compactRect.value = {
      left: cardLeft.value ?? INSPECTOR_CARD_MARGIN,
      top: cardTop.value ?? INSPECTOR_CARD_MARGIN,
      width: size.width,
      height: size.height
    }
  }
  dragOrigin = null
  if (
    event.currentTarget instanceof HTMLElement &&
    event.currentTarget.hasPointerCapture(event.pointerId)
  ) {
    event.currentTarget.releasePointerCapture(event.pointerId)
  }
  if (rightGap <= INSPECTOR_SNAP_DISTANCE) emit('update:docked', true)
}

/** 在悬浮与工作区右侧吸附之间切换，保留原有位置用于还原。 */
function toggleDocked(): void {
  const nextDocked = !props.docked
  if (nextDocked && !expanded.value) {
    const size = readCardSize()
    compactRect.value = {
      left: cardLeft.value ?? INSPECTOR_CARD_MARGIN,
      top: cardTop.value ?? INSPECTOR_CARD_MARGIN,
      width: size.width,
      height: size.height
    }
  }
  emit('update:docked', nextDocked)
}

/** 从三列吸附态退回悬浮态时恢复上一次的矩形，避免位置跳回错误尺寸。 */
function restoreFloatingRect(): void {
  void nextTick(() => {
    const previous = compactRect.value
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

/** 放大铺满工作区；还原时回到放大前的位置和尺寸。 */
function toggleExpanded(): void {
  if (props.docked) return
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
    void nextTick(() =>
      applyRect(
        defaultInspectorCardRect({
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          width: size.width,
          height: size.height,
          expanded: true
        })
      )
    )
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

function toggleSplit(): void {
  if (!splitEnabled.value) {
    secondaryTab.value = currentTab.value === 'timeline' ? 'changes' : 'timeline'
  }
  splitEnabled.value = !splitEnabled.value
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
      if (!props.docked && cardLeft.value == null) placeDefault()
      else clampCurrent()
    })
  }
)

watch(
  () => props.docked,
  (docked) => {
    if (!docked) restoreFloatingRect()
  }
)

watch(currentTab, () => {
  if (!props.open) return
  void nextTick(clampCurrent)
})

onMounted(() => {
  window.addEventListener('resize', onWindowResize)
  if (props.open && !props.docked) void nextTick(placeDefault)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
})

function selectTab(tab: InspectorTab): void {
  emit('update:activeTab', resolveInspectorTab(tab))
}
</script>

<template>
  <aside
    v-if="open"
    ref="cardRef"
    class="task-inspector inspector-panel is-floating-card"
    :class="[
      reviewWorkspaceClass,
      expanded ? 'is-expanded' : undefined,
      docked ? 'is-docked' : undefined,
      splitEnabled ? 'is-split' : undefined
    ]"
    :style="cardStyle"
    data-inspector-drawer
    :data-inspector-docked="docked ? 'true' : 'false'"
    :data-inspector-split="splitEnabled ? 'true' : 'false'"
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
      <InspectorToolbar
        :active-tab="currentTab"
        :expanded="expanded"
        :docked="docked"
        :split="splitEnabled"
        @update:active-tab="selectTab"
        @toggle-expanded="toggleExpanded"
        @toggle-docked="toggleDocked"
        @toggle-split="toggleSplit"
        @close="emit('close')"
      />
    </header>

    <InspectorPaneGrid
      :primary-tab="currentTab"
      :secondary-tab="secondaryTab"
      :split="splitEnabled"
      :task-id="taskId"
      :timeline="timeline"
      :timeline-loading="timelineLoading"
      :permission-audits="permissionAudits"
      :permission-audit-cursor="permissionAuditCursor"
      :loading-more-permission-audits="loadingMorePermissionAudits"
      :show-permission-audits="showPermissionAudits"
      :changes-controller="changesController"
      :artifacts-controller="artifactsController"
      @update:primary-tab="selectTab"
      @update:secondary-tab="secondaryTab = $event"
      @load-more-permission-audits="emit('loadMorePermissionAudits')"
    />
  </aside>
</template>
