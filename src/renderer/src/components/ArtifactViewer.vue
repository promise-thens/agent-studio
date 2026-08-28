<script setup lang="ts">
import type { ArtifactContent, ArtifactDescriptor } from '../../../shared/artifact'
import { artifactAvailabilityLabel } from '../task-artifacts-presentation'
import DiffArtifactViewer from './DiffArtifactViewer.vue'
import ImageArtifactViewer from './ImageArtifactViewer.vue'
import MarkdownArtifactViewer from './MarkdownArtifactViewer.vue'
import TextArtifactViewer from './TextArtifactViewer.vue'

defineProps<{
  descriptor: ArtifactDescriptor | null
  content: ArtifactContent | null
  loading?: boolean
  errorMessage?: string
}>()

defineEmits<{
  retry: []
}>()
</script>

<template>
  <section class="artifact-viewer" aria-label="产物预览">
    <p v-if="!descriptor" class="artifact-viewer-state" role="status">选择一个产物查看内容。</p>
    <template v-else>
      <p v-if="descriptor.availability !== 'ready'" class="artifact-viewer-banner" role="status">
        {{ artifactAvailabilityLabel(descriptor.availability) }}
        <template v-if="descriptor.revision > 1"> · revision {{ descriptor.revision }}</template>
      </p>
      <p v-if="loading" class="artifact-viewer-state" role="status">正在加载产物…</p>
      <div v-else-if="errorMessage" class="artifact-viewer-state" role="alert">
        <p>{{ errorMessage }}</p>
        <button
          class="secondary-button"
          type="button"
          title="重新加载产物"
          aria-label="重新加载产物"
          @click="$emit('retry')"
        >
          重试
        </button>
      </div>
      <TextArtifactViewer
        v-else-if="content?.kind === 'text'"
        :title="descriptor.title"
        :text="content.text"
        :truncated="content.truncated"
      />
      <MarkdownArtifactViewer
        v-else-if="content?.kind === 'markdown'"
        :title="descriptor.title"
        :markdown="content.markdown"
        :truncated="content.truncated"
      />
      <ImageArtifactViewer
        v-else-if="content?.kind === 'image'"
        :title="descriptor.title"
        :mime-type="content.mimeType"
        :image-base64="content.imageBase64"
      />
      <DiffArtifactViewer
        v-else-if="content?.kind === 'diff'"
        :path="content.diff.path"
        :diff="content.diff"
        @retry="$emit('retry')"
      />
      <p v-else class="artifact-viewer-state" role="status">
        未知类型只显示元数据，不提供任意路径读取。
      </p>
    </template>
  </section>
</template>
