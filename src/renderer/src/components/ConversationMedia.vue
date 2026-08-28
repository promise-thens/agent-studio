<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { PhDownloadSimple as DownloadSimple, PhX as X } from '@phosphor-icons/vue'
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
const dialog = ref<HTMLElement | null>(null)
const selected = ref<{ id: string; name: string; url: string } | null>(null)

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

/** 灯箱用原图；失败时回退缩略图，避免点击后空白。 */
async function openImage(item: { id: string; name: string; url?: string }): Promise<void> {
  if (!item.url) return
  selected.value = { id: item.id, name: item.name, url: item.url }
  try {
    const original = unwrapDesktopIpcResult(
      await window.task.getAttachmentImage(props.taskId, item.id)
    )
    const url = createAttachmentPreviewUrl(original.imageBase64, original.mimeType)
    if (url) selected.value = { id: item.id, name: original.originalName, url }
  } catch {
    selected.value = { id: item.id, name: item.name, url: item.url }
  }
  await nextTick()
  dialog.value?.focus()
}

function closeImage(): void {
  selected.value = null
}

function downloadImage(): void {
  if (!selected.value) return
  const link = document.createElement('a')
  link.href = selected.value.url
  link.download = selected.value.name
  link.rel = 'noopener'
  link.click()
}
</script>

<template>
  <div v-if="items.length" class="conversation-media" :data-variant="variant">
    <template v-for="item in items" :key="item.id">
      <button
        v-if="item.url"
        type="button"
        class="conversation-media-open"
        :title="`查看 ${item.name}`"
        :aria-label="`查看 ${item.name}`"
        @click="openImage(item)"
      >
        <img :src="item.url" :alt="item.name" />
      </button>
      <span v-else class="conversation-file-chip">{{ item.name }}</span>
    </template>
  </div>
  <div v-if="selected" class="attachment-image-backdrop" @click.self="closeImage">
    <section
      ref="dialog"
      class="attachment-image-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="`预览 ${selected.name}`"
      tabindex="-1"
      @keydown.esc.stop="closeImage"
    >
      <button
        type="button"
        class="attachment-image-download"
        title="下载图片"
        aria-label="下载图片"
        @click="downloadImage"
      >
        <DownloadSimple :size="18" weight="bold" />
      </button>
      <button
        type="button"
        class="attachment-image-close"
        title="关闭图片预览"
        aria-label="关闭图片预览"
        @click="closeImage"
      >
        <X :size="18" weight="bold" />
      </button>
      <img :src="selected.url" :alt="selected.name" />
    </section>
  </div>
</template>
