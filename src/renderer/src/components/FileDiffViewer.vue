<script setup lang="ts">
import { computed } from 'vue'
import type { FileDiffResult } from '../../../shared/git-review'
import {
  fileDiffBanner,
  fileDiffFallback,
  parseUnifiedDiff,
  presentFileDiffRows,
  shouldRenderUnifiedDiff,
  type FileDiffLineKind
} from '../task-changes-presentation'

/** 按需展示单文件受限 Diff：截断必须有横幅，二进制/过大不渲染假文本。 */

const props = withDefaults(
  defineProps<{
    path: string
    diff: FileDiffResult | null
    loading?: boolean
    errorMessage?: string
  }>(),
  {
    loading: false,
    errorMessage: ''
  }
)

defineEmits<{
  retry: []
}>()

const banner = computed(() => (props.diff ? fileDiffBanner(props.diff) : null))
const lines = computed(() =>
  props.diff && shouldRenderUnifiedDiff(props.diff) && props.diff.unifiedDiff
    ? parseUnifiedDiff(props.diff.unifiedDiff)
    : []
)
const rows = computed(() => presentFileDiffRows(lines.value))
const showFallback = computed(
  () => Boolean(props.diff) && lines.value.length === 0 && !props.loading && !banner.value
)

function lineMark(kind: FileDiffLineKind): string {
  if (kind === 'add') return '+'
  if (kind === 'del') return '-'
  if (kind === 'hunk') return '@'
  return ''
}

function lineNumber(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}
</script>

<template>
  <section class="file-diff-viewer" aria-label="文件差异">
    <header class="file-diff-header">
      <strong :title="path">{{ path }}</strong>
    </header>

    <p v-if="loading" class="file-diff-state" role="status">正在加载差异…</p>
    <div v-else-if="errorMessage" class="file-diff-state" role="alert">
      <p>{{ errorMessage }}</p>
      <button
        class="secondary-button"
        type="button"
        title="重新加载差异"
        aria-label="重新加载差异"
        @click="$emit('retry')"
      >
        重试
      </button>
    </div>
    <template v-else-if="diff">
      <p v-if="banner" class="file-diff-banner" role="status">{{ banner }}</p>
      <div v-if="rows.length" class="file-diff-scroll" tabindex="0" aria-label="差异内容">
        <!-- 包一层让长短行都铺满滚动宽度，增删背景不会只罩住文字。 -->
        <div class="file-diff-lines">
          <template v-for="(row, index) in rows" :key="`${index}:${row.kind}`">
            <div v-if="row.kind === 'unmodified'" class="file-diff-unmodified" role="note">
              {{ row.count }} 行未修改
            </div>
            <div v-else class="file-diff-line" :data-kind="row.line.kind">
              <span class="file-diff-gutter" aria-hidden="true">{{
                lineNumber(row.line.oldLine)
              }}</span>
              <span class="file-diff-gutter" aria-hidden="true">{{
                lineNumber(row.line.newLine)
              }}</span>
              <span class="file-diff-mark" aria-hidden="true">{{ lineMark(row.line.kind) }}</span>
              <span class="file-diff-text">{{ row.line.text }}</span>
            </div>
          </template>
        </div>
      </div>
      <p v-else-if="showFallback" class="file-diff-state" role="status">
        {{ fileDiffFallback(diff.status) }}
      </p>
    </template>
  </section>
</template>
