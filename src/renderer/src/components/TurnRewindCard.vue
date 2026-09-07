<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TurnRewindPreview, TurnRewindSelection } from '../../../shared/turn-rewind-preview'
import {
  clampTurnRewindSelection,
  defaultTurnRewindSelection,
  presentTurnRewindCard
} from '../../../shared/turn-rewind-preview'
import { restoreActionLabel, restorePreviewSummary } from '../task-changes-presentation'

/**
 * 回退上一轮两行卡：对话回退与文件恢复分开展示。
 * 本组件不 startTurn；文件确认仍走已有 restore IPC。
 */

const props = withDefaults(
  defineProps<{
    preview: TurnRewindPreview
    restoreBusy?: boolean
  }>(),
  {
    restoreBusy: false
  }
)

const emit = defineEmits<{
  previewFiles: []
  confirmFiles: []
  cancelFiles: []
}>()

const selection = ref<TurnRewindSelection>(defaultTurnRewindSelection(props.preview))

watch(
  () => [props.preview.conversation, props.preview.files.blocked] as const,
  () => {
    selection.value = defaultTurnRewindSelection(props.preview)
  }
)

const view = computed(() => presentTurnRewindCard(props.preview, selection.value))
const filePreview = computed(() =>
  props.preview.files.preview?.revertible.kind === 'latest-turn'
    ? props.preview.files.preview
    : null
)
const restorePlan = computed(() =>
  filePreview.value?.revertible.kind === 'latest-turn'
    ? filePreview.value.revertible.restorePlan
    : []
)
const filesButtonDisabled = computed(() => view.value.filesButtonDisabled || props.restoreBusy)

function onConversationChange(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  selection.value = clampTurnRewindSelection(props.preview, {
    conversation: target.checked,
    files: selection.value.files
  })
}

function onFilesChange(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  selection.value = clampTurnRewindSelection(props.preview, {
    conversation: selection.value.conversation,
    files: target.checked
  })
}

function onFilesAction(): void {
  if (filesButtonDisabled.value) return
  if (filePreview.value) emit('confirmFiles')
  else emit('previewFiles')
}
</script>

<template>
  <section class="turn-rewind-card" aria-label="回退上一轮">
    <h3 class="turn-rewind-card-title">回退上一轮</h3>

    <label
      class="turn-rewind-row"
      :data-disabled="view.conversationCheckboxDisabled ? 'true' : undefined"
    >
      <input
        type="checkbox"
        :checked="view.conversationChecked"
        :disabled="view.conversationCheckboxDisabled"
        :title="
          view.conversationCheckboxDisabled
            ? (view.conversationStatusCopy ?? '对话回退')
            : '对话回退'
        "
        aria-label="对话回退"
        @change="onConversationChange"
      />
      <span class="turn-rewind-row-copy">
        <strong>对话回退</strong>
        <p>只影响 Grok 上下文，不改磁盘</p>
        <p v-if="preview.conversation === 'command-missing'" class="turn-rewind-status">
          当前会话未提供 rewind
        </p>
        <p v-else-if="preview.conversation === 'busy'" class="turn-rewind-status">
          {{ view.conversationStatusCopy }}
        </p>
      </span>
    </label>

    <label class="turn-rewind-row" :data-disabled="view.filesCheckboxDisabled ? 'true' : undefined">
      <input
        type="checkbox"
        :checked="view.filesChecked"
        :disabled="view.filesCheckboxDisabled"
        :title="view.filesCheckboxDisabled ? (view.filesReason ?? '文件恢复') : '文件恢复'"
        aria-label="文件恢复"
        @change="onFilesChange"
      />
      <span class="turn-rewind-row-copy">
        <strong>文件恢复</strong>
        <p v-if="view.filesReason" class="turn-rewind-status" role="status">
          {{ view.filesReason }}
        </p>
      </span>
    </label>

    <div v-if="filePreview" class="turn-rewind-files-preview">
      <p>{{ restorePreviewSummary(filePreview) }}</p>
      <ul>
        <li v-for="item in restorePlan" :key="item.path">
          {{ item.path }} · {{ restoreActionLabel(item) }}
        </li>
      </ul>
      <div class="changes-restore-actions">
        <button
          class="secondary-button"
          type="button"
          title="确认恢复上一轮文件"
          aria-label="确认恢复上一轮文件"
          :disabled="filesButtonDisabled"
          @click="onFilesAction"
        >
          确认恢复上一轮文件
        </button>
        <button
          class="secondary-button"
          type="button"
          title="取消恢复"
          aria-label="取消恢复"
          :disabled="restoreBusy"
          @click="emit('cancelFiles')"
        >
          取消
        </button>
      </div>
    </div>
    <button
      v-else
      class="secondary-button"
      type="button"
      :title="
        filesButtonDisabled ? (view.filesReason ?? '当前不能一键恢复上一轮文件') : '恢复上一轮文件'
      "
      :aria-label="
        filesButtonDisabled ? (view.filesReason ?? '当前不能一键恢复上一轮文件') : '恢复上一轮文件'
      "
      :disabled="filesButtonDisabled"
      @click="onFilesAction"
    >
      恢复上一轮文件
    </button>
  </section>
</template>
