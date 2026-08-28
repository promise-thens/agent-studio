<script setup lang="ts">
import AssistantMarkdown from './AssistantMarkdown.vue'

defineProps<{
  title: string
  markdown: string
  truncated?: boolean
}>()
</script>

<template>
  <section class="artifact-markdown-viewer" aria-label="Markdown 产物">
    <header class="artifact-viewer-header">
      <strong :title="title">{{ title }}</strong>
    </header>
    <p v-if="truncated" class="artifact-viewer-banner" role="status">内容过长，已截断显示。</p>
    <div class="artifact-markdown-body">
      <AssistantMarkdown :text="markdown" />
    </div>
  </section>
</template>
