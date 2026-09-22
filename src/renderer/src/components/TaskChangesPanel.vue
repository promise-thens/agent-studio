<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  PhArrowClockwise as ArrowClockwise,
  PhCaretRight as CaretRight,
  PhFile as File,
  PhFolder as Folder
} from '@phosphor-icons/vue'
import {
  buildTurnRewindPreview,
  type TurnRewindSelection
} from '../../../shared/turn-rewind-preview'
import type { TaskChangesController } from '../composables/useTaskChanges'
import type { InspectorConversationTarget } from '../task-inspector'
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

const emit = defineEmits<{
  focusTarget: [target: InspectorConversationTarget]
}>()

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
  confirmTurnRewind
} = props.controller

/** 回退抽屉展开状态，默认收起，有预览或错误时自动展开。 */
const restoreDrawerOpen = ref(false)

watch(
  () => Boolean(restorePreview.value || restoreError.value),
  (shouldOpen) => {
    if (shouldOpen) restoreDrawerOpen.value = true
  }
)

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
/** 只有主进程明确证明为 latest-turn 的变更，才允许返回所属对话轮次。 */
const latestTurnId = computed(() => {
  const revertible = changeSet.value?.revertible
  return revertible && revertible.kind === 'latest-turn' ? revertible.turnId : null
})
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

/** 卡确认带上勾选；本面板不 startTurn，对话发送由注入的执行函数负责。 */
function onConfirmRewind(selection: TurnRewindSelection): void {
  void confirmTurnRewind(rewindPreview.value, selection)
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
      <div class="changes-toolbar-actions">
        <button
          v-if="latestTurnId"
          class="secondary-button"
          type="button"
          :title="`回到最新可恢复变更所属轮次：${latestTurnId}`"
          @click="emit('focusTarget', { turnId: latestTurnId })"
        >
          回到该轮
        </button>
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
      </div>
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

      <!-- 未验证文件：收纳为紧凑胶囊，默认折叠，避免大块空白 -->
      <section
        v-if="unverifiedPaths.length"
        class="changes-unverified changes-unverified-compact"
        aria-label="未验证文件"
      >
        <details class="changes-unverified-details">
          <summary class="changes-unverified-summary">
            <span class="changes-unverified-pill">
              <span class="changes-unverified-badge">ℹ️ {{ unverifiedPaths.length }}</span>
              <strong>未验证文件</strong>
            </span>
            <span class="changes-unverified-hint">点击展开清单</span>
          </summary>
          <ul class="changes-unverified-list">
            <li v-for="path in unverifiedPaths" :key="path">{{ path }}</li>
          </ul>
        </details>
      </section>
      <p v-else-if="readiness.kind === 'incomplete'" class="changes-muted" role="status">
        变更读取不完整，无法确认哪些文件未经验证。
      </p>

      <!-- 未能完整审阅：收纳为紧凑胶囊，默认折叠，保留原有无障碍与测试标签 -->
      <section
        v-if="incompletePaths.length"
        class="changes-unverified changes-unverified-compact"
        aria-label="未能完整审阅"
      >
        <details class="changes-unverified-details">
          <summary class="changes-unverified-summary">
            <span class="changes-unverified-pill">
              <span class="changes-unverified-badge">⚠️ {{ incompletePaths.length }}</span>
              <strong>未能完整审阅</strong>
            </span>
            <span class="changes-unverified-hint">点击展开清单</span>
          </summary>
          <ul class="changes-unverified-list">
            <li v-for="path in incompletePaths" :key="path">{{ path }}</li>
          </ul>
        </details>
      </section>

      <!-- 回退上一轮：收纳为底部精致抽屉折叠栏，默认收起，保留 aria-label="回退上一轮" -->
      <section
        v-if="showRestoreSection"
        class="changes-restore changes-restore-drawer"
        aria-label="回退上一轮"
      >
        <details
          :open="restoreDrawerOpen"
          class="changes-restore-details"
          @toggle="restoreDrawerOpen = ($event.target as HTMLDetailsElement).open"
        >
          <summary class="changes-restore-summary">
            <div class="changes-restore-summary-title">
              <span class="changes-restore-icon">↩</span>
              <strong>回退上一轮</strong>
              <span v-if="restoreMessage" class="changes-muted" role="status">{{
                restoreMessage
              }}</span>
              <span v-if="restoreError" class="changes-risk" role="alert">{{ restoreError }}</span>
            </div>
            <span class="changes-restore-toggle-hint">{{
              restoreDrawerOpen ? '收起' : canRestore ? '展开回退选项' : '查看状态'
            }}</span>
          </summary>
          <div class="changes-restore-body">
            <p v-if="restoreMessage" class="changes-muted" role="status">{{ restoreMessage }}</p>
            <p v-if="restoreError" class="changes-risk" role="alert">{{ restoreError }}</p>
            <TurnRewindCard
              :preview="rewindPreview"
              :restore-busy="restoreBusy"
              @preview-files="openRestorePreview()"
              @confirm="onConfirmRewind"
              @cancel-files="cancelRestorePreview()"
            />
          </div>
        </details>
      </section>
    </template>
  </section>
</template>
