<script setup lang="ts">
import { ref, watch } from 'vue'
import { createAttachmentPreviewUrl } from '../attachment-preview-url'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'

const props = withDefaults(
  defineProps<{
    taskId: string
    attachmentIds: string[]
    variant?: 'user' | 'assistant'
  }>(),
  { variant: 'user' }
)

const items = ref<Array<{ id: string; name: string; kind: string; url?: string }>>([])

async function load(): Promise<void> {
  const next: Array<{ id: string; name: string; kind: string; url?: string }> = []
  for (const attachmentId of props.attachmentIds) {
    try {
      const preview = unwrapDesktopIpcResult(
        await window.task.getAttachmentPreview(props.taskId, attachmentId)
      )
      let url: string | undefined
      if (preview.thumbnailBase64 && preview.thumbnailMime) {
        url =
          createAttachmentPreviewUrl(preview.thumbnailBase64, preview.thumbnailMime) ?? undefined
      }
      next.push({
        id: attachmentId,
        name: preview.descriptor.originalName,
        kind: preview.descriptor.kind,
        url
      })
    } catch {
      next.push({ id: attachmentId, name: attachmentId, kind: 'file' })
    }
  }
  items.value = next
}

watch(
  () => `${props.taskId}:${props.attachmentIds.join(',')}`,
  () => {
    void load()
  },
  { immediate: true }
)
</script>

<template>
  <div v-if="items.length" class="conversation-media" :data-variant="variant">
    <template v-for="item in items" :key="item.id">
      <img v-if="item.url" :src="item.url" :alt="item.name" />
      <span v-else class="conversation-file-chip">{{ item.name }}</span>
    </template>
  </div>
</template>
