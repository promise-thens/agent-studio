<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from 'vue'
import { PhDotsThree as DotsThree } from '@phosphor-icons/vue'
import type { TaskExecutionDto } from '../../../shared/task-execution'
import type { TaskHistorySummary } from '../../../shared/task-history'
import type { WorkbenchLoadState } from '../composables/useProjectRegistry'
import {
  TASK_LIST_LINE_METRICS,
  advanceEffects,
  computeProximityTargets,
  pointerYInList,
  seedEffects,
  staticEffect
} from '../line-sidebar-proximity'
import {
  resolveTaskMenuPosition,
  shouldCloseTaskMenuOnPointerDown,
  type TaskMenuPlacement
} from '../task-list-overflow'
import { toTaskListItemView } from '../task-navigation'
import { marqueeDistancePx, marqueeDurationSeconds, titleNeedsMarquee } from '../task-title-marquee'

const props = withDefaults(
  defineProps<{
    tasks: TaskHistorySummary[]
    selectedTaskId: string
    activeExecution: Pick<TaskExecutionDto, 'taskId' | 'state'> | null
    loadState: WorkbenchLoadState
    hasMoreTasks?: boolean
    loadingMoreTasks?: boolean
    historyNavigationDisabled?: boolean
    historyNavigationDisabledReason?: string
    /** 执行中只禁用 ⋯ 变更菜单，历史行 task-main 仍可点选。 */
    mutationActionsDisabled?: boolean
    mutationActionsDisabledReason?: string
  }>(),
  {
    hasMoreTasks: false,
    loadingMoreTasks: false,
    historyNavigationDisabled: false,
    historyNavigationDisabledReason: '',
    mutationActionsDisabled: false,
    mutationActionsDisabledReason: ''
  }
)

const emit = defineEmits<{
  selectTask: [taskId: string]
  renameTask: [taskId: string, title: string]
  archiveTask: [taskId: string]
  deleteTask: [taskId: string]
  loadMoreTasks: []
  retry: []
}>()

const menuTaskId = ref('')
const menuReady = ref(false)
const menuPosition = ref<{ top: string; left: string; placement: TaskMenuPlacement } | null>(null)
const renamingTaskId = ref('')
const renameDraft = ref('')
const renameInput = ref<HTMLInputElement | null>(null)

/** 与样式中的三项菜单高度大致对齐，首帧定位用；实际尺寸在 nextTick 后重测。 */
const TASK_MENU_FALLBACK_SIZE = { width: 136, height: 96 }

const items = computed(() =>
  props.tasks.map((task) => toTaskListItemView(task, props.selectedTaskId, props.activeExecution))
)

const menuItem = computed(
  () => items.value.find((item) => item.taskId === menuTaskId.value) ?? null
)

const rowsRef = ref<HTMLElement | null>(null)
const rowEls = ref<(HTMLElement | null)[]>([])
let proximityTargets: number[] = []
let proximityCurrent: number[] = []
let proximityRaf: number | null = null
let lastProximityFrame = 0
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
const reducedMotion = ref(motionQuery.matches)

interface TitleMarqueeState {
  distancePx: number
  durationSec: number
}

const overflowByTaskId = ref<Record<string, TitleMarqueeState>>({})
const titleClipEls = new Map<string, HTMLElement>()
const titleMeasureEls = new Map<string, HTMLElement>()
let titleResizeObserver: ResizeObserver | null = null

function titleObserver(): ResizeObserver {
  titleResizeObserver ??= new ResizeObserver(() => {
    measureAllTitles()
  })
  return titleResizeObserver
}

function bindMappedEl(
  map: Map<string, HTMLElement>,
  el: Element | ComponentPublicInstance | null,
  taskId: string,
  observe: boolean
): void {
  const next = el instanceof HTMLElement ? el : null
  const prev = map.get(taskId)
  if (prev && prev !== next && observe) titleResizeObserver?.unobserve(prev)
  if (next) {
    map.set(taskId, next)
    if (observe) titleObserver().observe(next)
    return
  }
  map.delete(taskId)
}

function setTitleClipRef(el: Element | ComponentPublicInstance | null, taskId: string): void {
  bindMappedEl(titleClipEls, el, taskId, true)
}

function setTitleMeasureRef(el: Element | ComponentPublicInstance | null, taskId: string): void {
  bindMappedEl(titleMeasureEls, el, taskId, false)
}

/** 用隐藏测量条对比裁剪盒，避免 ellipsis 把 scrollWidth 压回可视宽度。 */
function measureAllTitles(): void {
  const next: Record<string, TitleMarqueeState> = {}
  if (!reducedMotion.value) {
    for (const item of items.value) {
      const clip = titleClipEls.get(item.taskId)
      const measure = titleMeasureEls.get(item.taskId)
      if (!clip || !measure) continue
      if (!titleNeedsMarquee(measure.offsetWidth, clip.clientWidth)) continue
      const distancePx = marqueeDistancePx(measure.offsetWidth)
      next[item.taskId] = {
        distancePx,
        durationSec: marqueeDurationSeconds(distancePx)
      }
    }
  }
  overflowByTaskId.value = next
}

function isOverflowing(taskId: string): boolean {
  return Boolean(overflowByTaskId.value[taskId])
}

function marqueeStyle(taskId: string): Record<string, string> | undefined {
  const state = overflowByTaskId.value[taskId]
  if (!state) return undefined
  return {
    '--marquee-distance': `${state.distancePx}px`,
    '--marquee-duration': `${state.durationSec}s`
  }
}

function setRowsRef(el: Element | ComponentPublicInstance | null): void {
  rowsRef.value = el instanceof HTMLElement ? el : null
}

function setRowRef(el: Element | ComponentPublicInstance | null, index: number): void {
  rowEls.value[index] = el instanceof HTMLElement ? el : null
}

function itemGeometry(): { offsetTop: number; offsetHeight: number; selected: boolean }[] {
  return items.value.map((item, index) => {
    const el = rowEls.value[index]
    return {
      offsetTop: el?.offsetTop ?? index * 32,
      offsetHeight: el?.offsetHeight ?? 32,
      selected: item.selected
    }
  })
}

function writeEffects(values: number[]): void {
  values.forEach((value, index) => {
    rowEls.value[index]?.style.setProperty('--effect', value.toFixed(4))
  })
}

function stopProximityLoop(): void {
  if (proximityRaf == null) return
  cancelAnimationFrame(proximityRaf)
  proximityRaf = null
}

function applyStaticSelection(): void {
  const values = items.value.map((item) => staticEffect(item.selected))
  proximityCurrent = values.slice()
  proximityTargets = values.slice()
  writeEffects(values)
}

function runProximityFrame(now: number): void {
  const dt = Math.min((now - lastProximityFrame) / 1000, 0.05)
  lastProximityFrame = now
  const tau = Math.max(TASK_LIST_LINE_METRICS.smoothingMs, 1) / 1000
  const stepped = advanceEffects(proximityCurrent, proximityTargets, 1 - Math.exp(-dt / tau))
  proximityCurrent = stepped.next
  writeEffects(proximityCurrent)
  proximityRaf = stepped.moving ? requestAnimationFrame(runProximityFrame) : null
}

function startProximityLoop(): void {
  if (reducedMotion.value || proximityRaf != null) return
  lastProximityFrame = performance.now()
  proximityRaf = requestAnimationFrame(runProximityFrame)
}

/** 把指针近距写回 --effect；离开或滚动后只保留选中行。 */
function retargetProximity(pointerY: number | null): void {
  const geometry = itemGeometry()
  proximityCurrent = seedEffects(
    proximityCurrent,
    geometry.map((item) => item.selected)
  )
  proximityTargets = computeProximityTargets(pointerY, geometry, {
    radius: TASK_LIST_LINE_METRICS.proximityRadius,
    falloff: TASK_LIST_LINE_METRICS.falloff
  })
  if (reducedMotion.value) {
    applyStaticSelection()
    return
  }
  startProximityLoop()
}

function handlePointerMove(event: PointerEvent): void {
  if (reducedMotion.value) return
  const list = rowsRef.value
  if (!list) return
  const rect = list.getBoundingClientRect()
  retargetProximity(pointerYInList(event.clientY, rect.top, list.scrollTop))
}

function handlePointerLeave(): void {
  retargetProximity(null)
}

function handleRowsScroll(): void {
  closeMenus()
  retargetProximity(null)
}

function onMotionPreferenceChange(): void {
  reducedMotion.value = motionQuery.matches
  if (reducedMotion.value) {
    stopProximityLoop()
    applyStaticSelection()
    measureAllTitles()
    return
  }
  retargetProximity(null)
  void nextTick().then(() => measureAllTitles())
}

function closeMenus(): void {
  menuTaskId.value = ''
  menuPosition.value = null
  menuReady.value = false
}

/** 用按钮视口坐标定位到 body，贴在 ⋯ 正下方；后续项目目录盖不住。 */
function placeMenu(button: HTMLElement, size = TASK_MENU_FALLBACK_SIZE): void {
  const rect = button.getBoundingClientRect()
  const next = resolveTaskMenuPosition(
    { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
    size,
    { width: window.innerWidth, height: window.innerHeight }
  )
  menuPosition.value = {
    top: `${next.top}px`,
    left: `${next.left}px`,
    placement: next.placement
  }
}

function toggleMenu(taskId: string, event: Event): void {
  if (props.mutationActionsDisabled) return
  if (menuTaskId.value === taskId) {
    closeMenus()
    return
  }
  const button = event.currentTarget
  if (!(button instanceof HTMLElement)) return
  menuReady.value = false
  placeMenu(button)
  menuTaskId.value = taskId
  void nextTick(() => {
    const menu = document.querySelector('.task-menu')
    if (!(menu instanceof HTMLElement) || menuTaskId.value !== taskId) return
    placeMenu(button, { width: menu.offsetWidth, height: menu.offsetHeight })
    requestAnimationFrame(() => {
      if (menuTaskId.value !== taskId) return
      menuReady.value = true
    })
  })
}

function setRenameInput(el: unknown): void {
  renameInput.value = el instanceof HTMLInputElement ? el : null
}

function beginRename(taskId: string, title: string): void {
  if (props.mutationActionsDisabled) return
  closeMenus()
  renamingTaskId.value = taskId
  renameDraft.value = title
}

watch(renamingTaskId, async (taskId) => {
  if (!taskId) return
  await nextTick()
  renameInput.value?.focus()
  renameInput.value?.select()
})

function cancelRename(): void {
  renamingTaskId.value = ''
  renameDraft.value = ''
}

watch(
  () => props.mutationActionsDisabled,
  (disabled) => {
    if (!disabled) return
    closeMenus()
    cancelRename()
  }
)

function commitRename(taskId: string): void {
  if (props.mutationActionsDisabled) {
    cancelRename()
    return
  }
  const title = renameDraft.value.trim()
  if (!title) {
    cancelRename()
    return
  }
  emit('renameTask', taskId, title)
  cancelRename()
}

function archive(taskId: string): void {
  if (props.mutationActionsDisabled) return
  closeMenus()
  emit('archiveTask', taskId)
}

function remove(taskId: string): void {
  if (props.mutationActionsDisabled) return
  closeMenus()
  emit('deleteTask', taskId)
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target
  if (
    shouldCloseTaskMenuOnPointerDown({
      open: Boolean(menuTaskId.value),
      insideMenu: target instanceof Element && Boolean(target.closest('.task-menu')),
      onExpandedMenuButton:
        target instanceof Element &&
        Boolean(target.closest('.task-menu-button[aria-expanded="true"]'))
    })
  ) {
    closeMenus()
  }
}

function onWindowKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !menuTaskId.value) return
  if (event.defaultPrevented || event.isComposing) return
  event.preventDefault()
  closeMenus()
}

watch(
  () => items.value.map((item) => item.taskId).join('|'),
  async () => {
    rowEls.value = rowEls.value.slice(0, items.value.length)
    proximityCurrent = []
    await nextTick()
    retargetProximity(null)
    measureAllTitles()
  }
)

watch(
  () => items.value.map((item) => `${item.taskId}:${item.title}`).join('|'),
  async () => {
    await nextTick()
    measureAllTitles()
  },
  { flush: 'post' }
)

watch(
  () => props.selectedTaskId,
  () => {
    closeMenus()
    retargetProximity(null)
  }
)

window.addEventListener('pointerdown', onDocumentPointerDown)
window.addEventListener('keydown', onWindowKeyDown)
window.addEventListener('resize', closeMenus)
motionQuery.addEventListener('change', onMotionPreferenceChange)
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocumentPointerDown)
  window.removeEventListener('keydown', onWindowKeyDown)
  window.removeEventListener('resize', closeMenus)
  motionQuery.removeEventListener('change', onMotionPreferenceChange)
  titleResizeObserver?.disconnect()
  titleResizeObserver = null
  stopProximityLoop()
})
</script>

<template>
  <section class="task-list" aria-label="对话">
    <p v-if="historyNavigationDisabled && historyNavigationDisabledReason" class="task-list-hint">
      {{ historyNavigationDisabledReason }}
    </p>
    <p v-else-if="loadState.status === 'error'" class="task-list-hint" role="status">
      {{ loadState.errorMessage || '对话列表加载失败。' }}
      <button class="task-text-button" type="button" @click="emit('retry')">重试</button>
    </p>
    <p v-else-if="loadState.status === 'loading' && !items.length" class="task-list-hint">
      正在加载对话…
    </p>

    <div
      v-if="items.length"
      :ref="setRowsRef"
      class="task-rows"
      @scroll="handleRowsScroll"
      @pointermove="handlePointerMove"
      @pointerleave="handlePointerLeave"
    >
      <div
        v-for="(item, index) in items"
        :key="item.taskId"
        :ref="(el) => setRowRef(el, index)"
        class="task-row"
        :class="{
          selected: item.selected,
          live: item.runningMarker === 'accent',
          waiting: item.waitingPermission,
          'menu-open': menuTaskId === item.taskId
        }"
      >
        <button
          v-if="renamingTaskId !== item.taskId"
          class="task-main"
          type="button"
          :disabled="historyNavigationDisabled"
          :title="item.titleAttribute"
          :aria-current="item.selected ? 'true' : undefined"
          @click="emit('selectTask', item.taskId)"
        >
          <span
            :ref="(el) => setTitleClipRef(el, item.taskId)"
            class="task-title"
            :class="{ 'is-overflow': isOverflowing(item.taskId) }"
            :style="marqueeStyle(item.taskId)"
          >
            <span
              :ref="(el) => setTitleMeasureRef(el, item.taskId)"
              class="task-title-measure"
              aria-hidden="true"
              >{{ item.title }}</span
            >
            <span class="task-title-track">
              <span class="task-title-copy">{{ item.title }}</span>
              <span
                v-if="isOverflowing(item.taskId)"
                class="task-title-copy task-title-loop"
                aria-hidden="true"
                >{{ item.title }}</span
              >
            </span>
          </span>
        </button>
        <input
          v-else
          :ref="setRenameInput"
          v-model="renameDraft"
          class="task-rename"
          aria-label="重命名对话"
          @keydown.enter.prevent="commitRename(item.taskId)"
          @keydown.esc.prevent="cancelRename"
          @blur="commitRename(item.taskId)"
        />
        <button
          class="task-menu-button"
          type="button"
          :disabled="mutationActionsDisabled"
          :title="
            mutationActionsDisabled
              ? mutationActionsDisabledReason || '对话操作暂不可用'
              : '对话操作'
          "
          :aria-label="`对话操作：${item.title}`"
          :aria-expanded="menuTaskId === item.taskId"
          @click.stop="toggleMenu(item.taskId, $event)"
        >
          <DotsThree :size="16" weight="bold" />
        </button>
      </div>
      <button
        v-if="hasMoreTasks"
        class="task-text-button load-more"
        type="button"
        :disabled="loadingMoreTasks || historyNavigationDisabled"
        :aria-busy="loadingMoreTasks"
        @click="emit('loadMoreTasks')"
      >
        {{ loadingMoreTasks ? '正在加载…' : '加载更多' }}
      </button>
    </div>

    <p
      v-else-if="loadState.status !== 'loading' && loadState.status !== 'error'"
      class="task-empty"
    >
      暂无对话
    </p>

    <Teleport to="body">
      <div
        v-if="menuItem && menuPosition"
        class="task-menu"
        :class="{ ready: menuReady }"
        :data-placement="menuPosition.placement"
        role="menu"
        :style="{
          position: 'fixed',
          zIndex: 40,
          top: menuPosition.top,
          left: menuPosition.left
        }"
      >
        <button
          type="button"
          role="menuitem"
          :disabled="mutationActionsDisabled"
          @click="beginRename(menuItem.taskId, menuItem.title)"
        >
          重命名
        </button>
        <button
          type="button"
          role="menuitem"
          :disabled="mutationActionsDisabled || !menuItem.canArchiveOrDelete"
          :title="menuItem.canArchiveOrDelete ? '归档对话' : '执行中不能归档'"
          @click="archive(menuItem.taskId)"
        >
          归档
        </button>
        <button
          type="button"
          role="menuitem"
          class="danger"
          :disabled="mutationActionsDisabled || !menuItem.canArchiveOrDelete"
          :title="menuItem.canArchiveOrDelete ? '删除记录' : '执行中不能删除'"
          @click="remove(menuItem.taskId)"
        >
          删除记录
        </button>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
/* basis auto：父级按内容高时不塌成 0；父级被压缩时仍可收缩并滚动。 */
.task-list {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  flex-direction: column;
  gap: 4px;
}

.task-list-hint {
  margin: 0;
  padding: 6px 10px;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.5;
}

/* 空列表在展开目录里水平居中，不要贴左看起来像漏排。 */
.task-empty {
  margin: 0;
  padding: 12px 10px;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.5;
  text-align: center;
}

.task-rows {
  position: relative;
  display: flex;
  min-height: 0;
  flex-direction: column;
  overflow-x: hidden;
  overflow-y: auto;
}

.task-row {
  --effect: 0;
  --max-shift: 8px;
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
}

.task-row.selected {
  --effect: 1;
}

.task-main,
.task-menu-button,
.task-text-button,
.task-menu button {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.task-main {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 6px 0 28px;
  color: var(--text-2);
  font-size: 13px;
  text-align: left;
}

.task-main:disabled,
.task-menu-button:disabled,
.task-menu button:disabled,
.task-text-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.task-title {
  --marquee-gap: 40px;
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  transform: translateX(calc(var(--effect, 0) * var(--max-shift)));
  color: color-mix(in srgb, var(--accent) calc(var(--effect, 0) * 55%), var(--text-2));
}

.task-row.selected .task-title,
.task-row.live .task-title {
  color: color-mix(in srgb, var(--accent) 42%, var(--text-1));
}

.task-title-measure {
  position: absolute;
  left: 0;
  top: 0;
  visibility: hidden;
  white-space: nowrap;
  pointer-events: none;
}

.task-title-track {
  display: block;
  min-width: 0;
  overflow: hidden;
}

.task-title-copy {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-title-loop {
  display: none;
}

.task-row.selected .task-title.is-overflow .task-title-track,
.task-row:hover .task-title.is-overflow .task-title-track {
  display: inline-flex;
  gap: var(--marquee-gap);
  width: max-content;
  overflow: visible;
  animation: task-title-marquee var(--marquee-duration, 8s) linear infinite;
}

.task-row.selected .task-title.is-overflow .task-title-copy,
.task-row:hover .task-title.is-overflow .task-title-copy {
  overflow: visible;
  text-overflow: clip;
  flex: 0 0 auto;
}

.task-row.selected .task-title.is-overflow .task-title-loop,
.task-row:hover .task-title.is-overflow .task-title-loop {
  display: block;
}

@keyframes task-title-marquee {
  0%,
  14% {
    transform: translateX(0);
  }
  100% {
    transform: translateX(calc(-1 * var(--marquee-distance, 0px)));
  }
}

.task-rename {
  flex: 1;
  min-width: 0;
  height: 28px;
  margin: 2px 4px 2px 24px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text-1);
  background: var(--surface-2);
  font-size: 13px;
}

.task-menu-button {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-right: 4px;
  border-radius: var(--radius-chip);
  color: var(--text-3);
  opacity: 0;
  pointer-events: none;
}

.task-row:hover .task-menu-button,
.task-row:focus-within .task-menu-button,
.task-row.menu-open .task-menu-button {
  opacity: 1;
  pointer-events: auto;
}

.task-main:not(:disabled):hover {
  color: var(--text-1);
}

.task-menu-button:not(:disabled):hover,
.task-text-button:not(:disabled):hover,
.task-menu button:not(:disabled):hover {
  color: var(--text-1);
  background: var(--hover-fill);
}

.task-menu {
  -webkit-app-region: no-drag;
  position: fixed;
  z-index: 40;
  display: grid;
  min-width: 136px;
  padding: 4px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--surface-2);
  box-shadow: 0 12px 32px color-mix(in srgb, var(--text-1) 18%, transparent);
  transform-origin: top right;
  opacity: 0;
  transform: translateY(-6px) scale(0.96);
  pointer-events: none;
}

.task-menu[data-placement='above'] {
  transform-origin: bottom right;
  transform: translateY(6px) scale(0.96);
}

.task-menu.ready {
  opacity: 1;
  transform: none;
  pointer-events: auto;
  transition:
    opacity 160ms ease,
    transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.task-menu button {
  min-height: 28px;
  padding: 0 8px;
  border-radius: 7px;
  color: var(--text-2);
  font-size: 12px;
  text-align: left;
}

.task-menu button.danger:not(:disabled):hover {
  color: var(--danger);
}

.task-text-button {
  color: var(--text-3);
  font-size: 11px;
}

.task-text-button.load-more {
  width: 100%;
  min-height: 30px;
}

@media (prefers-reduced-motion: reduce) {
  .task-title {
    transform: none;
  }

  .task-title-track {
    animation: none;
  }

  .task-menu-button {
    opacity: 1;
    pointer-events: auto;
  }

  .task-menu,
  .task-menu.ready,
  .task-menu[data-placement='above'] {
    transform: none;
    transition: none;
  }
}
</style>
