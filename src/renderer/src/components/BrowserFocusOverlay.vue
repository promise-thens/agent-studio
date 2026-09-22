<script setup lang="ts">
/**
 * 浏览器专注模式悬浮输入条 (Browser Focus Overlay)
 *
 * 核心职责：
 * 1. 彻底消除“后面还有线、感觉有两层”的视觉问题，100% 还原一体纯白/深色大气泡：
 *    - 彻底移除中间割裂横线，消息区与输入行纯粹流式自然排布；
 *    - 彻底消灭内部第二层与内外边框冲突：消息区与输入区全透明、无内框、无多余投影；
 *    - 只有最外层的单一外壳（.unified-focus-card）拥有统一的 24px 大圆角与柔和微阴影；
 *    - 输入交互行直接作为卡片底部的自然水平行，左侧加号、橙色完全访问、无边框输入框、右侧模型标签与发送按钮通透整洁；
 *    - 右上角折叠小小箭头极简纯净，彻底杜绝任何焦点外圈与橙色圆圈干扰；
 *    - 底部微型收缩指示器无缝贴合卡片底边缘（bottom: -6px），去底座化，绝无第二层底板。
 * 2. 状态与交互细节对标：
 *    - 左侧小加号圆钮：点击平滑退出专注模式，返回左右分栏；
 *    - 完全访问状态：橙色小盾牌 + 橙色字样“! 完全访问”（字号 13px，字重 500，色值 #f59e0b）；
 *    - 中间无边框 textarea 输入框，占位符为“随心输入”；
 *    - 右侧集合：运行转圈微环、模型纯文字标签、34px 正圆形发送/停止按钮；
 *    - 底部中央极微贴合折叠指示器 ⌄。
 * 3. 严格遵循 IPC 契约、IME 输入法保护与 Stop 执行身份三元组安全校验。
 */

import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  BROWSER_FOCUS_MAX_DRAFT,
  type BrowserFocusIntent,
  type BrowserFocusSnapshot
} from '../../../shared/browser-focus-overlay'

// 从 contextBridge 获取注入的专注模式浮层 IPC API
const api = window.browserFocusOverlay!

// 状态定义：投影快照、编辑器 DOM 引用、输入法组合态、草稿序列号与繁忙标志
const snapshot = ref<BrowserFocusSnapshot | null>(null)
const editor = ref<HTMLTextAreaElement | null>(null)
const composing = ref(false)
const sequence = ref(0)
const busy = ref(false)
const error = ref('')

// 上层“最近一条”回复展示区展开状态，默认当有消息时展开
const isCardExpanded = ref(true)

// 一键复制状态指示与定时器引用
const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | undefined

// 记录已收到的最新模型回复，以便在有新回复到达时自动展开卡片展示给用户
const lastSeenAssistantMessage = ref('')

// IPC 快照广播清理函数持有者
let unsubscribe: (() => void) | undefined

// 计算属性：草稿是否正在向主窗口同步确认中
const pending = computed(() => sequence.value > (snapshot.value?.draftAck ?? 0))

// 计算属性：当前任务是否正在执行中
const isRunning = computed(() => Boolean(snapshot.value?.execution))

// 计算属性：输入框内当前是否有输入内容
const hasInput = computed(() => {
  const localVal = editor.value?.value?.trim() ?? ''
  const draftVal = snapshot.value?.draft?.trim() ?? ''
  return Boolean(localVal || draftVal)
})

// 计算属性：发送按钮是否处于禁用状态
const sendDisabled = computed(
  () =>
    !snapshot.value?.canSend ||
    pending.value ||
    composing.value ||
    busy.value ||
    Boolean(error.value) ||
    !hasInput.value
)

// 计算属性：是否可实际发送（用于发送按钮高亮激活态）
const canActuallySend = computed(() => !sendDisabled.value && hasInput.value)

// 计算属性：是否有模型最新回复文本可供呈现
const hasLatestMessage = computed(() =>
  Boolean(
    snapshot.value?.latestAssistantMessage &&
    snapshot.value.latestAssistantMessage.trim().length > 0
  )
)

// 计算属性：纯文字展示模型名称（无背景底色，保持克制极简）
const displayModelLabel = computed(() => {
  const raw = snapshot.value?.modelLabel?.trim()
  if (!raw) return ''
  return raw
})

// 计算属性：是否处于完全访问状态（用于展示橙色线框小盾牌与“! 完全访问”文字）
const isFullAccess = computed(() => {
  const title = snapshot.value?.taskTitle?.trim() || ''
  const status = snapshot.value?.status?.trim() || ''
  return (
    title === '完全访问' ||
    title.includes('always-approve') ||
    status.includes('always-approve') ||
    status.includes('完全访问') ||
    status.includes('完全接管')
  )
})

// 计算属性：卡片底部副状态文本（如正在执行的步骤提示）
const cardSubStatus = computed(() => {
  if (isRunning.value) {
    return snapshot.value?.status?.trim() || 'Running...'
  }
  return ''
})

/**
 * 切换最近一条回复展示区的展开/收起状态
 */
function toggleCard(): void {
  isCardExpanded.value = !isCardExpanded.value
}

/**
 * 一键复制最新模型回复内容到剪贴板，并显示已复制提示
 */
async function copyLatestMessage(): Promise<void> {
  const text = snapshot.value?.latestAssistantMessage?.trim()
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    // 降级使用传统方式（如果 navigator.clipboard 不可用）
    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      copied.value = true
      if (copyTimer) clearTimeout(copyTimer)
      copyTimer = setTimeout(() => {
        copied.value = false
      }, 2000)
    } catch {
      // 忽略复制降级异常
    }
  }
}

/**
 * 接收来自主进程的状态投影：
 * 只接受确认后的投影；未确认和 IME 输入留在 DOM，不把回包覆盖到正在输入的文字上。
 */
function receive(next: BrowserFocusSnapshot): void {
  const previous = snapshot.value
  if (previous?.projectionId === next.projectionId && next.revision <= previous.revision) return
  const changed = previous?.projectionId !== next.projectionId
  if (changed) {
    sequence.value = next.draftAck
    composing.value = false
    error.value = ''
  }
  // 新确认投影允许重试临时失败；未确认输入和超长草稿仍保持禁用。
  if (
    !composing.value &&
    next.draftAck >= sequence.value &&
    new TextEncoder().encode(editor.value?.value ?? '').length <= BROWSER_FOCUS_MAX_DRAFT
  ) {
    error.value = ''
  }

  // 检查最新模型回复是否有新内容到达，若有新回复自动展开展示区呈现给用户
  const incomingMessage = next.latestAssistantMessage?.trim() || ''
  if (incomingMessage && incomingMessage !== lastSeenAssistantMessage.value) {
    lastSeenAssistantMessage.value = incomingMessage
    isCardExpanded.value = true
  }

  snapshot.value = next
  document.documentElement.dataset.theme = next.theme
  if (editor.value && (changed || (!composing.value && next.draftAck >= sequence.value))) {
    if (editor.value.value !== next.draft) editor.value.value = next.draft
  }
}

/**
 * 编辑草稿输入：
 * 编辑只回传主窗口，不在浮层保存草稿；发送前必须等待 draftAck 确认。
 */
async function edit(): Promise<void> {
  const state = snapshot.value
  if (!state || !editor.value || state.textareaDisabled) return
  const text = editor.value.value
  if (new TextEncoder().encode(text).length > BROWSER_FOCUS_MAX_DRAFT) {
    error.value = '草稿过长，请缩短后发送。'
    return
  }
  error.value = ''
  sequence.value += 1
  await dispatch({
    kind: 'draft',
    projectionId: state.projectionId,
    revision: state.revision,
    sequence: sequence.value,
    text
  })
}

/**
 * 发送操作意图到主进程：
 * 所有失败保持草稿并给出可见提示，不把 IPC 接收成功说成发送成功。
 */
async function dispatch(intent: BrowserFocusIntent): Promise<void> {
  try {
    const result = await api.dispatch(intent)
    if (!result.ok) error.value = result.error.message
  } catch {
    error.value = '主窗口暂不可用，请展开对话后重试。'
  }
}

/**
 * 触发操作（发送、停止或分栏展开）：
 * 运行态只发停止意图，由主窗口以真实 execution 三元组调用现有取消流程。
 * 注意：必须严格保留三元组结构以保证主进程与测试合约安全校验。
 */
async function action(kind: 'send' | 'stop' | 'expand'): Promise<void> {
  const state = snapshot.value
  if (!state || (kind === 'send' && sendDisabled.value)) return
  const execution = state.execution
  busy.value = true
  if (kind === 'stop') {
    if (!execution) {
      busy.value = false
      return
    }
    await dispatch({
      kind,
      projectionId: state.projectionId,
      revision: state.revision,
      // Vue 会深层代理 snapshot；显式复制标量，避免 Proxy 跨 contextBridge。
      execution: {
        executionId: execution.executionId,
        taskId: execution.taskId,
        turnId: execution.turnId
      }
    })
    busy.value = false
    return
  }
  if (kind === 'send') {
    await dispatch({ kind: 'send', projectionId: state.projectionId, revision: state.revision })
  } else {
    await dispatch({ kind: 'expand', projectionId: state.projectionId, revision: state.revision })
  }
  busy.value = false
}

/**
 * 键盘事件处理：
 * 1. 输入法候选确认不视为提交；
 * 2. Shift+Enter 换行，单纯 Enter 发送；
 * 3. Escape 键在展开回复卡片时收起回复展示区。
 */
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && isCardExpanded.value) {
    event.preventDefault()
    isCardExpanded.value = false
    return
  }
  if (
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.isComposing &&
    !composing.value &&
    event.keyCode !== 229
  ) {
    event.preventDefault()
    if (!snapshot.value?.execution) void action('send')
  }
}

// 监听编辑器节点就绪并同步初始草稿内容
watch(editor, (element) => {
  if (element && snapshot.value) element.value = snapshot.value.draft
})

// 组件挂载：订阅快照广播并执行初始只读同步
onMounted(async () => {
  unsubscribe = api.onSnapshot(receive)
  try {
    const result = await api.read()
    if (result.ok && result.value) receive(result.value)
    else if (!result.ok) error.value = result.error.message
  } catch {
    error.value = '无法读取主窗口草稿。'
  }
})

// 组件卸载：注销事件监听与清理定时器
onUnmounted(() => {
  unsubscribe?.()
  if (copyTimer) clearTimeout(copyTimer)
})
</script>

<template>
  <!-- 专注模式根容器：居中贴底对齐，主题自适应，全局隐藏粗滚动条 -->
  <div
    class="focus-overlay-container"
    :class="[snapshot?.theme === 'dark' ? 'theme-dark' : 'theme-light']"
  >
    <div v-if="snapshot" class="focus-overlay-inner" aria-label="浏览器专注模式输入与回复">
      <!-- ==========================================================================
           单一统一悬浮卡片 (Unified Glass Panel)：
           - 彻底消灭拼接感！将上部消息展示与下部输入栏置于单一外壳内；
           - 展开时大圆角 24px，折叠时平滑收缩为 9999px 完美药丸胶囊。
           ========================================================================== -->
      <div
        class="unified-focus-card"
        :class="{ 'is-collapsed': !isCardExpanded || !hasLatestMessage }"
        role="region"
        aria-label="专注交互面板"
      >
        <!-- ========================================================================
             上半部分：消息展示区（展开态）
             ======================================================================== -->
        <transition name="card-expand">
          <div
            v-if="hasLatestMessage && isCardExpanded"
            class="latest-message-card"
            role="region"
            aria-label="最近一条回复"
          >
            <!-- 顶部栏：左侧小灰字“最近一条”，右侧轻量折叠小箭头 v -->
            <div class="message-card-header">
              <span class="message-card-label">最近一条</span>
              <button
                type="button"
                class="collapse-toggle-btn"
                title="收起最近一条回复"
                aria-label="收起最近一条"
                @click="toggleCard"
              >
                <svg
                  class="collapse-arrow-icon"
                  viewBox="0 0 12 12"
                  width="11"
                  height="11"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M2.5 4.5L6 8L9.5 4.5" />
                </svg>
              </button>
            </div>

            <!-- 中部正文：模型最新回复文本，支持段落长文，彻底隐藏原生滚动条 -->
            <div class="message-card-body" tabindex="0">
              <p class="message-text">{{ snapshot.latestAssistantMessage }}</p>
            </div>

            <!-- 底部操作栏：左下角常驻复制小按钮 ⎘ 与辅助状态 -->
            <div class="message-card-footer">
              <button
                type="button"
                class="message-copy-btn"
                :class="{ 'is-copied': copied }"
                :title="copied ? '已复制到剪贴板' : '复制回复内容'"
                aria-label="复制回复"
                @click="copyLatestMessage"
              >
                <!-- 矩形复制图标 -->
                <svg
                  v-if="!copied"
                  class="copy-icon"
                  viewBox="0 0 16 16"
                  width="12"
                  height="12"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
                  <path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1" />
                </svg>
                <!-- 复制成功打勾图标 -->
                <svg
                  v-else
                  class="copy-icon check-icon"
                  viewBox="0 0 16 16"
                  width="12"
                  height="12"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
                </svg>
                <span class="copy-label">{{ copied ? '已复制' : '复制' }}</span>
              </button>

              <!-- 运行中副状态提示（如具体操作步骤） -->
              <span v-if="cardSubStatus" class="message-status-hint" :title="cardSubStatus">
                {{ cardSubStatus }}
              </span>
            </div>
          </div>
        </transition>

        <!-- ========================================================================
             下半部分：输入交互区（药丸输入栏无缝嵌入同一外壳）
             ======================================================================== -->
        <div class="pill-input-bar" role="form" aria-label="专注输入栏">
          <!-- 左侧圆形加号按钮：点击平滑退出专注模式，返回左右分栏 -->
          <button
            type="button"
            class="pill-plus-btn"
            title="退出专注模式，返回左右分栏"
            aria-label="退出专注模式"
            @click="action('expand')"
          >
            <svg
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <line x1="8" y1="3.5" x2="8" y2="12.5" />
              <line x1="3.5" y1="8" x2="12.5" y2="8" />
            </svg>
          </button>

          <!-- 完全访问状态展示：橙色小盾牌 + 橙色字样“! 完全访问” (严格对标 Image #2，字号 13px，500 字重，色值 #f59e0b) -->
          <div
            v-if="isFullAccess"
            class="full-access-shield"
            title="完全访问模式（已接管）"
            aria-label="完全访问模式"
          >
            <svg
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="none"
              stroke="#f59e0b"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M8 1.5L2.5 3.5v5c0 3.5 3.5 6 5.5 6.5 2-.5 5.5-3 5.5-6.5v-5L8 1.5z" />
              <line x1="8" y1="5.5" x2="8" y2="8.5" />
              <circle cx="8" cy="11" r="0.5" fill="#f59e0b" stroke="none" />
            </svg>
            <span class="full-access-label">! 完全访问</span>
          </div>

          <!-- 中间输入框区域：绝对没有黄色 outline，纯净随心输入 -->
          <div class="pill-editor-wrap">
            <textarea
              ref="editor"
              class="pill-textarea"
              rows="1"
              aria-label="随心输入"
              :disabled="snapshot.textareaDisabled"
              :maxlength="BROWSER_FOCUS_MAX_DRAFT"
              placeholder="随心输入"
              @input="edit"
              @compositionstart="composing = true"
              @compositionend="composing = false"
              @keydown="keydown"
            />
          </div>

          <!-- 右侧操作与状态集合区 -->
          <div class="pill-right-controls">
            <!-- 运行中转圈微环 (Spin Ring) -->
            <span
              v-if="isRunning"
              class="running-spin-ring"
              title="正在处理中"
              aria-label="正在处理中"
            >
              <svg
                viewBox="0 0 16 16"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                class="spin-svg"
                aria-hidden="true"
              >
                <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-opacity="0.2" />
                <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" stroke-linecap="round" />
              </svg>
            </span>

            <!-- 模型名称纯文字：无多余背景框，极致克制清爽 -->
            <span v-if="displayModelLabel" class="model-text-label" :title="displayModelLabel">
              {{ displayModelLabel }}
            </span>

            <!-- 正圆形操作按钮（直径 34px）：运行中为停止小方块，平时为向上细箭头 -->
            <!-- 停止按钮 (Stop) -->
            <button
              v-if="isRunning"
              type="button"
              class="pill-circle-btn stop-circle-btn"
              title="停止执行"
              aria-label="停止执行"
              @click="action('stop')"
            >
              <svg
                viewBox="0 0 14 14"
                width="10"
                height="10"
                fill="currentColor"
                aria-hidden="true"
              >
                <rect x="2.5" y="2.5" width="9" height="9" rx="1.5" />
              </svg>
            </button>

            <!-- 发送按钮 (Send) -->
            <button
              v-else
              type="button"
              class="pill-circle-btn send-circle-btn"
              :class="{ 'is-active': canActuallySend }"
              :disabled="sendDisabled"
              title="发送 (Enter)"
              aria-label="发送"
              @click="action('send')"
            >
              <svg
                viewBox="0 0 16 16"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M8 12.5V3.5" />
                <path d="M3.5 8L8 3.5L12.5 8" />
              </svg>
            </button>
          </div>
        </div>

        <!-- ========================================================================
             卡片最底部正中央：微型向下收缩/折叠展开指示器 ⌄ (对标 Image #2 / Image #17)
             ======================================================================== -->
        <button
          v-if="hasLatestMessage"
          type="button"
          class="bottom-collapse-handle"
          :class="{ 'is-collapsed': !isCardExpanded }"
          :title="isCardExpanded ? '收起最近一条回复' : '展开最近一条回复'"
          :aria-label="isCardExpanded ? '收起卡片' : '展开卡片'"
          @click="toggleCard"
        >
          <svg
            class="handle-arrow-icon"
            viewBox="0 0 12 12"
            width="10"
            height="10"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path :d="isCardExpanded ? 'M2.5 4.5L6 8L9.5 4.5' : 'M2.5 7.5L6 4L9.5 7.5'" />
          </svg>
        </button>
      </div>

      <!-- 底部错误提示吐司 -->
      <div v-if="error" class="overlay-error-toast" role="alert">
        {{ error }}
      </div>
    </div>

    <!-- 加载就绪前占位骨架 -->
    <div v-else class="overlay-placeholder" aria-busy="true">
      <span class="placeholder-spin" />
    </div>
  </div>
</template>

<style scoped>
/* ==========================================================================
   全局与局部滚动条隐形：彻底消除原生粗黑滚动条
   ========================================================================== */
:deep(*) {
  scrollbar-width: none !important;
  -ms-overflow-style: none !important;
}

:deep(*::-webkit-scrollbar) {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}

/* ==========================================================================
   浮层主容器：透明背景、绝对居底对齐、系统字体栈
   ========================================================================== */
.focus-overlay-container {
  width: 100vw;
  height: 100vh;
  margin: 0;
  padding: 0 16px 14px;
  box-sizing: border-box;
  background: transparent;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  overflow: hidden;
  user-select: none;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* 内部内容区域弹性布局与最大宽度 680px 限制 */
.focus-overlay-inner {
  width: 100%;
  max-width: 680px;
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
}

/* ==========================================================================
   单一统一悬浮卡片容器 (Unified Glass Panel)
   - 彻底废除两个独立容器相互叠压，将上下两部分纳入平滑大圆角外壳中！
   - 浅色模式：rgba(255, 255, 255, 0.96) + blur(24px) + 24px 大圆角 + 柔和投影
   - 深色模式：自适应深色微透明底色与边框
   - 折叠态：高度自动收缩为 52px，大圆角平滑过渡为 9999px 药丸胶囊形态
   ========================================================================== */
.unified-focus-card {
  width: 100%;
  max-width: 680px;
  position: relative;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 24px;
  box-shadow: 0 16px 48px -12px rgba(0, 0, 0, 0.18);
  transition: all 0.24s cubic-bezier(0.16, 1, 0.3, 1);
}

/* 深色模式自适应背景与光影 */
.theme-dark .unified-focus-card {
  background: rgba(28, 30, 34, 0.95);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255, 255, 255, 0.09);
  box-shadow: 0 16px 48px -12px rgba(0, 0, 0, 0.48);
}

/* 折叠收起态：卡片自动变身为经典 9999px 大圆角胶囊药丸 */
.unified-focus-card.is-collapsed {
  border-radius: 9999px;
}

/* ==========================================================================
   上半部分：消息展示区（展开态）
   ========================================================================== */
/* 上半部分：消息展示区（展开态）- 完全透明背景、无内框、无额外阴影，与气泡自然合一 */
.latest-message-card {
  width: 100%;
  box-sizing: border-box;
  padding: 14px 18px 4px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: transparent;
  border: none;
  box-shadow: none;
}

/* 顶部栏：标签与折叠小按钮 */
.message-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.message-card-label {
  font-size: 12px;
  color: #94a3b8;
  font-weight: 500;
  letter-spacing: 0.2px;
}

.theme-dark .message-card-label {
  color: #64748b;
}

/* 右上角轻量折叠小箭头：极简纯净，彻底杜绝任何焦点外圈、边框与橙色圆圈干扰 */
.collapse-toggle-btn {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: none !important;
  outline: none !important;
  box-shadow: none !important;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: all 0.15s ease;
}

.collapse-toggle-btn:hover {
  background: rgba(0, 0, 0, 0.05);
  color: #475569;
}

.collapse-toggle-btn:focus,
.collapse-toggle-btn:focus-visible,
.collapse-toggle-btn:active {
  outline: none !important;
  box-shadow: none !important;
}

.theme-dark .collapse-toggle-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #cbd5e1;
}

.theme-dark .collapse-toggle-btn:focus,
.theme-dark .collapse-toggle-btn:focus-visible,
.theme-dark .collapse-toggle-btn:active {
  outline: none !important;
  box-shadow: none !important;
}

/* 中间正文：文本换行、最大高度 220px，滚动条完全隐形 */
.message-card-body {
  max-height: 220px;
  overflow-y: auto;
  scrollbar-width: none !important;
  -ms-overflow-style: none !important;
  outline: none;
  margin: 0;
  padding: 0;
}

.message-card-body::-webkit-scrollbar {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}

.message-text {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.6;
  color: #1e293b;
  word-break: break-word;
  white-space: pre-wrap;
}

.theme-dark .message-text {
  color: #f1f5f9;
}

/* 底部操作栏：左下角复制按钮与副状态指示 */
.message-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 2px;
}

.message-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: #94a3b8;
  font-size: 11.5px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
  transition: all 0.15s ease;
}

.message-copy-btn:hover {
  color: #475569;
  background: rgba(0, 0, 0, 0.04);
}

.theme-dark .message-copy-btn:hover {
  color: #cbd5e1;
  background: rgba(255, 255, 255, 0.06);
}

.message-copy-btn.is-copied {
  color: #10b981;
}

.message-status-hint {
  font-size: 11.5px;
  color: #94a3b8;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.theme-dark .message-status-hint {
  color: #64748b;
}

/* ==========================================================================
   下半部分：输入交互区（药丸输入栏无缝嵌入同一外壳）
   ========================================================================== */
/* 下半部分：输入交互行 - 作为大气泡底部的自然水平行，无独立内外边框与阴影 */
.pill-input-bar {
  width: 100%;
  height: 52px;
  min-height: 52px;
  box-sizing: border-box;
  padding: 8px 14px 10px 18px;
  display: flex;
  align-items: center;
  gap: 10px;
  background: transparent;
  border: none;
  box-shadow: none;
}

/* 折叠收起为纯药丸胶囊时的匀称居中内边距 */
.unified-focus-card.is-collapsed .pill-input-bar {
  padding: 10px 14px 10px 18px;
}

/* 左侧加号按钮：小巧精致正圆按钮 */
.pill-plus-btn {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: #64748b;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.15s ease;
}

.pill-plus-btn:hover {
  background: rgba(0, 0, 0, 0.05);
  color: #0f172a;
}

.pill-plus-btn:focus,
.pill-plus-btn:focus-visible {
  outline: none !important;
  box-shadow: none !important;
}

.theme-dark .pill-plus-btn {
  color: #94a3b8;
}

.theme-dark .pill-plus-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #ffffff;
}

/* 完全访问展示：橙色小盾牌 + 橙色文字“! 完全访问” (严格对标 Image #2) */
.full-access-shield {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  user-select: none;
  margin-left: 2px;
}

.full-access-label {
  font-size: 13px;
  font-weight: 500;
  color: #f59e0b;
  white-space: nowrap;
}

/* 中间输入框区域 */
.pill-editor-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}

/* 输入框核心：绝对没有 outline 黄色粗边框，纯净无边界 */
.pill-textarea {
  width: 100%;
  height: 24px;
  border: none !important;
  outline: none !important;
  box-shadow: none !important;
  background: transparent;
  resize: none;
  font-size: 14px;
  color: #1e293b;
  line-height: 24px;
  padding: 0;
  margin: 0;
  font-family: inherit;
  scrollbar-width: none !important;
  -ms-overflow-style: none !important;
}

.pill-textarea::-webkit-scrollbar {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}

.theme-dark .pill-textarea {
  color: #f8fafc;
}

.pill-textarea::placeholder {
  color: #9ca3af;
  font-size: 14px;
}

.theme-dark .pill-textarea::placeholder {
  color: #64748b;
}

.pill-textarea:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 右侧操作集合区 */
.pill-right-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

/* 运行中转圈微环动画 */
.running-spin-ring {
  width: 16px;
  height: 16px;
  color: #64748b;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: ring-spin 0.9s linear infinite;
}

.theme-dark .running-spin-ring {
  color: #94a3b8;
}

@keyframes ring-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.spin-svg {
  display: block;
}

/* 模型名称纯文字：没有额外背景框，保持纯净 */
.model-text-label {
  font-size: 12px;
  color: #64748b;
  font-weight: 500;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: none;
}

.theme-dark .model-text-label {
  color: #94a3b8;
}

/* ==========================================================================
   正圆形操作按钮：直径 34px，完美对标截图
   ========================================================================== */
.pill-circle-btn {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.16s cubic-bezier(0.16, 1, 0.3, 1);
}

/* 停止按钮：深灰黑底，中间纯白小方块 */
.stop-circle-btn {
  background: #1e293b;
  color: #ffffff;
}

.stop-circle-btn:hover {
  background: #334155;
}

.theme-dark .stop-circle-btn {
  background: #334155;
  color: #ffffff;
}

.theme-dark .stop-circle-btn:hover {
  background: #475569;
}

/* 发送按钮：静止时柔和灰底 #cbd5e1，输入激活时高亮深黑底 #1e293b，中间纯白箭头 ↑ */
.send-circle-btn {
  background: #cbd5e1;
  color: #ffffff;
  cursor: default;
}

.send-circle-btn.is-active {
  background: #1e293b;
  cursor: pointer;
}

.send-circle-btn.is-active:hover {
  background: #0f172a;
}

.theme-dark .send-circle-btn {
  background: #334155;
  color: #94a3b8;
}

.theme-dark .send-circle-btn.is-active {
  background: #ffffff;
  color: #0f172a;
  cursor: pointer;
}

.theme-dark .send-circle-btn.is-active:hover {
  background: #e2e8f0;
}

.send-circle-btn:disabled:not(.is-active) {
  opacity: 0.6;
  cursor: not-allowed;
}

/* ==========================================================================
   卡片最底部正中央微型收缩/指示器按钮 ⌄ (对标 Image #2 底部的微指示器)
   ========================================================================== */
/* 卡片底部微型折叠指示器 ⌄：无缝贴合卡片底边缘，去底座化，无感微投影，绝无第二层底板错觉 */
.bottom-collapse-handle {
  position: absolute;
  bottom: -6px;
  left: 50%;
  transform: translateX(-50%);
  width: 32px;
  height: 12px;
  border-radius: 16px;
  border: 1px solid rgba(0, 0, 0, 0.06);
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #94a3b8;
  transition: all 0.16s cubic-bezier(0.16, 1, 0.3, 1);
  z-index: 10;
  padding: 0;
  outline: none !important;
}

.bottom-collapse-handle:focus,
.bottom-collapse-handle:focus-visible,
.bottom-collapse-handle:active {
  outline: none !important;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04) !important;
}

.bottom-collapse-handle:hover {
  color: #475569;
  border-color: rgba(0, 0, 0, 0.1);
  transform: translateX(-50%) scale(1.05);
}

.theme-dark .bottom-collapse-handle {
  background: rgba(28, 30, 34, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  color: #64748b;
}

.theme-dark .bottom-collapse-handle:focus,
.theme-dark .bottom-collapse-handle:focus-visible,
.theme-dark .bottom-collapse-handle:active {
  outline: none !important;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2) !important;
}

.theme-dark .bottom-collapse-handle:hover {
  color: #f8fafc;
  border-color: rgba(255, 255, 255, 0.15);
}

.handle-arrow-icon {
  display: block;
}

/* ==========================================================================
   错误提示小浮标与占位态
   ========================================================================== */
.overlay-error-toast {
  margin-top: 10px;
  position: relative;
  z-index: 3;
  font-size: 12px;
  color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
  padding: 4px 12px;
  border-radius: 6px;
  max-width: 100%;
  text-align: center;
}

.overlay-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 52px;
}

.placeholder-spin {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(0, 0, 0, 0.1);
  border-top-color: #64748b;
  border-radius: 50%;
  animation: ring-spin 0.8s linear infinite;
}

/* 上半部展开/折叠过渡动效 */
.card-expand-enter-active,
.card-expand-leave-active {
  transition: all 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  overflow: hidden;
}

.card-expand-enter-from,
.card-expand-leave-to {
  opacity: 0;
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  transform: translateY(-8px);
}

/* 减少动画偏好支持 */
@media (prefers-reduced-motion: reduce) {
  .unified-focus-card,
  .pill-circle-btn,
  .bottom-collapse-handle,
  .running-spin-ring,
  .placeholder-spin {
    transition: none !important;
    animation: none !important;
  }
}
</style>
