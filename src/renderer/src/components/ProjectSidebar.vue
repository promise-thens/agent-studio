<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  PhCaretDown as CaretDown,
  PhDotsThree as DotsThree,
  PhFolder as Folder,
  PhFolderOpen as FolderOpen,
  PhGearSix as GearSix,
  PhNotePencil as NotePencil
} from '@phosphor-icons/vue'
import type { ProjectSummary, TaskHistorySummary } from '../../../shared/task-history'
import type { TaskExecutionDto } from '../../../shared/task-execution'
import {
  createWorkbenchLoadState,
  type WorkbenchLoadState
} from '../composables/useProjectRegistry'
import { resolveProjectAccordionToggle, tasksForExpandedProject } from '../task-navigation'
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
    browseProjectId?: string
    browseTasks?: TaskHistorySummary[]
    browseLoadState?: WorkbenchLoadState
    browseHasMore?: boolean
    browseLoadingMore?: boolean
  }>(),
  {
    newChatDisabled: false,
    newChatDisabledReason: '',
    historyNavigationDisabled: false,
    historyNavigationDisabledReason: '',
    mutationActionsDisabled: false,
    mutationActionsDisabledReason: '',
    hasMoreTasks: false,
    loadingMoreTasks: false,
    browseProjectId: '',
    browseTasks: () => [],
    browseLoadState: () => createWorkbenchLoadState(),
    browseHasMore: false,
    browseLoadingMore: false
  }
)

const emit = defineEmits<{
  newChat: [projectId: string]
  openSettings: []
  selectProject: [projectId: string]
  chooseProject: []
  retryAccess: [projectId: string]
  openProjectFolder: [projectId: string]
  removeProject: [projectId: string]
  deleteProjectHistory: [projectId: string]
  retryProjects: []
  selectTask: [taskId: string]
  renameTask: [taskId: string, title: string]
  archiveTask: [taskId: string]
  deleteTask: [taskId: string]
  loadMoreTasks: []
  retryTaskList: []
  browseProject: [projectId: string]
  loadMoreBrowseTasks: []
  retryBrowseTasks: []
}>()

const expandedProjectId = ref(props.selectedProjectId)
const actionProjectId = ref('')

const visibleProjects = computed(() =>
  props.projects.filter((project) => project.status === 'active')
)

watch(
  () => props.selectedProjectId,
  (projectId) => {
    if (projectId) expandedProjectId.value = projectId
  }
)

function isExpanded(projectId: string): boolean {
  return expandedProjectId.value === projectId
}

function isCurrent(projectId: string): boolean {
  return projectId === props.selectedProjectId
}

function projectLive(projectId: string): boolean {
  return (props.runningTaskCountByProjectId[projectId] ?? 0) > 0
}

function availabilityLabel(project: ProjectSummary): string {
  if (project.availability.state === 'available') return ''
  if (project.availability.state === 'unavailable') return '目录不可用'
  if (project.availability.state === 'version-unsupported') return '版本不支持'
  return '记录损坏'
}

function closeProjectActions(): void {
  actionProjectId.value = ''
}

/** 点标题只折叠或展开；展开其它项目时拉浏览列表，不切当前对话。 */
function toggleProject(projectId: string): void {
  if (props.historyNavigationDisabled) return
  closeProjectActions()
  const next = resolveProjectAccordionToggle({
    expandedProjectId: expandedProjectId.value,
    selectedProjectId: props.selectedProjectId,
    clickedProjectId: projectId
  })
  expandedProjectId.value = next.expandedProjectId
  if (next.shouldSelect) emit('selectProject', projectId)
  if (next.shouldBrowse) emit('browseProject', projectId)
}

function expandedTasks(projectId: string): TaskHistorySummary[] {
  return tasksForExpandedProject({
    expandedProjectId: projectId,
    selectedProjectId: props.selectedProjectId,
    selectedTasks: props.tasks,
    browseProjectId: props.browseProjectId,
    browseTasks: props.browseTasks
  })
}

function expandedLoadState(projectId: string): WorkbenchLoadState {
  return projectId === props.selectedProjectId ? props.taskListLoadState : props.browseLoadState
}

function expandedHasMore(projectId: string): boolean {
  return projectId === props.selectedProjectId ? props.hasMoreTasks : props.browseHasMore
}

function expandedLoadingMore(projectId: string): boolean {
  return projectId === props.selectedProjectId ? props.loadingMoreTasks : props.browseLoadingMore
}

function onLoadMoreTasks(): void {
  if (expandedProjectId.value === props.selectedProjectId) emit('loadMoreTasks')
  else emit('loadMoreBrowseTasks')
}

function onRetryTaskList(): void {
  if (expandedProjectId.value === props.selectedProjectId) emit('retryTaskList')
  else emit('retryBrowseTasks')
}

function toggleProjectActions(projectId: string, event: Event): void {
  event.stopPropagation()
  if (props.mutationActionsDisabled) return
  actionProjectId.value = actionProjectId.value === projectId ? '' : projectId
}

function retryAccess(projectId: string): void {
  closeProjectActions()
  emit('retryAccess', projectId)
}

function removeProject(projectId: string): void {
  closeProjectActions()
  emit('removeProject', projectId)
}

function deleteProjectHistory(projectId: string): void {
  closeProjectActions()
  emit('deleteProjectHistory', projectId)
}

function openProjectFolder(projectId: string): void {
  closeProjectActions()
  emit('openProjectFolder', projectId)
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target
  if (!(target instanceof Element)) {
    closeProjectActions()
    return
  }
  if (target.closest('.project-actions')) return
  if (target.closest('.project-action-button[aria-expanded="true"]')) return
  closeProjectActions()
}

window.addEventListener('pointerdown', onDocumentPointerDown)
onBeforeUnmount(() => window.removeEventListener('pointerdown', onDocumentPointerDown))
</script>

<template>
  <aside class="project-sidebar" aria-label="项目与对话">
    <div class="sidebar-toolbar">
      <button
        class="new-project"
        type="button"
        :disabled="mutationActionsDisabled"
        :title="mutationActionsDisabledReason || '注册本地项目'"
        aria-label="新建项目"
        @click="emit('chooseProject')"
      >
        <FolderOpen :size="15" />
        <span>新建项目</span>
      </button>
      <button
        class="icon-button"
        type="button"
        title="设置"
        aria-label="设置"
        @click="emit('openSettings')"
      >
        <GearSix :size="15" />
      </button>
    </div>

    <p v-if="projectLoadState.status === 'error'" class="tree-hint" role="status">
      {{ projectLoadState.errorMessage || '项目列表加载失败。' }}
      <button class="text-button" type="button" @click="emit('retryProjects')">重试</button>
    </p>
    <p v-else-if="historyNavigationDisabled && historyNavigationDisabledReason" class="tree-hint">
      {{ historyNavigationDisabledReason }}
    </p>

    <div class="project-tree">
      <section
        v-for="project in visibleProjects"
        :key="project.projectId"
        class="project-block"
        :class="{ 'is-expanded': isExpanded(project.projectId) }"
      >
        <div class="project-header-row">
          <button
            class="project-header"
            :class="{
              'project-current': isCurrent(project.projectId),
              live: projectLive(project.projectId),
              open: isExpanded(project.projectId)
            }"
            type="button"
            :disabled="historyNavigationDisabled"
            :title="project.canonicalRoot"
            :aria-expanded="isExpanded(project.projectId)"
            @click="toggleProject(project.projectId)"
          >
            <CaretDown class="caret" :class="{ open: isExpanded(project.projectId) }" :size="12" />
            <FolderOpen v-if="isExpanded(project.projectId)" class="project-folder" :size="14" />
            <Folder v-else class="project-folder" :size="14" />
            <strong>{{ project.displayName }}</strong>
            <span v-if="runningTaskCountByProjectId[project.projectId]" class="run-count">
              {{ runningTaskCountByProjectId[project.projectId] }}
            </span>
            <small v-if="availabilityLabel(project)" class="unavailable">
              {{ availabilityLabel(project) }}
            </small>
          </button>
          <button
            v-if="isExpanded(project.projectId)"
            class="icon-button"
            type="button"
            :disabled="newChatDisabled"
            :title="newChatDisabledReason || '新对话'"
            aria-label="新对话"
            @click="emit('newChat', project.projectId)"
          >
            <NotePencil :size="15" />
          </button>
          <button
            class="icon-button project-action-button"
            type="button"
            :disabled="mutationActionsDisabled"
            :title="mutationActionsDisabledReason || '项目操作'"
            :aria-label="`项目操作：${project.displayName}`"
            :aria-expanded="actionProjectId === project.projectId"
            @click="toggleProjectActions(project.projectId, $event)"
          >
            <DotsThree :size="16" weight="bold" />
          </button>
          <div v-if="actionProjectId === project.projectId" class="project-actions" role="menu">
            <button
              v-if="project.availability.state !== 'available'"
              type="button"
              role="menuitem"
              :disabled="mutationActionsDisabled"
              @click="retryAccess(project.projectId)"
            >
              重试访问
            </button>
            <button
              type="button"
              role="menuitem"
              :disabled="mutationActionsDisabled"
              @click="openProjectFolder(project.projectId)"
            >
              打开文件夹
            </button>
            <button
              type="button"
              role="menuitem"
              :disabled="mutationActionsDisabled"
              @click="removeProject(project.projectId)"
            >
              移除记录
            </button>
            <button
              type="button"
              role="menuitem"
              class="danger"
              :disabled="mutationActionsDisabled"
              @click="deleteProjectHistory(project.projectId)"
            >
              删除本地历史
            </button>
          </div>
        </div>

        <Transition name="project-fold">
          <div v-if="isExpanded(project.projectId)" class="project-fold">
            <div class="project-fold-clip">
              <TaskList
                :tasks="expandedTasks(project.projectId)"
                :selected-task-id="selectedTaskId"
                :active-execution="activeExecution"
                :load-state="expandedLoadState(project.projectId)"
                :has-more-tasks="expandedHasMore(project.projectId)"
                :loading-more-tasks="expandedLoadingMore(project.projectId)"
                :history-navigation-disabled="historyNavigationDisabled"
                :history-navigation-disabled-reason="historyNavigationDisabledReason"
                :mutation-actions-disabled="mutationActionsDisabled"
                :mutation-actions-disabled-reason="mutationActionsDisabledReason"
                @select-task="emit('selectTask', $event)"
                @rename-task="(taskId, title) => emit('renameTask', taskId, title)"
                @archive-task="emit('archiveTask', $event)"
                @delete-task="emit('deleteTask', $event)"
                @load-more-tasks="onLoadMoreTasks"
                @retry="onRetryTaskList"
              />
            </div>
          </div>
        </Transition>
      </section>
    </div>
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

.new-project,
.project-header,
.icon-button,
.project-actions button,
.text-button {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.new-project {
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
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-chip);
  color: var(--text-3);
}

.new-project:not(:disabled):hover,
.icon-button:hover,
.project-header:not(:disabled):hover,
.project-actions button:not(:disabled):hover,
.text-button:hover {
  background: var(--hover-fill);
  color: var(--text-1);
}

.new-project:disabled,
.icon-button:disabled,
.project-header:disabled,
.project-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.tree-hint {
  margin: 0;
  padding: 4px 12px;
  color: var(--text-3);
  font-size: 11px;
}

.project-tree {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}

.project-block {
  flex: 0 0 auto;
}

/* 按内容长高，剩余空白留在树底部；空间不够再收缩，交给内部对话列表滚动。 */
.project-block.is-expanded {
  display: flex;
  min-height: 0;
  flex: 0 1 auto;
  flex-direction: column;
  overflow: hidden;
}

.project-header-row {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
  padding: 0 6px 0 4px;
}

/* 0fr→1fr 才能跟着内容长高；收起时列表还在，才能看见折叠。 */
.project-fold {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-rows: 1fr;
}

.project-block.is-expanded > .project-fold {
  flex: 1 1 auto;
}

.project-fold-clip {
  min-height: 0;
  overflow: hidden;
}

.project-fold-enter-active,
.project-fold-leave-active {
  transition:
    grid-template-rows 200ms cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 160ms ease;
}

.project-fold-enter-active .project-fold-clip,
.project-fold-leave-active .project-fold-clip {
  transition:
    transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 160ms ease;
}

.project-fold-enter-from,
.project-fold-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
}

.project-fold-enter-from .project-fold-clip,
.project-fold-leave-to .project-fold-clip {
  transform: translateY(-6px);
}

.project-header {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 0 6px;
  border-radius: var(--radius-soft);
  text-align: left;
}

.project-header.live {
  color: var(--text-1);
}

.project-header.project-current strong {
  color: var(--text-1);
}

.caret {
  flex: 0 0 auto;
  color: var(--text-3);
  transform: rotate(-90deg);
  transition: transform 140ms ease;
}

.caret.open {
  transform: rotate(0deg);
}

.project-folder {
  flex: 0 0 auto;
  color: var(--text-3);
}

.project-header.open .project-folder,
.project-header.project-current .project-folder {
  color: var(--accent);
}

.project-header strong {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--text-2);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.project-actions {
  position: absolute;
  z-index: 8;
  top: 30px;
  right: 8px;
  display: grid;
  min-width: 132px;
  padding: 4px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--surface-2);
  box-shadow: 0 12px 32px color-mix(in srgb, var(--text-1) 18%, transparent);
}

.project-actions button {
  min-height: 28px;
  padding: 0 8px;
  border-radius: 7px;
  color: var(--text-2);
  font-size: 12px;
  text-align: left;
}

.project-actions button.danger:not(:disabled):hover {
  color: var(--danger);
}

.text-button {
  margin-left: 6px;
  color: var(--text-2);
}

@media (prefers-reduced-motion: reduce) {
  .caret {
    transition: none;
  }

  .project-fold-enter-active,
  .project-fold-leave-active,
  .project-fold-enter-active .project-fold-clip,
  .project-fold-leave-active .project-fold-clip {
    transition: none;
  }
}
</style>
