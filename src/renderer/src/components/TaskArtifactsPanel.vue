<script setup lang="ts">
import { computed } from 'vue'
import { PhArrowClockwise as ArrowClockwise } from '@phosphor-icons/vue'
import type { TaskArtifactsController } from '../composables/useTaskArtifacts'
import {
  artifactAvailabilityLabel,
  artifactKindLabel,
  artifactNeedsAttention,
  artifactSourceLabel,
  artifactTrustLabel,
  formatArtifactSize,
  groupArtifactsByTurn
} from '../task-artifacts-presentation'
import ArtifactViewer from './ArtifactViewer.vue'

const props = defineProps<{
  taskId: string
  controller: TaskArtifactsController
}>()

const {
  items,
  loading,
  errorMessage,
  selectedId,
  selectedContent,
  contentLoading,
  contentError,
  reload,
  select,
  retryContent
} = props.controller

const groups = computed(() => groupArtifactsByTurn(items.value))
const selected = computed(
  () => items.value.find((item) => item.artifactId === selectedId.value) ?? null
)
</script>

<template>
  <section class="task-artifacts-panel" aria-label="任务产物">
    <header class="task-artifacts-toolbar">
      <div>
        <strong>产物</strong>
        <span>{{ items.length }}</span>
      </div>
      <button
        class="icon-button"
        type="button"
        title="刷新产物"
        aria-label="刷新产物"
        :disabled="loading"
        @click="reload()"
      >
        <ArrowClockwise :size="16" />
      </button>
    </header>

    <p v-if="loading" class="artifact-viewer-state" role="status">正在加载产物…</p>
    <div v-else-if="errorMessage" class="artifact-viewer-state" role="alert">
      <p>{{ errorMessage }}</p>
      <button class="secondary-button" type="button" title="重新加载产物" @click="reload()">
        重试
      </button>
    </div>
    <p v-else-if="items.length === 0" class="artifact-viewer-state" role="status">
      当前 Task 还没有可审阅的文本、Markdown、图片或 Diff 产物。
    </p>

    <div v-else class="task-artifacts-layout">
      <nav class="task-artifacts-list" aria-label="产物列表">
        <section v-for="group in groups" :key="group.turnId" class="task-artifacts-group">
          <h3>Turn {{ group.turnId }}</h3>
          <button
            v-for="item in group.items"
            :key="item.artifactId"
            class="task-artifact-item"
            type="button"
            :aria-pressed="selectedId === item.artifactId"
            :title="item.title"
            @click="select(item.artifactId)"
          >
            <strong>{{ item.title }}</strong>
            <span>
              {{ artifactKindLabel(item.kind) }} · {{ formatArtifactSize(item.size) }} ·
              {{ artifactSourceLabel(item.source) }}
            </span>
            <span>
              {{ artifactTrustLabel(item.trustLevel) }}
              <template v-if="artifactNeedsAttention(item)">
                · {{ artifactAvailabilityLabel(item.availability) }}
              </template>
              · r{{ item.revision }}
            </span>
          </button>
        </section>
      </nav>
      <ArtifactViewer
        :descriptor="selected"
        :content="selectedContent"
        :loading="contentLoading"
        :error-message="contentError"
        @retry="retryContent()"
      />
    </div>
  </section>
</template>
