<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  PhArrowClockwise as ArrowClockwise,
  PhArrowLeft as ArrowLeft,
  PhArrowRight as ArrowRight,
  PhX as X
} from '@phosphor-icons/vue'
import { parseHostBrowserNavigateUrl } from '../../../shared/host-browser'

const props = defineProps<{
  visible: boolean
  url: string
  title: string
  isLoading: boolean
  taskId?: string
}>()

const emit = defineEmits<{
  navigate: [url: string]
  close: []
  'update:bounds': [bounds: { x: number; y: number; width: number; height: number }]
}>()

const inputUrl = ref(props.url)
const containerRef = ref<HTMLElement | null>(null)
let resizeObserver: ResizeObserver | null = null

watch(
  () => props.url,
  (next) => {
    inputUrl.value = next
  }
)

/** 用户常省略协议；主进程仍只接受解析后的 http(s)。 */
function resolveAddress(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return trimmed
  if (parseHostBrowserNavigateUrl(trimmed)) return trimmed
  if (!trimmed.includes('://')) {
    const prefixed = `https://${trimmed}`
    if (parseHostBrowserNavigateUrl(prefixed)) return prefixed
  }
  return trimmed
}

function onSubmit(): void {
  const url = resolveAddress(inputUrl.value)
  if (!url) return
  emit('navigate', url)
}

function reportBounds(): void {
  if (!containerRef.value || !props.visible) return
  const rect = containerRef.value.getBoundingClientRect()
  emit('update:bounds', {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  })
}

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    reportBounds()
  })
  if (containerRef.value) resizeObserver.observe(containerRef.value)
  window.addEventListener('resize', reportBounds)
  void nextTick(() => reportBounds())
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('resize', reportBounds)
})

watch(
  () => props.visible,
  (visible) => {
    if (visible) void nextTick(() => reportBounds())
  },
  { immediate: true }
)
</script>

<template>
  <section
    v-show="visible"
    class="host-browser-pane"
    role="complementary"
    :aria-label="title ? `内置浏览器：${title}` : '内置浏览器'"
  >
    <header class="host-browser-chrome no-drag">
      <div class="host-browser-nav">
        <button type="button" class="icon-button" title="后退" aria-label="后退" disabled>
          <ArrowLeft :size="15" />
        </button>
        <button type="button" class="icon-button" title="前进" aria-label="前进" disabled>
          <ArrowRight :size="15" />
        </button>
        <button type="button" class="icon-button" title="刷新" aria-label="刷新" disabled>
          <ArrowClockwise :size="15" />
        </button>
      </div>
      <form class="host-browser-address" @submit.prevent="onSubmit">
        <input
          v-model="inputUrl"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="输入 https:// 网址"
          :disabled="isLoading"
          :aria-label="title || '浏览器地址'"
        />
        <button type="submit" :disabled="isLoading || !inputUrl.trim()">打开</button>
      </form>
      <button
        type="button"
        class="icon-button host-browser-close"
        title="关闭内置浏览器"
        aria-label="关闭内置浏览器"
        @click="emit('close')"
      >
        <X :size="15" />
      </button>
    </header>
    <!-- 真正的页面由主进程 WebContentsView 按这个矩形覆盖，Renderer 不加载 guest。 -->
    <div ref="containerRef" class="host-browser-surface" />
  </section>
</template>

<style scoped>
.host-browser-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  border-left: 1px solid var(--border);
  background: var(--surface-1);
}

.host-browser-chrome {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 8px 8px 8px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  -webkit-app-region: no-drag;
}

.host-browser-nav {
  display: flex;
  flex: 0 0 auto;
  gap: 2px;
}

.host-browser-address {
  display: flex;
  flex: 1;
  min-width: 0;
  gap: 6px;
}

.host-browser-address input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-chip);
  color: var(--text-1);
  background: var(--surface-2);
}

.host-browser-address button {
  flex: 0 0 auto;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-chip);
  color: var(--text-1);
  background: var(--surface-3);
  cursor: pointer;
}

.host-browser-address button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.host-browser-close {
  flex: 0 0 auto;
}

.host-browser-surface {
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: var(--surface-0);
}

@media (prefers-reduced-motion: reduce) {
  .host-browser-pane {
    animation: none;
  }
}
</style>
