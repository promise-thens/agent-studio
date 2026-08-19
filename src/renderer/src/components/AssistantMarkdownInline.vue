<script setup lang="ts">
import type { MarkdownInline } from '../assistant-markdown'

defineOptions({ name: 'AssistantMarkdownInline' })

defineProps<{
  nodes: MarkdownInline[]
}>()
</script>

<template>
  <template v-for="(node, index) in nodes" :key="index">
    <strong v-if="node.type === 'strong'">
      <AssistantMarkdownInline :nodes="node.children" />
    </strong>
    <code v-else-if="node.type === 'code'" class="assistant-md-code">{{ node.value }}</code>
    <a
      v-else-if="node.type === 'link'"
      class="assistant-md-link"
      :href="node.href"
      target="_blank"
      rel="noopener noreferrer"
    >
      <AssistantMarkdownInline :nodes="node.children" />
    </a>
    <template v-else>{{ node.value }}</template>
  </template>
</template>
