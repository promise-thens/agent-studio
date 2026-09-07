<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  BROWSER_PLUGIN_HUD_COPY,
  type BrowserPluginOverlaySnapshot,
  type OverlayDesktopApi
} from '../../../shared/browser-plugin-overlay'

const snapshot = ref<BrowserPluginOverlaySnapshot>({ visible: false, kind: 'browser' })
const cancelError = ref('')
let stopListening: (() => void) | undefined

function overlayApi(): OverlayDesktopApi | undefined {
  return window.overlay
}

onMounted(() => {
  stopListening = overlayApi()?.onSnapshot((next) => {
    snapshot.value = next
    if (!next.visible) cancelError.value = ''
  })
})

onBeforeUnmount(() => {
  stopListening?.()
})

/** 停止整场 Turn，走现有 agent:cancel-turn，不写 PTY。 */
async function cancelTurn(): Promise<void> {
  const result = await overlayApi()?.cancelTurn()
  if (result && !result.ok) cancelError.value = result.error.message
}
</script>

<template>
  <div class="overlay-root">
    <button
      v-if="snapshot.visible"
      type="button"
      class="overlay-stop-chip"
      aria-label="停止浏览器控制"
      @click="cancelTurn"
    >
      <span>{{ BROWSER_PLUGIN_HUD_COPY }}</span>
      <span class="overlay-stop-action">停止</span>
    </button>
    <p v-if="cancelError" class="overlay-error" role="alert">{{ cancelError }}</p>
    <!-- 仅当冻结键投影出屏幕 DIP 才挂光标节点；当前 pointer 恒缺省，DOM 里不会出现移动光标。 -->
    <div
      v-if="snapshot.pointer"
      class="overlay-cursor"
      :style="{
        transform: `translate(${snapshot.pointer.x}px, ${snapshot.pointer.y}px)`
      }"
    />
  </div>
</template>

<style>
:root {
  color-scheme: dark;
  --text-1: #eef2f6;
  --accent: #d98252;
  --danger: #dc6b6b;
  --surface-2: #161c24;
  --border: #29313d;
  --radius-chip: 999px;
}

html,
body,
#app {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: transparent;
}

.overlay-root {
  position: relative;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.overlay-stop-chip,
.overlay-error {
  pointer-events: auto;
}

.overlay-stop-chip {
  position: absolute;
  top: 24px;
  right: 24px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(360px, calc(100vw - 48px));
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--danger) 58%, var(--border));
  border-radius: var(--radius-chip);
  color: #f0b2b2;
  background: color-mix(in srgb, var(--danger) 18%, var(--surface-2));
  font:
    600 12px/1.4 -apple-system,
    BlinkMacSystemFont,
    'SF Pro Text',
    'Segoe UI',
    sans-serif;
  cursor: pointer;
}

.overlay-stop-chip:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 76%, white);
  outline-offset: 2px;
}

.overlay-stop-action {
  color: var(--text-1);
}

.overlay-error {
  position: absolute;
  top: 64px;
  right: 24px;
  max-width: min(360px, calc(100vw - 48px));
  margin: 0;
  color: #f0b2b2;
  font:
    600 12px/1.4 -apple-system,
    BlinkMacSystemFont,
    'SF Pro Text',
    'Segoe UI',
    sans-serif;
}

.overlay-cursor {
  position: absolute;
  top: 0;
  left: 0;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 35%, transparent);
  pointer-events: none;
  transition: transform 120ms ease-out;
}

@media (prefers-reduced-motion: reduce) {
  .overlay-cursor {
    transition: none;
  }
}
</style>
