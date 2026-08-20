<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import {
  PhCaretDown as CaretDown,
  PhFolderOpen as FolderOpen,
  PhGearSix as GearSix,
  PhNotePencil as NotePencil
} from '@phosphor-icons/vue'
import type { ProjectSummary, TaskHistorySummary } from '../../../shared/task-history'
import type { TaskExecutionDto } from '../../../shared/task-execution'
import type { WorkbenchLoadState } from '../composables/useProjectRegistry'
import { toProjectSwitcherRow } from '../task-navigation'
import TaskList from './TaskList.vue'

const props = withDefaults(
  defineProps<{
    projects: ProjectSummary[]
    selectedProjectId: string
    runningTaskCountByProjectId: Record<string, number>
    projectLoadState: WorkbenchLoadState
    tasks: TaskHistorySummary[]
    selectedTaskId: string
    activeExecution: Pick<TaskExecutionDto, 'taskId' | 'state'> | null
    taskListLoadState: WorkbenchLoadState
    newChatDisabled?: boolean
    newChatDisabledReason?: string
    historyNavigationDisabled?: boolean
    historyNavigationDisabledReason?: string
    mutationActionsDisabled?: boolean
    mutationActionsDisabledReason?: string
    hasMoreTasks?: boolean
    loadingMoreTasks?: boolean
  }>(),
  {
    newChatDisabled: false,
    newChatDisabledReason: '',
    historyNavigationDisabled: false,
    historyNavigationDisabledReason: '',
    mutationActionsDisabled: false,
    mutationActionsDisabledReason: '',
    hasMoreTasks: false,
    loadingMoreTasks: false
  }
)

const emit = defineEmits<{
  newChat: []
  openSettings: []
  selectProject: [projectId: string]
  chooseProject: []
  retryAccess: [projectId: string]
  removeProject: [projectId: string]
  deleteProjectHistory: [projectId: string]
  retryProjects: []
  selectTask: [taskId: string]
  renameTask: [taskId: string, title: string]
  archiveTask: [taskId: string]
  deleteTask: [taskId: string]
  loadMoreTasks: []
  retryTaskList: []
}>()

const projectMenuOpen = ref(false)

const visibleProjects = computed(() =>
  props.projects.filter((project) => project.status === 'active')
)

const selectedProject = computed(
  () =>
    visibleProjects.value.find((project) => project.projectId === props.selectedProjectId) ?? null
)

const currentProjectRow = computed(() =>
  toProjectSwitcherRow({
    displayName: selectedProject.value?.displayName,
    canonicalRoot: selectedProject.value?.canonicalRoot,
    runningTaskCount: selectedProject.value
      ? props.runningTaskCountByProjectId[selectedProject.value.projectId]
      : 0
  })
)

function pathHint(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments.slice(-2).join('/') || path
}

function openedAtLabel(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function availabilityLabel(project: ProjectSummary): string {
  if (project.availability.state === 'available') return ''
  if (project.availability.state === 'unavailable') return '目录不可用'
  if (project.availability.state === 'version-unsupported') return '版本不支持'
  return '记录损坏'
}

function closeProjectMenus(): void {
  projectMenuOpen.value = false
}

function toggleProjectMenu(): void {
  projectMenuOpen.value = !projectMenuOpen.value
}

function choose(projectId: string): void {
  closeProjectMenus()
  emit('selectProject', projectId)
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target
  if (!(target instanceof Node)) return
  const host = document.querySelector('.project-switcher')
  if (host && !host.contains(target)) closeProjectMenus()
}

window.addEventListener('pointerdown', onDocumentPointerDown)
onBeforeUnmount(() => window.removeEventListener('pointerdown', onDocumentPointerDown))
</script>

<template>
  <aside class="project-sidebar" aria-label="项目与对话">
    <div class="sidebar-toolbar">
      <button
        class="new-chat"
        type="button"
        :disabled="newChatDisabled"
        :title="newChatDisabledReason || '新对话'"
        aria-label="新对话"
        @click="emit('newChat')"
      >
        <NotePencil :size="15" />
        <span>新对话</span>
      </button>
      <button
        class="icon-button"
        type="button"
        title="模型设置"
        aria-label="模型设置"
        @click="emit('openSettings')"
      >
        <GearSix :size="15" />
      </button>
    </div>

    <div class="project-switcher">
      <button
        class="project-current"
        type="button"
        :class="{ live: currentProjectRow.live }"
        :disabled="historyNavigationDisabled"
        :title="currentProjectRow.titleAttribute"
        :aria-expanded="projectMenuOpen"
        aria-haspopup="listbox"
        @click="toggleProjectMenu"
      >
        <span class="project-current-copy">
          <strong>{{ currentProjectRow.label }}</strong>
        </span>
        <small v-if="selectedProject && availabilityLabel(selectedProject)" class="unavailable">
          {{ availabilityLabel(selectedProject) }}
        </small>
        <CaretDown :size="12" />
      </button>

      <div v-if="projectMenuOpen" class="project-menu" role="listbox" aria-label="项目列表">
        <p v-if="projectLoadState.status === 'error'" class="menu-hint" role="status">
          {{ projectLoadState.errorMessage || '项目列表加载失败。' }}
          <button type="button" @click="emit('retryProjects')">重试</button>
        </p>
        <button
          v-for="project in visibleProjects"
          :key="project.projectId"
          class="project-option"
          type="button"
          role="option"
          :aria-selected="project.projectId === selectedProjectId"
          :class="{ selected: project.projectId === selectedProjectId }"
          @click="choose(project.projectId)"
        >
          <span class="project-option-copy">
            <strong>{{ project.displayName }}</strong>
            <small :title="project.canonicalRoot">{{ pathHint(project.canonicalRoot) }}</small>
            <small v-if="openedAtLabel(project.lastOpenedAt)">
              最近打开 {{ openedAtLabel(project.lastOpenedAt) }}
            </small>
          </span>
          <span v-if="runningTaskCountByProjectId[project.projectId]" class="run-count">
            {{ runningTaskCountByProjectId[project.projectId] }}
          </span>
          <small v-if="availabilityLabel(project)" class="unavailable">
            {{ availabilityLabel(project) }}
          </small>
        </button>
        <button
          class="project-option action"
          type="button"
          :disabled="mutationActionsDisabled"
          :title="mutationActionsDisabledReason || '选择目录注册项目'"
          @click="emit('chooseProject')"
        >
          <FolderOpen :size="14" />
          选择目录
        </button>
        <template v-if="selectedProject">
          <button
            v-if="selectedProject.availability.state !== 'available'"
            class="project-option action"
            type="button"
            :disabled="mutationActionsDisabled"
            @click="emit('retryAccess', selectedProject.projectId)"
          >
            重试访问
          </button>
          <button
            class="project-option action"
            type="button"
            :disabled="mutationActionsDisabled"
            @click="emit('removeProject', selectedProject.projectId)"
          >
            移除记录
          </button>
          <button
            class="project-option action danger"
            type="button"
            :disabled="mutationActionsDisabled"
            @click="emit('deleteProjectHistory', selectedProject.projectId)"
          >
            删除本地历史
          </button>
        </template>
      </div>
    </div>

    <TaskList
      :tasks="tasks"
      :selected-task-id="selectedTaskId"
      :active-execution="activeExecution"
      :load-state="taskListLoadState"
      :has-more-tasks="hasMoreTasks"
      :loading-more-tasks="loadingMoreTasks"
      :history-navigation-disabled="historyNavigationDisabled"
      :history-navigation-disabled-reason="historyNavigationDisabledReason"
      :mutation-actions-disabled="mutationActionsDisabled"
      :mutation-actions-disabled-reason="mutationActionsDisabledReason"
      @select-task="emit('selectTask', $event)"
      @rename-task="(taskId, title) => emit('renameTask', taskId, title)"
      @archive-task="emit('archiveTask', $event)"
      @delete-task="emit('deleteTask', $event)"
      @load-more-tasks="emit('loadMoreTasks')"
      @retry="emit('retryTaskList')"
    />
  </aside>
</template>

<style scoped>
.project-sidebar {
  display: flex;
  min-width: 0;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  background: var(--app-bg);
  color: var(--text-2);
}

.sidebar-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 8px 6px;
}

.new-chat,
.project-current,
.project-option,
.icon-button {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.new-chat {
  display: inline-flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 10px;
  border-radius: var(--radius-soft);
  color: var(--text-1);
  font-size: 13px;
}

.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-chip);
  color: var(--text-3);
}

.new-chat:not(:disabled):hover,
.icon-button:hover,
.project-current:not(:disabled):hover,
.project-option:not(:disabled):hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-1);
}

.new-chat:disabled,
.project-current:disabled,
.project-option:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.project-switcher {
  position: relative;
  padding: 0 8px 8px;
}

.project-current {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 8px;
  border-left: 2px solid transparent;
  border-radius: var(--radius-soft);
  text-align: left;
}

.project-current.live {
  border-left-color: var(--accent);
}

.project-current-copy,
.project-option-copy {
  min-width: 0;
  flex: 1;
}

.project-current-copy,
.project-option-copy,
.project-current-copy strong,
.project-option-copy strong,
.project-option-copy small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-current-copy strong,
.project-option-copy strong {
  color: var(--text-1);
  font-size: 13px;
  font-weight: 600;
}

.project-current-copy small,
.project-option-copy small {
  margin-top: 2px;
  color: var(--text-3);
  font-size: 10px;
}

.run-count {
  flex: 0 0 auto;
  min-width: 16px;
  padding: 0 5px;
  border-radius: var(--radius-chip);
  color: var(--accent);
  font-size: 10px;
}

.unavailable {
  flex: 0 0 auto;
  color: var(--warning, #d9b25f);
  font-size: 10px;
}

.project-menu {
  position: absolute;
  z-index: 4;
  top: calc(100% - 4px);
  right: 8px;
  left: 8px;
  display: grid;
  gap: 2px;
  max-height: 280px;
  overflow: auto;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
}

.project-option {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  padding: 6px 8px;
  border-radius: 8px;
  text-align: left;
}

.project-option.selected {
  background: rgba(255, 255, 255, 0.05);
}

.project-option.action {
  min-height: 32px;
  color: var(--text-2);
  font-size: 12px;
}

.project-option.action.danger:not(:disabled):hover {
  color: var(--danger);
}

.menu-hint {
  margin: 0;
  padding: 4px 6px;
  color: var(--text-3);
  font-size: 11px;
}

.menu-hint button {
  border: 0;
  margin-left: 6px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}
</style>
