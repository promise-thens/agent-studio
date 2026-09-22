<script setup lang="ts">
import { PhFiles as Files } from '@phosphor-icons/vue'
import { computed } from 'vue'
import type { ChangeCardView, TurnChangeCardView } from '../task-changes-presentation'
import { formatChangeLineDelta } from '../task-changes-presentation'
import TaskChangeMediaThumbnail from './TaskChangeMediaThumbnail.vue'

/** 对话里的变更入口：审核打开 Changes；回退上一轮打开同一张两行卡，不自己调 IPC。 */

const props = defineProps<{
  taskId: string
  model: ChangeCardView | TurnChangeCardView
  restoreBusy?: boolean
}>()

defineEmits<{
  review: []
  restore: []
  reviewFile: [path: string]
}>()

/** 对话中只保留少量文件预览，完整列表统一交给 Changes 审阅工作区。 */
const CHANGE_CARD_PREVIEW_LIMIT = 6
const previewFiles = computed(() => props.model.files.slice(0, CHANGE_CARD_PREVIEW_LIMIT))
const hiddenFileCount = computed(() =>
  Math.max(0, props.model.files.length - previewFiles.value.length)
)
</script>

<template>
  <details v-if="model.visible" class="task-change-card" :aria-label="model.scope === 'turn' ? '本轮文件记录' : '当前工作区变更'">
    <summary class="task-change-card-heading">
      <div class="task-change-card-title">
        <span class="task-change-card-icon" aria-hidden="true">
          <Files :size="16" />
        </span>
        <div>
          <strong>{{ model.scope === 'turn' ? model.heading : '当前工作区变更' }}</strong>
          <p v-if="model.scope !== 'turn'">相对 HEAD {{ formatChangeLineDelta(model.added, model.deleted) }}</p>
        </div>
      </div>
      <span class="task-change-card-expand">文件记录</span>
    </summary>
    <p class="task-change-card-notice">
      {{ model.scope === 'turn' ? model.detail : '当前 Task 的工作区快照，不代表某一历史轮的增量。' }}
    </p>
      <div class="task-change-card-actions">
        <button
          v-if="model.canRestore"
          class="secondary-button"
          type="button"
          title="回退上一轮"
          aria-label="回退上一轮"
          :disabled="restoreBusy"
          @click="$emit('restore')"
        >
          回退上一轮
        </button>
        <button
          class="secondary-button"
          type="button"
          title="打开当前工作区变更审阅，不是历史 Diff"
          aria-label="查看当前变更"
          @click="$emit('review')"
        >
          查看当前变更
        </button>
      </div>

    <ul class="task-change-card-files">
      <li v-for="file in previewFiles" :key="file.path">
        <button
          class="task-change-card-file"
          type="button"
          :title="file.path"
          :aria-label="`查看当前变更 ${file.path}`"
          @click="$emit('reviewFile', file.path)"
        >
          <span class="task-change-card-file-main">
            <TaskChangeMediaThumbnail
              v-if="file.mediaKind"
              :task-id="taskId"
              :path="file.path"
              :kind="file.mediaKind"
            />
            <span class="task-change-card-path">{{ file.path }}</span>
          </span>
          <span
            v-if="file.added !== undefined || file.deleted !== undefined"
            class="task-change-card-delta"
          >
            <span class="is-add">+{{ file.added ?? 0 }}</span>
            <span class="is-del">−{{ file.deleted ?? 0 }}</span>
          </span>
        </button>
      </li>
    </ul>

    <button
      v-if="hiddenFileCount > 0"
      class="task-change-card-more"
      type="button"
      :title="`打开变更审阅，查看其余 ${hiddenFileCount} 个文件`"
      :aria-label="`打开变更审阅，查看其余 ${hiddenFileCount} 个文件`"
      @click="$emit('review')"
    >
      <span>查看其余 {{ hiddenFileCount }} 个文件</span>
      <span aria-hidden="true">→</span>
    </button>
  </details>
</template>

<style scoped>
/* 历史记录降为随正文滚动的折叠脚注，审阅和恢复仍是显式动作。 */
.task-change-card {
  padding: 0;
  border: 0;
  border-top: 1px solid var(--border);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  color: var(--text-3);
}
.task-change-card-heading {
  padding: 10px 0;
  cursor: pointer;
  list-style: none;
}
.task-change-card-heading::-webkit-details-marker { display: none; }
.task-change-card-title strong { color: var(--text-2); font-size: var(--text-xs); }
.task-change-card-icon { background: transparent; color: var(--text-3); }
.task-change-card-expand { font-size: var(--text-xs); }
.task-change-card-notice {
  margin: 0 0 8px;
  font-size: var(--text-xs);
  line-height: 1.6;
}
.task-change-card-actions { justify-content: flex-end; flex-wrap: wrap; margin-bottom: 8px; }
.task-change-card-actions .secondary-button { background: transparent; color: var(--text-2); }
.task-change-card-heading:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
