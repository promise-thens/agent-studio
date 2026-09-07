<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  PhArrowClockwise as ArrowClockwise,
  PhCaretRight as CaretRight,
  PhFile as File,
  PhFolder as Folder
} from '@phosphor-icons/vue'
import { buildTurnRewindPreview } from '../../../shared/turn-rewind-preview'
import type { TaskChangesController } from '../composables/useTaskChanges'
import {
  attributionLabel,
  canRestoreLatestTurn,
  changeSetReadiness,
  changeSetWarnings,
  filterChangeFileTree,
  flattenChangeTreeRows,
  formatChangeLineDelta,
  gitPresenceNotice,
  incompleteReviewPaths,
  omittedLabel,
  presentChangeCard,
  presentChangeFileTree,
  presentChangeSetSummary,
  unverifiedTaskPaths
} from '../task-changes-presentation'
import FileDiffViewer from './FileDiffViewer.vue'
import TurnRewindCard from './TurnRewindCard.vue'

/** Changes 审阅工作区：文件树 + Diff；回退上一轮拆成对话/文件两行，文件仍只允许 latest-turn。 */

const props = withDefaults(
  defineProps<{
    taskId: string
    controller: TaskChangesController
    advertisedCommands?: readonly { name: string }[]
    rewindBusy?: boolean
  }>(),
  {
    advertisedCommands: () => [],
    rewindBusy: false
  }
)

const {
  changeSet,
  loading,
  errorMessage,
  selectedPath,
  selectedDiff,
  selectedDiffLoading,
  selectedDiffError,
  reload,
  selectPath,
  retryFileDiff,
  restorePreview,
  restoreBusy,
  restoreError,
  restoreMessage,
  openRestorePreview,
  cancelRestorePreview,
  confirmRestore
} = props.controller

const fileFilter = ref('')
const collapsedFolderIds = ref(new Set<string>())
const summary = computed(() => (changeSet.value ? presentChangeSetSummary(changeSet.value) : null))
const warnings = computed(() => (changeSet.value ? changeSetWarnings(changeSet.value) : []))
const gitNotice = computed(() =>
  changeSet.value ? gitPresenceNotice(changeSet.value.gitPresence) : null
)
const readiness = computed(() => (changeSet.value ? changeSetReadiness(changeSet.value) : null))
const card = computed(() => presentChangeCard(changeSet.value))
const treeRows = computed(() =>
  flattenChangeTreeRows(
    filterChangeFileTree(
      changeSet.value ? presentChangeFileTree(changeSet.value.paths) : [],
      fileFilter.value
    ),
    0,
    collapsedFolderIds.value
  )
)
const fileRows = computed(() => treeRows.value.filter((row) => row.kind === 'file' && row.path))
const unverifiedPaths = computed(() =>
  changeSet.value ? unverifiedTaskPaths(changeSet.value) : []
)
const incompletePaths = computed(() =>
  changeSet.value ? incompleteReviewPaths(changeSet.value) : []
)
const canRestore = computed(() =>
  changeSet.value ? canRestoreLatestTurn(changeSet.value.revertible) : false
)
/** 对话状态由命令快照 + 空闲/忙碌推导；文件状态沿用 latest-turn 预览，不新开 IPC。 */
const rewindPreview = computed(() =>
  buildTurnRewindPreview({
    advertisedCommands: props.advertisedCommands,
    busy: props.rewindBusy,
    restorePreview: restorePreview.value,
    changeSetRevertible: changeSet.value?.revertible ?? null
  })
)
/** 没有可审阅文件时不展示回退卡，避免空页脚堆内部原因。 */
const showRestoreUnavailable = computed(
  () => !canRestore.value && readiness.value?.kind !== 'empty'
)
const showRestoreSection = computed(
  () =>
    Boolean(restoreMessage.value || restoreError.value) ||
    canRestore.value ||
    showRestoreUnavailable.value
)

watch(
  () => [changeSet.value?.paths, selectedPath.value] as const,
  ([paths, selected]) => {
    if (selected || !paths?.length) return
    const first = flattenChangeTreeRows(presentChangeFileTree(paths)).find(
      (row) => row.kind === 'file' && row.path
    )
    if (first?.path) void selectPath(first.path)
  },
  { immediate: true }
)

watch(fileFilter, () => {
  collapsedFolderIds.value = new Set()
})

function pathButtonId(path: string): string {
  return `changes-path-${encodeURIComponent(path)}`
}

/** 折叠或展开目录，不改变当前选中的文件。 */
function toggleFolder(id: string): void {
  const next = new Set(collapsedFolderIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsedFolderIds.value = next
}

function onPathKeydown(event: KeyboardEvent, path: string): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const index = fileRows.value.findIndex((item) => item.path === path)
  const nextIndex = event.key === 'ArrowDown' ? index + 1 : index - 1
  const nextPath = fileRows.value[nextIndex]?.path
  if (!nextPath) return
  void selectPath(nextPath)
  void nextTick(() => {
    document.getElementById(pathButtonId(nextPath))?.focus()
  })
}

function pathTabIndex(path: string): number {
  if (selectedPath.value === path) return 0
  if (!selectedPath.value && fileRows.value[0]?.path === path) return 0
  return -1
}
</script>

<template>
  <section class="task-changes-panel" :data-task-id="taskId" aria-label="变更审阅">
    <header class="changes-toolbar">
      <div class="changes-toolbar-copy">
        <strong>审查</strong>
        <span v-if="card.visible" class="changes-toolbar-delta">
          {{ formatChangeLineDelta(card.added, card.deleted) }}
        </span>
      </div>
      <button
        class="icon-button"
        type="button"
        title="重新加载变更"
        aria-label="重新加载变更"
        :disabled="loading"
        @click="reload()"
      >
        <ArrowClockwise :size="14" />
      </button>
    </header>

    <p v-if="loading && !changeSet" class="changes-state" role="status">正在加载变更…</p>

    <div v-else-if="errorMessage" class="changes-state" role="alert">
      <p>{{ errorMessage }}</p>
      <button
        class="secondary-button"
        type="button"
        title="重试加载变更"
        aria-label="重试加载变更"
        @click="reload()"
      >
        重试
      </button>
    </div>

    <template v-else-if="changeSet && summary && readiness">
      <ul v-if="warnings.length" class="changes-warnings" role="status">
        <li v-for="warning in warnings" :key="warning">{{ warning }}</li>
      </ul>

      <p v-if="gitNotice" class="changes-muted changes-git-notice">{{ gitNotice }}</p>

      <div v-if="readiness.kind !== 'ready'" class="changes-state" role="status">
        <strong>{{ readiness.heading }}</strong>
        <p>{{ readiness.detail }}</p>
      </div>

      <div v-else class="changes-review-split">
        <div class="changes-tree-pane">
          <label class="changes-filter">
            <span class="visually-hidden">筛选文件</span>
            <input
              v-model="fileFilter"
              type="search"
              placeholder="筛选文件…"
              title="筛选文件"
              aria-label="筛选文件"
            />
          </label>
          <div class="changes-path-groups" role="listbox" aria-label="变更文件">
            <template v-for="row in treeRows" :key="row.id">
              <button
                v-if="row.kind === 'folder'"
                class="changes-tree-row changes-tree-folder"
                type="button"
                :title="row.id"
                :aria-label="`${row.collapsed ? '展开' : '折叠'} ${row.name}`"
                :aria-expanded="row.collapsed ? 'false' : 'true'"
                @click="toggleFolder(row.id)"
              >
                <span class="changes-tree-guides" aria-hidden="true">
                  <span
                    v-for="(guide, guideIndex) in row.guides"
                    :key="`${row.id}:${guideIndex}:${guide}`"
                    class="changes-tree-guide"
                    :data-guide="guide"
                  />
                </span>
                <CaretRight
                  class="changes-tree-caret"
                  :class="{ 'is-open': !row.collapsed }"
                  :size="12"
                />
                <Folder class="changes-tree-icon" :size="14" />
                <span class="changes-path-name">{{ row.name }}</span>
              </button>
              <button
                v-else-if="row.path"
                :id="pathButtonId(row.path)"
                class="changes-tree-row changes-path-button"
                type="button"
                role="option"
                :title="row.path"
                :aria-label="`${attributionLabel(row.attribution ?? 'overlap-unknown')} ${row.path}`"
                :aria-selected="selectedPath === row.path"
                :tabindex="pathTabIndex(row.path)"
                @click="selectPath(row.path)"
                @keydown="onPathKeydown($event, row.path)"
              >
                <span class="changes-tree-guides" aria-hidden="true">
                  <span
                    v-for="(guide, guideIndex) in row.guides"
                    :key="`${row.id}:${guideIndex}:${guide}`"
                    class="changes-tree-guide"
                    :data-guide="guide"
                  />
                </span>
                <span class="changes-tree-caret" aria-hidden="true"></span>
                <File class="changes-tree-icon" :size="14" />
                <span class="changes-path-name">{{ row.name }}</span>
                <span class="changes-path-meta">
                  <span v-if="row.added" class="is-add">+{{ row.added }}</span>
                  <span v-if="row.deleted" class="is-del">−{{ row.deleted }}</span>
                  <template v-if="!row.added && !row.deleted && row.omitted">
                    {{ omittedLabel(row.omitted) }}
                  </template>
                </span>
              </button>
            </template>
          </div>
        </div>

        <FileDiffViewer
          v-if="selectedPath"
          :path="selectedPath"
          :diff="selectedDiff"
          :loading="selectedDiffLoading"
          :error-message="selectedDiffError"
          @retry="retryFileDiff()"
        />
        <p v-else class="changes-muted changes-diff-empty" role="status">选择一个文件查看差异。</p>
      </div>

      <section v-if="unverifiedPaths.length" class="changes-unverified" aria-label="未验证文件">
        <h3>未验证文件</h3>
        <ul>
          <li v-for="path in unverifiedPaths" :key="path">{{ path }}</li>
        </ul>
      </section>
      <p v-else-if="readiness.kind === 'incomplete'" class="changes-muted" role="status">
        变更读取不完整，无法确认哪些文件未经验证。
      </p>

      <section v-if="incompletePaths.length" class="changes-unverified" aria-label="未能完整审阅">
        <h3>未能完整审阅</h3>
        <ul>
          <li v-for="path in incompletePaths" :key="path">{{ path }}</li>
        </ul>
      </section>

      <section v-if="showRestoreSection" class="changes-restore" aria-label="回退上一轮">
        <p v-if="restoreMessage" class="changes-muted" role="status">{{ restoreMessage }}</p>
        <p v-if="restoreError" class="changes-risk" role="alert">{{ restoreError }}</p>
        <TurnRewindCard
          :preview="rewindPreview"
          :restore-busy="restoreBusy"
          @preview-files="openRestorePreview()"
          @confirm-files="confirmRestore()"
          @cancel-files="cancelRestorePreview()"
        />
      </section>
    </template>
  </section>
</template>
