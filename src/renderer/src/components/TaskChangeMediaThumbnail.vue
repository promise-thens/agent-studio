<script setup lang="ts">
import { ref, watch } from 'vue'
import { createAttachmentPreviewUrl } from '../attachment-preview-url'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'

const props = defineProps<{
  taskId: string
  path: string
  kind: 'image' | 'pdf'
}>()

const ready = ref(false)
const imageUrl = ref<string | null>(null)
let loadGeneration = 0

/** 每次路径变化重新走受限 IPC；旧请求晚到时不得覆盖当前缩略图。 */
async function load(): Promise<void> {
  const generation = ++loadGeneration
  ready.value = false
  imageUrl.value = null
  try {
    const preview = unwrapDesktopIpcResult(
      await window.task.getChangeMediaPreview(props.taskId, props.path)
    )
    if (generation !== loadGeneration) return
    if (preview.thumbnailBase64 && preview.thumbnailMime) {
      imageUrl.value = createAttachmentPreviewUrl(preview.thumbnailBase64, preview.thumbnailMime)
    }
    ready.value = true
  } catch {
    if (generation === loadGeneration) ready.value = false
  }
}

watch(
  () => `${props.taskId}:${props.path}`,
  () => void load(),
  { immediate: true }
)
</script>

<template>
  <span v-if="ready" class="task-change-media-thumbnail" :data-kind="kind" aria-hidden="true">
    <img v-if="imageUrl" :src="imageUrl" alt="" />
    <span v-else>{{ kind === 'pdf' ? 'PDF' : 'IMG' }}</span>
  </span>
</template>
