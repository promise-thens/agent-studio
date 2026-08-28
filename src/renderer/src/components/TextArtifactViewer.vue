<script setup lang="ts">
defineProps<{
  title: string
  text: string
  truncated?: boolean
}>()
</script>

<template>
  <section class="artifact-text-viewer" aria-label="文本产物">
    <header class="artifact-viewer-header">
      <strong :title="title">{{ title }}</strong>
    </header>
    <p v-if="truncated" class="artifact-viewer-banner" role="status">内容过长，已截断显示。</p>
    <pre class="artifact-text-body" tabindex="0">{{ text }}</pre>
  </section>
</template>
