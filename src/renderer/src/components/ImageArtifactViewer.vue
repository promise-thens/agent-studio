<script setup lang="ts">
import { computed } from 'vue'
import { createAttachmentPreviewUrl } from '../attachment-preview-url'

const props = defineProps<{
  title: string
  mimeType: string
  imageBase64: string
}>()

const url = computed(() => createAttachmentPreviewUrl(props.imageBase64, props.mimeType))
</script>

<template>
  <section class="artifact-image-viewer" aria-label="图片产物">
    <header class="artifact-viewer-header">
      <strong :title="title">{{ title }}</strong>
    </header>
    <p v-if="!url" class="artifact-viewer-banner" role="alert">图片无法安全预览。</p>
    <img v-else class="artifact-image" :src="url" :alt="title" />
  </section>
</template>
