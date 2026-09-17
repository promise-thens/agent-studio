<script setup lang="ts">
import { computed } from 'vue'
import type { AgentToolStatus } from '../../../shared/agent'
import type { PublicAgentEditDiff } from '../../../shared/agent-event'
import {
  conversationEditUnavailableLabel,
  presentConversationEditCard
} from '../conversation-edit-diff'
import { resolveToolRowChrome } from '../conversation-tool-presentation'

/** 主对话里的本次编辑卡：只画这一次工具调用的红绿 hunk，不是整文件 Git diff。 */

const props = defineProps<{
  label: string
  status: AgentToolStatus | 'unknown'
  edits: readonly PublicAgentEditDiff[]
  warning?: string
}>()

const view = computed(() =>
  presentConversationEditCard({
    label: props.label,
    status: props.status,
    edits: props.edits,
    warning: props.warning
  })
)
const chrome = computed(() => resolveToolRowChrome({ status: props.status }))
const showStatus = computed(() => props.status !== 'completed' && props.status !== 'unknown')
</script>

<template>
  <section
    class="conversation-edit-diff conversation-process-step"
    data-kind="edit-diff"
    data-process-kind="tool"
    :data-status="status"
    :aria-label="view.header"
  >
    <header class="conversation-edit-diff-header">
      <span v-if="chrome.busy" class="conversation-spinner" aria-hidden="true" />
      <strong class="conversation-edit-diff-title">{{ view.header }}</strong>
      <span v-if="view.warning" class="tool-row-warning">{{ view.warning }}</span>
      <span
        v-if="view.added || view.deleted"
        class="conversation-edit-diff-stat"
        aria-label="增删行数"
      >
        <span v-if="view.added" class="conversation-edit-diff-add">+{{ view.added }}</span>
        <span v-if="view.added && view.deleted">/</span>
        <span v-if="view.deleted" class="conversation-edit-diff-del">-{{ view.deleted }}</span>
      </span>
      <span v-if="showStatus" class="tool-row-status">{{ chrome.statusLabel }}</span>
    </header>

    <div v-for="file in view.files" :key="file.path" class="conversation-edit-diff-file">
      <p v-if="view.files.length > 1" class="conversation-edit-diff-path" :title="file.path">
        {{ file.path }}
      </p>
      <p v-if="file.truncated" class="conversation-edit-diff-banner" role="status">
        差异已截断，当前不是完整 Diff。
      </p>
      <p v-if="file.unavailable" class="conversation-edit-diff-banner" role="status">
        {{ conversationEditUnavailableLabel(file.unavailable) }}
      </p>
      <div
        v-if="file.hunks.length"
        class="conversation-edit-diff-hunks"
        tabindex="0"
        aria-label="本次编辑差异"
      >
        <template v-for="(hunk, hunkIndex) in file.hunks" :key="`${file.path}:${hunkIndex}`">
          <div v-if="hunk.gapBefore" class="conversation-edit-diff-gap" role="note">
            … {{ hunk.gapBefore }} 行未修改
          </div>
          <div
            v-for="(line, lineIndex) in hunk.lines"
            :key="`${hunkIndex}:${lineIndex}:${line.kind}`"
            class="conversation-edit-line"
            :data-kind="line.kind"
          >
            <span class="conversation-edit-gutter" aria-hidden="true">{{
              line.lineNumber ?? ''
            }}</span>
            <span class="conversation-edit-text">{{ line.text }}</span>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>
