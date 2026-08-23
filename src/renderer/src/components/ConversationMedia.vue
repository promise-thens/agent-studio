<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'

const props = defineProps<{
  taskId: string
  attachmentIds: string[]
}>()

const items = ref<Array<{ id: string; name: string; kind: string; url?: string }>>([])
const urls: string[] = []

async function load(): Promise<void> {
  const next: Array<{ id: string; name: string; kind: string; url?: string }> = []
  for (const attachmentId of props.attachmentIds) {
    try {
      const preview = unwrapDesktopIpcResult(
        await window.task.getAttachmentPreview(props.taskId, attachmentId)
      )
      let url: string | undefined
      if (preview.thumbnailBase64 && preview.thumbnailMime) {
        const binary = atob(preview.thumbnailBase64)
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1)
          bytes[index] = binary.charCodeAt(index)
        url = URL.createObjectURL(new Blob([bytes], { type: preview.thumbnailMime }))
        urls.push(url)
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

function revoke(): void {
  while (urls.length > 0) {
    const url = urls.pop()
    if (url) URL.revokeObjectURL(url)
  }
}

watch(
  () => `${props.taskId}:${props.attachmentIds.join(',')}`,
  () => {
    revoke()
    void load()
  },
  { immediate: true }
)

onBeforeUnmount(revoke)
</script>

<template>
  <div v-if="items.length" class="conversation-user-attachments">
    <template v-for="item in items" :key="item.id">
      <img v-if="item.url" :src="item.url" :alt="item.name" />
      <span v-else class="conversation-file-chip">{{ item.name }}</span>
    </template>
  </div>
</template>
