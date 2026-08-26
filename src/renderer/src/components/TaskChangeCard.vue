<script setup lang="ts">
import { PhFiles as Files } from '@phosphor-icons/vue'
import type { ChangeCardView } from '../task-changes-presentation'
import { formatChangeLineDelta } from '../task-changes-presentation'
import TaskChangeMediaThumbnail from './TaskChangeMediaThumbnail.vue'

/** 对话里的变更入口：只负责展示与发出审核/撤销，不自己调 IPC。 */

defineProps<{
  taskId: string
  model: ChangeCardView
  restoreBusy?: boolean
}>()

defineEmits<{
  review: []
  restore: []
  reviewFile: [path: string]
}>()
</script>

<template>
  <section v-if="model.visible" class="task-change-card" aria-label="本轮文件变更">
    <header class="task-change-card-heading">
      <div class="task-change-card-title">
        <span class="task-change-card-icon" aria-hidden="true">
          <Files :size="16" />
        </span>
        <div>
          <strong>{{ model.heading }}</strong>
          <p>{{ formatChangeLineDelta(model.added, model.deleted) }}</p>
        </div>
      </div>
      <div class="task-change-card-actions">
        <button
          class="secondary-button"
          type="button"
          :title="model.canRestore ? '撤销最新一轮' : '当前不能一键撤销'"
          :aria-label="model.canRestore ? '撤销最新一轮' : '当前不能一键撤销'"
          :disabled="!model.canRestore || restoreBusy"
          @click="$emit('restore')"
        >
          撤销
        </button>
        <button
          class="secondary-button"
          type="button"
          title="打开变更审阅"
          aria-label="打开变更审阅"
          @click="$emit('review')"
        >
          审核
        </button>
      </div>
    </header>

    <ul class="task-change-card-files">
      <li v-for="file in model.files" :key="file.path">
        <button
          class="task-change-card-file"
          type="button"
          :title="file.path"
          :aria-label="`审阅 ${file.path}`"
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
  </section>
</template>
