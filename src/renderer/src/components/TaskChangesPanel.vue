<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { PhArrowClockwise as ArrowClockwise } from '@phosphor-icons/vue'
import {
  commandSourceLabel,
  commandTrustLabel,
  formatCommandDuration,
  toCommandEvidenceView
} from '../command-evidence-presentation'
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
  restoreActionLabel,
  restorePreviewSummary,
  revertibleNotice,
  unverifiedTaskPaths,
  validationOutcomeLabel,
  validationReasonLabel
} from '../task-changes-presentation'
import FileDiffViewer from './FileDiffViewer.vue'

/** Changes 审阅工作区：文件树 + Diff；撤销仍只允许 latest-turn。 */

const props = defineProps<{
  taskId: string
  controller: TaskChangesController
}>()

const {
  changeSet,
  loading,
  errorMessage,
  selectedPath,
  selectedDiff,
  selectedDiffLoading,
  selectedDiffError,
  selectedCommandId,
  selectedCommandEvidence,
  selectedCommandLoading,
  selectedCommandError,
  reload,
  selectPath,
  retryFileDiff,
  selectCommand,
  retryCommandEvidence,
  restorePreview,
  restoreBusy,
  restoreError,
  restoreMessage,
  openRestorePreview,
  cancelRestorePreview,
  confirmRestore
} = props.controller

const fileFilter = ref('')
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
    )
  )
)
const fileRows = computed(() => treeRows.value.filter((row) => row.kind === 'file' && row.path))
const commandView = computed(() =>
  selectedCommandEvidence.value ? toCommandEvidenceView(selectedCommandEvidence.value) : null
)
const unverifiedPaths = computed(() =>
  changeSet.value ? unverifiedTaskPaths(changeSet.value) : []
)
const incompletePaths = computed(() =>
  changeSet.value ? incompleteReviewPaths(changeSet.value) : []
)
const revertibleText = computed(() =>
  changeSet.value ? revertibleNotice(changeSet.value.revertible) : ''
)
const canRestore = computed(() =>
  changeSet.value ? canRestoreLatestTurn(changeSet.value.revertible) : false
)
const restorePlan = computed(() =>
  restorePreview.value?.revertible.kind === 'latest-turn'
    ? restorePreview.value.revertible.restorePlan
    : []
)
const validations = computed(() => changeSet.value?.validations ?? [])

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

function pathButtonId(path: string): string {
  return `changes-path-${encodeURIComponent(path)}`
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

function exitCodeLabel(exitCode: number | undefined): string {
  return exitCode === undefined ? '未上报' : String(exitCode)
}

function durationLabel(durationMs: number | undefined): string {
  return durationMs === undefined ? '未记录' : formatCommandDuration(durationMs)
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
              <div
                v-if="row.kind === 'folder'"
                class="changes-tree-folder"
                :style="{ paddingLeft: `${10 + row.depth * 12}px` }"
              >
                {{ row.name }}
              </div>
              <button
                v-else-if="row.path"
                :id="pathButtonId(row.path)"
                class="changes-path-button"
                type="button"
                role="option"
                :title="row.path"
                :aria-label="`${attributionLabel(row.attribution ?? 'overlap-unknown')} ${row.path}`"
                :aria-selected="selectedPath === row.path"
                :tabindex="pathTabIndex(row.path)"
                :style="{ paddingLeft: `${10 + row.depth * 12}px` }"
                @click="selectPath(row.path)"
                @keydown="onPathKeydown($event, row.path)"
              >
                <span class="changes-path-name">{{ row.name }}</span>
                <span class="changes-path-meta">
                  <template v-if="row.added !== undefined || row.deleted !== undefined">
                    <span class="is-add">+{{ row.added ?? 0 }}</span>
                    <span class="is-del">−{{ row.deleted ?? 0 }}</span>
                  </template>
                  <template v-else-if="row.omitted">{{ omittedLabel(row.omitted) }}</template>
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

      <section class="changes-validations" aria-label="验证摘要">
        <h3>验证</h3>
        <p v-if="!validations.length" class="changes-muted">尚未记录验证命令。</p>
        <article
          v-for="validation in validations"
          :key="validation.validationId"
          class="changes-validation"
          :data-outcome="validation.outcome"
        >
          <p>
            {{ validationOutcomeLabel(validation.outcome) }}
            <template v-if="validation.reason">
              · {{ validationReasonLabel(validation.reason) }}
            </template>
          </p>
          <div class="changes-command-ids">
            <button
              v-for="commandId in validation.commandIds"
              :key="commandId"
              class="changes-command-button"
              type="button"
              :title="`查看命令证据 ${commandId}`"
              :aria-label="`查看命令证据 ${commandId}`"
              :aria-pressed="selectedCommandId === commandId"
              @click="selectCommand(commandId)"
            >
              {{ commandId }}
            </button>
          </div>
        </article>

        <p v-if="selectedCommandLoading" class="changes-muted" role="status">正在加载命令证据…</p>
        <div v-else-if="selectedCommandError" class="changes-state" role="alert">
          <p>{{ selectedCommandError }}</p>
          <button
            class="secondary-button"
            type="button"
            title="重试加载命令证据"
            aria-label="重试加载命令证据"
            @click="retryCommandEvidence()"
          >
            重试
          </button>
        </div>
        <dl v-else-if="commandView" class="command-evidence-facts" aria-label="命令证据">
          <div>
            <dt>命令</dt>
            <dd>{{ commandView.displayCommand }}</dd>
          </div>
          <div>
            <dt>来源</dt>
            <dd>{{ commandSourceLabel(commandView.source) }}</dd>
          </div>
          <div>
            <dt>可信度</dt>
            <dd>{{ commandTrustLabel(commandView.trustLevel) }}</dd>
          </div>
          <div>
            <dt>退出码</dt>
            <dd>{{ exitCodeLabel(commandView.exitCode) }}</dd>
          </div>
          <div>
            <dt>耗时</dt>
            <dd>{{ durationLabel(commandView.durationMs) }}</dd>
          </div>
          <div>
            <dt>超时</dt>
            <dd>{{ commandView.timedOut ? '已超时' : '否' }}</dd>
          </div>
          <div>
            <dt>截断</dt>
            <dd>{{ commandView.truncated ? '输出已截断' : '未截断' }}</dd>
          </div>
        </dl>
        <p
          v-if="commandView?.logIncompleteReason"
          class="command-evidence-incomplete"
          role="status"
        >
          {{ commandView.logIncompleteReason }}
        </p>
      </section>

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

      <section class="changes-restore" aria-label="撤销边界">
        <p v-if="restoreMessage" class="changes-muted" role="status">{{ restoreMessage }}</p>
        <p v-if="restoreError" class="changes-risk" role="alert">{{ restoreError }}</p>
        <p v-if="!canRestore" class="changes-risk" role="status" aria-label="不可一键撤销">
          {{ revertibleText }}
        </p>
        <template v-else>
          <p class="changes-muted" role="status">{{ revertibleText }}</p>
          <div v-if="restorePreview" class="changes-restore-preview">
            <p>{{ restorePreviewSummary(restorePreview) }}</p>
            <ul>
              <li v-for="item in restorePlan" :key="item.path">
                {{ item.path }} · {{ restoreActionLabel(item) }}
              </li>
            </ul>
            <div class="changes-restore-actions">
              <button
                class="secondary-button"
                type="button"
                title="确认撤销最新一轮"
                aria-label="确认撤销最新一轮"
                :disabled="restoreBusy"
                @click="confirmRestore()"
              >
                确认撤销
              </button>
              <button
                class="secondary-button"
                type="button"
                title="取消撤销"
                aria-label="取消撤销"
                :disabled="restoreBusy"
                @click="cancelRestorePreview()"
              >
                取消
              </button>
            </div>
          </div>
          <button
            v-else
            class="secondary-button"
            type="button"
            title="撤销最新一轮"
            aria-label="撤销最新一轮"
            :disabled="restoreBusy"
            @click="openRestorePreview()"
          >
            撤销最新一轮
          </button>
        </template>
      </section>
    </template>
  </section>
</template>
