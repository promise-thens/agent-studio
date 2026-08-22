<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount } from 'vue'
import { PhArrowClockwise as ArrowClockwise } from '@phosphor-icons/vue'
import {
  commandSourceLabel,
  commandTrustLabel,
  formatCommandDuration,
  toCommandEvidenceView
} from '../command-evidence-presentation'
import { useTaskChanges } from '../composables/useTaskChanges'
import {
  attributionLabel,
  changeSetReadiness,
  changeSetWarnings,
  gitPresenceNotice,
  groupChangePaths,
  incompleteReviewPaths,
  omittedLabel,
  presentChangeSetSummary,
  revertibleNotice,
  unverifiedTaskPaths,
  validationOutcomeLabel,
  validationReasonLabel
} from '../task-changes-presentation'
import FileDiffViewer from './FileDiffViewer.vue'

/** 只读 Changes 审阅：不预取 Diff，也不提供一键撤销。 */

const props = defineProps<{
  taskId: string
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
  dispose
} = useTaskChanges(() => props.taskId)
onBeforeUnmount(() => dispose())

const summary = computed(() => (changeSet.value ? presentChangeSetSummary(changeSet.value) : null))
const warnings = computed(() => (changeSet.value ? changeSetWarnings(changeSet.value) : []))
const gitNotice = computed(() =>
  changeSet.value ? gitPresenceNotice(changeSet.value.gitPresence) : null
)
const readiness = computed(() => (changeSet.value ? changeSetReadiness(changeSet.value) : null))
const pathGroups = computed(() => (changeSet.value ? groupChangePaths(changeSet.value.paths) : []))
const flatPaths = computed(() => pathGroups.value.flatMap((group) => group.paths))
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
const validations = computed(() => changeSet.value?.validations ?? [])

function pathButtonId(path: string): string {
  return `changes-path-${encodeURIComponent(path)}`
}

function onPathKeydown(event: KeyboardEvent, path: string): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const index = flatPaths.value.findIndex((item) => item.path === path)
  const nextIndex = event.key === 'ArrowDown' ? index + 1 : index - 1
  const next = flatPaths.value[nextIndex]
  if (!next) return
  void selectPath(next.path)
  void nextTick(() => {
    document.getElementById(pathButtonId(next.path))?.focus()
  })
}

function pathTabIndex(path: string): number {
  if (selectedPath.value === path) return 0
  if (!selectedPath.value && flatPaths.value[0]?.path === path) return 0
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
  <section class="task-changes-panel" aria-label="变更审阅">
    <header class="changes-toolbar">
      <strong>变更审阅</strong>
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

      <div class="changes-summary" role="status">
        <p>{{ summary.gitLine }}</p>
        <p>{{ summary.countLine }}</p>
        <p v-if="gitNotice" class="changes-muted">{{ gitNotice }}</p>
      </div>

      <div v-if="readiness.kind !== 'ready'" class="changes-state" role="status">
        <strong>{{ readiness.heading }}</strong>
        <p>{{ readiness.detail }}</p>
      </div>

      <div
        v-if="pathGroups.length"
        class="changes-path-groups"
        role="listbox"
        aria-label="变更文件"
      >
        <section v-for="group in pathGroups" :key="group.id" class="changes-path-group">
          <h3>{{ group.title }} · {{ group.paths.length }}</h3>
          <button
            v-for="item in group.paths"
            :id="pathButtonId(item.path)"
            :key="item.path"
            class="changes-path-button"
            type="button"
            role="option"
            :title="item.path"
            :aria-label="`${attributionLabel(item.attribution)} ${item.path}`"
            :aria-selected="selectedPath === item.path"
            :tabindex="pathTabIndex(item.path)"
            @click="selectPath(item.path)"
            @keydown="onPathKeydown($event, item.path)"
          >
            <span class="changes-path-name">{{ item.path }}</span>
            <span class="changes-path-meta">
              {{ attributionLabel(item.attribution) }}
              <template v-if="item.omitted"> · {{ omittedLabel(item.omitted) }}</template>
            </span>
          </button>
        </section>
      </div>

      <FileDiffViewer
        v-if="selectedPath"
        :path="selectedPath"
        :diff="selectedDiff"
        :loading="selectedDiffLoading"
        :error-message="selectedDiffError"
        @retry="retryFileDiff()"
      />

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

      <p class="changes-risk" role="status" aria-label="不可一键撤销">{{ revertibleText }}</p>
    </template>
  </section>
</template>
