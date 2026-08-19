<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { PhDotsThree as DotsThree } from '@phosphor-icons/vue'
import type { TaskExecutionDto } from '../../../shared/task-execution'
import type { HistoryExecutionState, TaskHistorySummary } from '../../../shared/task-history'
import type { WorkbenchLoadState } from '../composables/useProjectRegistry'
import { toTaskListItemView } from '../task-navigation'

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
const renamingTaskId = ref('')
const renameDraft = ref('')
const renameInput = ref<HTMLInputElement | null>(null)

const items = computed(() =>
  props.tasks.map((task) => toTaskListItemView(task, props.selectedTaskId, props.activeExecution))
)

function stateLabel(state: HistoryExecutionState, waitingPermission: boolean): string {
  if (waitingPermission) return '待审批'
  if (state === 'running') return '进行中'
  if (state === 'failed') return '失败'
  if (state === 'cancelled') return '已取消'
  if (state === 'interrupted') return '已中断'
  if (state === 'queued') return '排队'
  if (state === 'cancelling') return '停止中'
  return ''
}

function closeMenus(): void {
  menuTaskId.value = ''
}

function toggleMenu(taskId: string): void {
  if (props.mutationActionsDisabled) return
  menuTaskId.value = menuTaskId.value === taskId ? '' : taskId
}

function setRenameInput(el: unknown): void {
  renameInput.value = el instanceof HTMLInputElement ? el : null
}

function beginRename(taskId: string, title: string): void {
  if (props.mutationActionsDisabled) return
  menuTaskId.value = ''
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
  menuTaskId.value = ''
  emit('archiveTask', taskId)
}

function remove(taskId: string): void {
  if (props.mutationActionsDisabled) return
  menuTaskId.value = ''
  emit('deleteTask', taskId)
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target
  if (!(target instanceof Node)) return
  const host = document.querySelector('.task-list')
  if (host && !host.contains(target)) closeMenus()
}

window.addEventListener('pointerdown', onDocumentPointerDown)
onBeforeUnmount(() => window.removeEventListener('pointerdown', onDocumentPointerDown))
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

    <div v-if="items.length" class="task-rows">
      <div
        v-for="item in items"
        :key="item.taskId"
        class="task-row"
        :class="{
          selected: item.selected,
          live: item.live,
          waiting: item.waitingPermission
        }"
      >
        <button
          v-if="renamingTaskId !== item.taskId"
          class="task-main"
          type="button"
          :disabled="historyNavigationDisabled"
          :title="item.title"
          :aria-current="item.selected ? 'true' : undefined"
          @click="emit('selectTask', item.taskId)"
        >
          <span class="task-title">{{ item.title }}</span>
          <small v-if="stateLabel(item.state, item.waitingPermission)" class="task-state">
            {{ stateLabel(item.state, item.waitingPermission) }}
          </small>
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
          @click.stop="toggleMenu(item.taskId)"
        >
          <DotsThree :size="16" weight="bold" />
        </button>
        <div v-if="menuTaskId === item.taskId" class="task-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            :disabled="mutationActionsDisabled"
            @click="beginRename(item.taskId, item.title)"
          >
            重命名
          </button>
          <button
            type="button"
            role="menuitem"
            :disabled="mutationActionsDisabled || !item.canArchiveOrDelete"
            :title="item.canArchiveOrDelete ? '归档对话' : '运行中或等待审批时不能归档'"
            @click="archive(item.taskId)"
          >
            归档
          </button>
          <button
            type="button"
            role="menuitem"
            class="danger"
            :disabled="mutationActionsDisabled || !item.canArchiveOrDelete"
            :title="item.canArchiveOrDelete ? '删除记录' : '运行中或等待审批时不能删除'"
            @click="remove(item.taskId)"
          >
            删除记录
          </button>
        </div>
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
  </section>
</template>

<style scoped>
.task-list {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 4px;
}

.task-list-hint,
.task-empty {
  margin: 0;
  padding: 6px 10px;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.5;
}

.task-rows {
  display: flex;
  min-height: 0;
  flex-direction: column;
  overflow: auto;
}

.task-row {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  border-left: 2px solid transparent;
}

.task-row.live {
  border-left-color: var(--accent);
}

.task-row.waiting {
  border-left-color: color-mix(in srgb, var(--accent) 70%, var(--warning, #d9b25f));
}

.task-row.selected {
  background: rgba(255, 255, 255, 0.05);
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
  padding: 0 6px 0 10px;
  color: var(--text-2);
  font-size: 13px;
  text-align: left;
}

.task-row.selected .task-main {
  color: var(--text-1);
}

.task-main:disabled,
.task-menu-button:disabled,
.task-menu button:disabled,
.task-text-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.task-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-state {
  flex: 0 0 auto;
  color: var(--text-3);
  font-size: 10px;
}

.task-rename {
  flex: 1;
  min-width: 0;
  height: 28px;
  margin: 2px 4px 2px 8px;
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
}

.task-menu-button:not(:disabled):hover,
.task-main:not(:disabled):hover,
.task-text-button:not(:disabled):hover,
.task-menu button:not(:disabled):hover {
  color: var(--text-1);
  background: rgba(255, 255, 255, 0.04);
}

.task-menu {
  position: absolute;
  z-index: 3;
  top: 30px;
  right: 6px;
  display: grid;
  min-width: 112px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
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
</style>
