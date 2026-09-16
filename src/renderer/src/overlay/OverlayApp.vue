<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  isAgentPointerTurnActive,
  resolveAgentPointerHudCopy,
  type AgentPointerSnapshot
} from '../../../shared/agent-pointer-overlay'
import type { OverlayDesktopApi } from '../../../shared/browser-plugin-overlay'

const snapshot = ref<AgentPointerSnapshot>({
  visible: false,
  surface: 'browser-plugin',
  persistWhenUnfocused: false
})
const cancelError = ref('')
let stopListening: (() => void) | undefined

function overlayApi(): OverlayDesktopApi | undefined {
  return window.overlay
}

function setChipHover(hovered: boolean): void {
  overlayApi()?.setChipHover(hovered)
}

/**
 * 芯片只在 overlayVisible && turnActive 时出现。
 * 插件：visible 即进行中（Turn 结束会隐藏 overlay）。
 * 宿主：有可停止的 execution 三元组才算进行中；闲置光标只留 pointer。
 * 进行中宿主句为「Grok 正在使用内置浏览器」。
 */
const hudCopy = computed(() =>
  resolveAgentPointerHudCopy({
    surface: snapshot.value.surface,
    overlayVisible: snapshot.value.visible,
    turnActive: isAgentPointerTurnActive(snapshot.value),
    takeoverCopy: null
  })
)

/** 芯片 aria-label 跟 surface 走；停止仍走 agent:cancel-turn。 */
const stopAriaLabel = computed(() =>
  snapshot.value.surface === 'host-browser' ? '停止内置浏览器控制' : '停止浏览器控制'
)

onMounted(() => {
  stopListening = overlayApi()?.onSnapshot((next) => {
    snapshot.value = next
    if (!next.visible) {
      cancelError.value = ''
    }
    // 闲置光标无芯片时必须恢复穿透，避免悬停状态把桌面点击吃掉
    if (!isAgentPointerTurnActive(next)) {
      setChipHover(false)
    }
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
      v-if="hudCopy"
      type="button"
      class="overlay-stop-chip"
      :aria-label="stopAriaLabel"
      @mouseenter="setChipHover(true)"
      @mouseleave="setChipHover(false)"
      @click="cancelTurn"
    >
      <span>{{ hudCopy }}</span>
      <span class="overlay-stop-action">停止</span>
    </button>
    <p v-if="cancelError" class="overlay-error" role="alert">{{ cancelError }}</p>
    <!-- 原点就是 click 落点；准星+圆心让人看清点在哪，不靠 18px 淡圈猜。 -->
    <div
      v-if="snapshot.pointer"
      class="overlay-cursor"
      aria-hidden="true"
      :style="{
        transform: `translate(${snapshot.pointer.x}px, ${snapshot.pointer.y}px)`
      }"
    >
      <span class="overlay-cursor-ring" />
      <span class="overlay-cursor-hair overlay-cursor-hair-x" />
      <span class="overlay-cursor-hair overlay-cursor-hair-y" />
      <span class="overlay-cursor-dot" />
    </div>
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
  -webkit-app-region: no-drag;
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
  width: 0;
  height: 0;
  pointer-events: none;
  transition: transform 180ms ease-out;
}

.overlay-cursor-ring {
  position: absolute;
  left: -16px;
  top: -16px;
  width: 32px;
  height: 32px;
  border: 2px solid var(--accent);
  border-radius: 50%;
  box-shadow:
    0 0 0 2px #111,
    0 0 0 3px color-mix(in srgb, #fff 70%, transparent);
  background: color-mix(in srgb, var(--accent) 18%, transparent);
}

.overlay-cursor-dot {
  position: absolute;
  left: -3px;
  top: -3px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow:
    0 0 0 1px #fff,
    0 0 0 2px #111;
}

.overlay-cursor-hair {
  position: absolute;
  background: var(--accent);
  box-shadow:
    0 0 0 1px #fff,
    0 0 0 2px #111;
}

.overlay-cursor-hair-x {
  left: -22px;
  top: -1px;
  width: 44px;
  height: 2px;
}

.overlay-cursor-hair-y {
  left: -1px;
  top: -22px;
  width: 2px;
  height: 44px;
}

@media (prefers-reduced-motion: reduce) {
  .overlay-cursor {
    transition: none;
  }
}
</style>
