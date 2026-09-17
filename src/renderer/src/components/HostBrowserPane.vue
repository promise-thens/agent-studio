<script setup lang="ts">
/**
 * 内置浏览器桌面右栏组件
 * 提供可随意调整尺寸的侧边栏布局、暗黑专业顶栏控制区、导航动作分发与 WebContentsView 容器管理。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  PhArrowClockwise as ArrowClockwise,
  PhArrowElbowDownLeft as ArrowElbowDownLeft,
  PhArrowLeft as ArrowLeft,
  PhArrowRight as ArrowRight,
  PhArrowSquareOut as ArrowSquareOut,
  PhCheck as Check,
  PhCircleNotch as CircleNotch,
  PhCompass as Compass,
  PhCopy as Copy,
  PhGlobe as Globe,
  PhLock as Lock,
  PhX as X,
  PhXCircle as XCircle
} from '@phosphor-icons/vue'
import { parseHostBrowserNavigateUrl } from '../../../shared/host-browser'

const props = defineProps<{
  /** 侧边浏览器是否处于开启显示状态 */
  visible: boolean
  /** 当前网页真实加载地址 */
  url: string
  /** 网页标题 */
  title: string
  /** 是否正在加载网络资源 */
  isLoading: boolean
  /** 浏览器历史是否可后退 */
  canGoBack?: boolean
  /** 浏览器历史是否可前进 */
  canGoForward?: boolean
  /** 当前选中的 Task 身份 */
  taskId?: string
}>()

const emit = defineEmits<{
  /** 请求导航至指定 URL */
  navigate: [url: string]
  /** 分发用户交互动作：后退、前进、刷新、停止加载 */
  act: [action: 'back' | 'forward' | 'reload' | 'stop']
  /** 用户请求关闭内置浏览器 */
  close: []
  /** 同步容器最新几何位置给主进程 WebContentsView */
  'update:bounds': [bounds: { x: number; y: number; width: number; height: number }]
  /** 用户拖拽改变面板宽度 */
  'update:width': [width: number]
}>()

/** 地址栏编辑框绑定的输入值 */
const inputUrl = ref(props.url)
/** 地址栏输入框 DOM 引用 */
const inputRef = ref<HTMLInputElement | null>(null)
/** 底层 WebContentsView 对齐的容器 DOM 引用 */
const containerRef = ref<HTMLElement | null>(null)
/** 整体面板 DOM 引用，用于测量尺寸与拖拽计算 */
const paneRef = ref<HTMLElement | null>(null)
/** 剪贴板复制成功微反馈定时器状态 */
const copiedRecently = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null

/** 是否正在拖拽调整侧边栏宽度 */
const isResizing = ref(false)
let resizeStartX = 0
let resizeStartWidth = 0

/** 尺寸监听器：容器宽高变动时及时通知主进程同步更新 Native View */
let resizeObserver: ResizeObserver | null = null

/** 当前加载页面是否具备有效可访问外链 */
const currentValidUrl = computed(() => parseHostBrowserNavigateUrl(props.url))
/** 是否属于 HTTPS 安全连接 */
const isSecureProtocol = computed(() => {
  const target = props.url || inputUrl.value
  return Boolean(target && target.toLowerCase().startsWith('https://'))
})
/** 是否展示空白就绪欢迎页（尚未输入或 about:blank） */
const isEmptyState = computed(() => {
  return !props.url || props.url === 'about:blank'
})
/** 输入框当前内容是否与已加载的 URL 不同 */
const hasUncommittedInput = computed(() => {
  const current = props.url || ''
  return inputUrl.value.trim() !== '' && inputUrl.value.trim() !== current.trim()
})

watch(
  () => props.url,
  (next) => {
    // 页面 URL 更新时，若用户没有在手动输入聚焦，则同步显示真实 URL
    if (document.activeElement !== inputRef.value) {
      inputUrl.value = next === 'about:blank' ? '' : next
    }
  }
)

/**
 * 智能解析并规范化用户输入的网页地址
 * 支持自动补全 https:// 协议前缀
 */
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

/**
 * 提交地址栏导航
 */
function onSubmit(): void {
  const targetUrl = resolveAddress(inputUrl.value)
  if (!targetUrl) return
  emit('navigate', targetUrl)
  inputRef.value?.blur()
}

/**
 * 按 Esc 键还原地址栏内容
 */
function onInputKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    inputUrl.value = props.url === 'about:blank' ? '' : props.url
    inputRef.value?.blur()
  }
}

/**
 * 清空输入框内容
 */
function onClearInput(): void {
  inputUrl.value = ''
  inputRef.value?.focus()
}

/**
 * 复制当前网址到系统剪贴板并展示高亮反馈
 */
async function copyCurrentUrl(): Promise<void> {
  const target = props.url || inputUrl.value
  if (!target) return
  try {
    await navigator.clipboard.writeText(target)
    copiedRecently.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copiedRecently.value = false
      copyTimer = null
    }, 1500)
  } catch {
    // 忽略剪贴板写入失败
  }
}

/**
 * 在系统默认浏览器中打开当前网页
 */
function openInExternalBrowser(): void {
  const target = currentValidUrl.value || resolveAddress(inputUrl.value)
  if (!target) return
  window.open(target, '_blank')
}

/**
 * 快捷导航直达
 */
function quickNavigate(url: string): void {
  inputUrl.value = url
  emit('navigate', url)
}

/**
 * 汇报容器在屏幕视口中的绝对矩形，使主进程 WebContentsView 严丝合缝覆盖
 */
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

/**
 * 鼠标在调整把手上按下，开始拖动修改宽度
 */
function onResizerPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  isResizing.value = true
  resizeStartX = event.clientX
  resizeStartWidth = paneRef.value?.getBoundingClientRect().width ?? 480

  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'

  window.addEventListener('pointermove', onResizerPointerMove)
  window.addEventListener('pointerup', onResizerPointerUp)
}

/**
 * 鼠标拖拽中：向左拉伸增大宽度，向右收缩减小宽度
 */
function onResizerPointerMove(event: PointerEvent): void {
  if (!isResizing.value) return
  const deltaX = resizeStartX - event.clientX
  const candidate = Math.round(resizeStartWidth + deltaX)
  // 最小宽度 320px，最大保证左侧对话区域保留至少 380px
  const maxAllowed = Math.max(340, window.innerWidth - 380)
  const clamped = Math.max(300, Math.min(candidate, maxAllowed))
  emit('update:width', clamped)
}

/**
 * 鼠标松开，结束拖动并清理事件与样式
 */
function onResizerPointerUp(): void {
  if (!isResizing.value) return
  isResizing.value = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  window.removeEventListener('pointermove', onResizerPointerMove)
  window.removeEventListener('pointerup', onResizerPointerUp)
}

/**
 * 双击拖拽条快速恢复默认舒适宽度（480px）
 */
function onResizerDblClick(): void {
  emit('update:width', 480)
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
  window.removeEventListener('pointermove', onResizerPointerMove)
  window.removeEventListener('pointerup', onResizerPointerUp)
  if (copyTimer) clearTimeout(copyTimer)
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
    ref="paneRef"
    class="host-browser-pane"
    role="complementary"
    :aria-label="title ? `内置浏览器：${title}` : '内置浏览器'"
  >
    <!-- 左侧边缘拖动分割条（支持随意调整大小，双击恢复默认） -->
    <div
      class="host-browser-resizer"
      :class="{ 'is-active': isResizing }"
      role="separator"
      aria-orientation="vertical"
      title="拖拽调整浏览器宽度，双击恢复默认 (480px)"
      @pointerdown="onResizerPointerDown"
      @dblclick="onResizerDblClick"
    >
      <div class="resizer-line" />
    </div>

    <!-- 拖拽调整大小过程中的防穿透遮罩层，防止鼠标进入 WebContentsView 造成拖拽丢失 -->
    <div v-if="isResizing" class="host-browser-drag-shield" />

    <!-- 现代精致深色浏览器顶栏 -->
    <header class="host-browser-chrome no-drag">
      <!-- 加载中微光流动进度条 -->
      <div v-if="isLoading" class="host-browser-progress-bar" />

      <!-- 导航操作按钮组（后退、前进、刷新/停止） -->
      <div class="host-browser-nav-group">
        <button
          type="button"
          class="browser-icon-btn"
          :disabled="!canGoBack"
          title="后退"
          aria-label="后退"
          @click="emit('act', 'back')"
        >
          <ArrowLeft :size="15" weight="bold" />
        </button>
        <button
          type="button"
          class="browser-icon-btn"
          :disabled="!canGoForward"
          title="前进"
          aria-label="前进"
          @click="emit('act', 'forward')"
        >
          <ArrowRight :size="15" weight="bold" />
        </button>
        <button
          type="button"
          class="browser-icon-btn"
          :title="isLoading ? '停止加载' : '重新加载'"
          :aria-label="isLoading ? '停止加载' : '重新加载'"
          @click="isLoading ? emit('act', 'stop') : emit('act', 'reload')"
        >
          <CircleNotch v-if="isLoading" :size="15" class="spinning-icon" />
          <ArrowClockwise v-else :size="15" />
        </button>
      </div>

      <!-- 全能地址栏（Omnibox） -->
      <form class="host-browser-address-box" @submit.prevent="onSubmit">
        <span
          class="address-protocol-badge"
          :class="{ 'is-secure': isSecureProtocol }"
          :title="isSecureProtocol ? '安全加密连接 (HTTPS)' : '网络连接'"
        >
          <Lock v-if="isSecureProtocol" :size="13" weight="fill" />
          <Globe v-else :size="13" />
        </span>

        <input
          ref="inputRef"
          v-model="inputUrl"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="输入网址（例如 github.com 或 https://...）"
          :aria-label="title || '浏览器地址'"
          @keydown="onInputKeydown"
        />

        <button
          v-if="inputUrl.trim()"
          type="button"
          class="address-clear-btn"
          title="清空网址"
          aria-label="清空网址"
          @click="onClearInput"
        >
          <XCircle :size="13" weight="fill" />
        </button>

        <button
          v-if="hasUncommittedInput"
          type="submit"
          class="address-go-btn"
          title="访问网址 (Enter)"
          aria-label="访问网址"
        >
          <ArrowElbowDownLeft :size="12" weight="bold" />
          <span>前往</span>
        </button>
      </form>

      <!-- 快捷工具按钮组（复制链接、外部打开、关闭） -->
      <div class="host-browser-actions-group">
        <button
          type="button"
          class="browser-icon-btn"
          :disabled="isEmptyState"
          :title="copiedRecently ? '链接已复制！' : '复制网页链接'"
          :aria-label="copiedRecently ? '链接已复制！' : '复制网页链接'"
          @click="copyCurrentUrl"
        >
          <Check v-if="copiedRecently" :size="15" class="copy-success-icon" />
          <Copy v-else :size="15" />
        </button>

        <button
          type="button"
          class="browser-icon-btn"
          :disabled="isEmptyState"
          title="在系统默认浏览器中打开"
          aria-label="在系统默认浏览器中打开"
          @click="openInExternalBrowser"
        >
          <ArrowSquareOut :size="15" />
        </button>

        <button
          type="button"
          class="browser-icon-btn close-btn"
          title="关闭内置浏览器"
          aria-label="关闭内置浏览器"
          @click="emit('close')"
        >
          <X :size="15" />
        </button>
      </div>
    </header>

    <!-- 页面容器：主进程 WebContentsView 会盖在此区域上 -->
    <div ref="containerRef" class="host-browser-surface">
      <!-- 空白待命状态（尚未加载网页时显示深色雅致就绪页） -->
      <div v-if="isEmptyState" class="host-browser-empty-state">
        <div class="empty-icon-wrap">
          <Compass :size="40" weight="duotone" />
        </div>
        <h4 class="empty-title">内置浏览器已就绪</h4>
        <p class="empty-desc">在上方地址栏输入网址访问，或在任务对话中由 Agent 驱动页面交互。</p>

        <div class="quick-links-group">
          <span class="quick-links-label">快捷访问：</span>
          <button
            type="button"
            class="quick-link-pill"
            @click="quickNavigate('https://github.com')"
          >
            GitHub
          </button>
          <button
            type="button"
            class="quick-link-pill"
            @click="quickNavigate('https://www.google.com')"
          >
            Google
          </button>
          <button type="button" class="quick-link-pill" @click="quickNavigate('https://bing.com')">
            Bing
          </button>
          <button
            type="button"
            class="quick-link-pill"
            @click="quickNavigate('https://news.ycombinator.com')"
          >
            Hacker News
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.host-browser-pane {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  border-left: 1px solid var(--border);
  background: var(--surface-1);
}

/* 拖拽分割条：悬浮在左边缘，方便随手调节宽度 */
.host-browser-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -4px;
  width: 8px;
  cursor: col-resize;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
}

.host-browser-resizer .resizer-line {
  width: 2px;
  height: 100%;
  background: transparent;
  transition: background 0.15s ease;
}

.host-browser-resizer:hover .resizer-line,
.host-browser-resizer.is-active .resizer-line {
  background: var(--accent);
}

/* 拖拽期间的遮罩层 */
.host-browser-drag-shield {
  position: absolute;
  inset: 0;
  z-index: 30;
  cursor: col-resize;
  background: transparent;
}

/* 顶栏工具条：深色质感、统一对齐、微高光下边框 */
.host-browser-chrome {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 44px;
  padding: 0 10px;
  background: var(--surface-1);
  border-bottom: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  -webkit-app-region: no-drag;
}

/* 加载中流动进度条 */
.host-browser-progress-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, var(--accent), #f3a879, var(--accent));
  background-size: 200% 100%;
  animation: shimmer-flow 1.2s infinite linear;
  z-index: 10;
}

@keyframes shimmer-flow {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}

/* 导航按钮组与操作按钮组 */
.host-browser-nav-group,
.host-browser-actions-group {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
}

/* 统一的浏览器小图标按钮 */
.browser-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-2);
  background: transparent;
  cursor: pointer;
  transition: all 0.12s ease;
}

.browser-icon-btn:hover:not(:disabled) {
  color: var(--text-1);
  background: var(--hover-fill);
}

.browser-icon-btn:active:not(:disabled) {
  background: var(--selected-fill);
}

.browser-icon-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.browser-icon-btn.close-btn:hover {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.copy-success-icon {
  color: var(--success);
}

.spinning-icon {
  animation: spin-pulse 0.9s infinite linear;
}

@keyframes spin-pulse {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* 地址栏输入框胶囊 */
.host-browser-address-box {
  display: flex;
  flex: 1;
  min-width: 0;
  height: 28px;
  align-items: center;
  gap: 6px;
  padding: 0 6px 0 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-2);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.host-browser-address-box:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent);
}

/* 协议状态小徽标 */
.address-protocol-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  flex-shrink: 0;
}

.address-protocol-badge.is-secure {
  color: var(--success);
}

.host-browser-address-box input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-1);
  font-size: 12px;
}

.host-browser-address-box input::placeholder {
  color: var(--text-3);
}

.address-clear-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  border-radius: 50%;
  flex-shrink: 0;
}

.address-clear-btn:hover {
  color: var(--text-2);
}

/* 地址栏内“前往”按钮 */
.address-go-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 20px;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--accent) 50%, transparent);
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  color: var(--accent);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.12s ease;
}

.address-go-btn:hover {
  background: var(--accent);
  color: var(--accent-ink);
}

/* 网页表面区域（Native View 对齐挂载区） */
.host-browser-surface {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: var(--surface-0);
  overflow: hidden;
}

/* 空白就绪面板 */
.host-browser-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
  text-align: center;
  color: var(--text-3);
}

.empty-icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 68px;
  height: 68px;
  margin-bottom: 16px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--accent);
}

.empty-title {
  margin: 0 0 6px 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
}

.empty-desc {
  margin: 0 0 20px 0;
  font-size: 12px;
  line-height: 1.6;
  max-width: 280px;
  color: var(--text-2);
}

.quick-links-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.quick-links-label {
  font-size: 11px;
  color: var(--text-3);
}

.quick-link-pill {
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-chip);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.12s ease;
}

.quick-link-pill:hover {
  color: var(--text-1);
  border-color: var(--border-strong);
  background: var(--surface-3);
}

@media (prefers-reduced-motion: reduce) {
  .host-browser-pane,
  .host-browser-progress-bar,
  .spinning-icon {
    animation: none;
    transition: none;
  }
}
</style>
