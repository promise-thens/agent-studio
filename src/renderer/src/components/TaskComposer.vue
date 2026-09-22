<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import {
  PhListChecks as ListChecks,
  PhPaperclip as Paperclip,
  PhPaperPlaneTilt as PaperPlaneTilt,
  PhStop as Stop,
  PhX as X
} from '@phosphor-icons/vue'
import type { TaskAttachmentKind } from '../../../shared/task-attachment'
import type { AgentAvailableCommand } from '../../../shared/agent-available-command'
import type {
  ProviderConfigSummary,
  ProviderModelOption,
  ProviderTestResult
} from '../../../shared/provider'
import {
  PRODUCT_SLASH_COMMANDS,
  completeSlashComposerPrompt,
  filterSlashCommands,
  isSlashComposerDraft,
  matchProductSlashSubmit,
  mergeSlashCommands,
  resolveSlashSubmit,
  shouldShowSlashRuntimeWaiting,
  slashQuery,
  type SlashCommandItem
} from '../slash-command-palette'
import { resolveTakeoverHudCopy, type TaskPermissionMode } from '../../../shared/task-takeover'
import {
  resolveAgentPointerHudCopy,
  type AgentPointerSurface
} from '../../../shared/agent-pointer-overlay'
import { isPlanCommandAdvertised, type ComposerPlanMode } from '../../../shared/session-plan-mode'
import { resolveComposerPlanStatusCopy, resolveComposerPlanSwitch } from '../composer-plan-mode'
import {
  resolveComposerAddMenuFocusIndex,
  type ComposerAddMenuNavigationKey,
  type ComposerContextUsagePresentation
} from '../task-composer-actions'
import ModelSelector from './ModelSelector.vue'
import SlashCommandPalette from './SlashCommandPalette.vue'
import TaskPermissionModeMenu from './TaskPermissionModeMenu.vue'
import TaskTakeoverConfirmDialog from './TaskTakeoverConfirmDialog.vue'

const props = defineProps<{
  prompt: string
  canSend: boolean
  action: 'send' | 'stop'
  /** title 永远是「停止 Task ${taskId}」，避免停错当前选中项。 */
  stopTitle: string
  /** 可读标题只进 aria-label，不替代 taskId 身份。 */
  stopAriaLabel?: string
  disabledMessage?: string
  textareaDisabled?: boolean
  model: ProviderModelOption | null
  loadModels: () => Promise<ProviderTestResult>
  selectModel: (model: ProviderModelOption) => Promise<ProviderConfigSummary>
  modelBusy?: boolean
  modelDisabled?: boolean
  permissionMode?: TaskPermissionMode
  takeoverConfirmed?: boolean
  permissionBusy?: boolean
  takeoverApplied?: boolean
  takeoverMayStillBeActive?: boolean
  setPermissionMode: (mode: TaskPermissionMode) => Promise<void>
  /** Plan 是独立轴，不是第四个批准档；无广告时按钮保持 disabled。 */
  planMode?: ComposerPlanMode
  /** 仅 Grok Runtime 可在未广告命令时启用受控 Plan 路径。 */
  planAvailable?: boolean
  setPlanMode: (mode: ComposerPlanMode) => Promise<void>
  /** Runtime 上报的上下文用量；无可信样本时明确显示未知。 */
  contextUsage?: ComposerContextUsagePresentation | null
  runtimeCommands?: AgentAvailableCommand[]
  attachments?: Array<{
    attachmentId: string
    originalName: string
    kind: TaskAttachmentKind
    previewUrl?: string
  }>
  promptMediaHint?: string | null
  /**
   * overlay 快照的 visible。写文件进行中必须为 false，避免冒充浏览器句。
   * 不得单独把 visible 当成插件进行中：宿主闲置光标也是 visible。
   */
  overlayVisible?: boolean
  /** 缺省按浏览器插件理解；宿主闲置/进行中必须显式传 host-browser。 */
  overlaySurface?: AgentPointerSurface
  /** 宿主闲置光标为 false；插件 visible 时由 App 标 true。 */
  overlayTurnActive?: boolean
}>()

const emit = defineEmits<{
  'update:prompt': [value: string]
  send: []
  stop: []
  modelChanged: [summary: ProviderConfigSummary]
  modelError: [message: string]
  'open-plugins': []
  'open-plugins-mcp': []
  'open-plugins-marketplace': []
  'open-settings': []
  'open-settings-memory': []
  'open-settings-grok-config': []
  'pick-attachments': []
  'import-dropped-paths': [paths: string[]]
  'import-clipboard': []
  'remove-attachment': [attachmentId: string]
}>()

const pendingTakeover = ref(false)
const takeoverConfirmBusy = ref(false)
const takeoverConfirmError = ref('')
const showAddMenu = ref(false)
const addMenuTrigger = ref<HTMLButtonElement | null>(null)
const addMenuPanel = ref<HTMLElement | null>(null)
const usageDetailsId = `${useId()}-context-usage`
const usageHovered = ref(false)
const usageFocused = ref(false)
const usageDismissed = ref(false)
const showUsageDetails = computed(
  () =>
    Boolean(props.contextUsage) &&
    !usageDismissed.value &&
    (usageHovered.value || usageFocused.value)
)

function handleUsagePointerEnter(): void {
  usageHovered.value = true
  usageDismissed.value = false
}

function handleUsagePointerLeave(): void {
  usageHovered.value = false
  usageDismissed.value = false
}

function handleUsageFocus(): void {
  usageFocused.value = true
}

function handleUsageBlur(): void {
  usageFocused.value = false
  usageDismissed.value = false
}

/** Esc 只关闭详情，不触发工作台级快捷键或清空草稿。 */
function dismissUsageDetails(): void {
  usageDismissed.value = true
}

watch(
  () => props.contextUsage,
  () => {
    usageHovered.value = false
    usageFocused.value = false
    usageDismissed.value = false
  }
)

const planSwitch = computed(() =>
  resolveComposerPlanSwitch({
    advertisedCommands: props.runtimeCommands ?? [],
    allowUnadvertisedPlan: props.planAvailable === true,
    mode: props.planMode ?? 'normal',
    modelBusy: Boolean(props.modelBusy),
    composerAction: props.action,
    hasActiveExecution: props.action === 'stop'
  })
)
const planStatusCopy = computed(() =>
  resolveComposerPlanStatusCopy({
    mode: props.planMode ?? 'normal',
    idle: !props.modelBusy && props.action === 'send',
    hasPlanCommand: isPlanCommandAdvertised(props.runtimeCommands ?? []),
    allowUnadvertisedPlan: props.planAvailable === true
  })
)
const addMenuDisabled = computed(() => Boolean(props.textareaDisabled) || props.action === 'stop')
/** 执行中开了完全访问就必须看得见：不再询问，避免用户以为卡死。 */
const takeoverHudCopy = computed(() =>
  resolveTakeoverHudCopy({
    takeoverEnabled: props.permissionMode === 'takeover',
    takeoverApplied: props.takeoverApplied === true,
    takeoverMayStillBeActive: props.takeoverMayStillBeActive,
    executing: props.action === 'stop'
  })
)
/**
 * 与接管共用一条 role=status 停止条：接管句优先。
 * 必须吃 surface + turnActive：宿主闲置光标不得出插件句或宿主进行中句。
 */
const composerHudCopy = computed(() =>
  resolveAgentPointerHudCopy({
    surface: props.overlaySurface === 'host-browser' ? 'host-browser' : 'browser-plugin',
    overlayVisible: props.overlayVisible === true,
    turnActive: props.overlayTurnActive === true,
    takeoverCopy: takeoverHudCopy.value
  })
)

/** 只改下一轮发送策略，不得 cancel 当前 turn。进入 Plan 仍需广告；退出只要空闲。 */
async function togglePlanMode(): Promise<void> {
  if (planSwitch.value.disabled) return
  const next: ComposerPlanMode = (props.planMode ?? 'normal') === 'plan' ? 'normal' : 'plan'
  try {
    await props.setPlanMode(next)
    closeAddMenu(true)
  } catch {
    // App 已写入错误；本地不得乐观拨开关。
  }
}

/** 只返回当前菜单中可操作的按钮，disabled 项不进入方向键循环。 */
function getEnabledAddMenuItems(): HTMLButtonElement[] {
  if (!addMenuPanel.value) return []
  return Array.from(
    addMenuPanel.value.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"], [role="menuitemcheckbox"]'
    )
  ).filter((item) => !item.disabled)
}

async function toggleAddMenu(): Promise<void> {
  if (addMenuDisabled.value) return
  if (showAddMenu.value) {
    closeAddMenu()
    return
  }
  showAddMenu.value = true
  await nextTick()
  getEnabledAddMenuItems()[0]?.focus()
}

/** Esc 关闭后把焦点还给触发器；鼠标点外部时保留浏览器自然焦点。 */
function closeAddMenu(returnFocus = false): void {
  showAddMenu.value = false
  if (!returnFocus) return
  // 等菜单项从 DOM 卸载后再恢复焦点，避免焦点短暂落到已删除节点。
  void nextTick(() => addMenuTrigger.value?.focus())
}

/** 点击上传附件：关闭添加菜单并向外部派发选择附件事件 */
function handlePickAttachments(): void {
  closeAddMenu()
  emit('pick-attachments')
}

/** 添加菜单采用标准 menu 键盘导航，且只在本菜单内消费这些按键。 */
function handleAddMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeAddMenu(true)
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const items = getEnabledAddMenuItems()
  const currentIndex = items.findIndex((item) => item === document.activeElement)
  const nextIndex = resolveComposerAddMenuFocusIndex(
    event.key as ComposerAddMenuNavigationKey,
    currentIndex,
    items.length
  )
  if (nextIndex !== null) items[nextIndex]?.focus()
}

function handleDocumentPointerdown(event: PointerEvent): void {
  const target = event.target
  if (!(target instanceof Element)) return
  if (!target.closest('.composer-add-menu')) closeAddMenu()
}

onMounted(() => document.addEventListener('pointerdown', handleDocumentPointerdown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', handleDocumentPointerdown))

/** 全局确认只询问一次；运行中允许提交待应用偏好，不借用模型切换锁。 */
async function handlePermissionModeSelect(mode: TaskPermissionMode): Promise<void> {
  if (props.permissionBusy || props.modelDisabled) return
  if (mode === 'takeover' && !props.takeoverConfirmed) {
    takeoverConfirmError.value = ''
    pendingTakeover.value = true
    return
  }
  try {
    await props.setPermissionMode(mode)
  } catch {
    // 错误已由 App 写入对话；确认框路径另有可见错误。
  }
}

function cancelTakeoverConfirm(): void {
  if (takeoverConfirmBusy.value) return
  pendingTakeover.value = false
  takeoverConfirmError.value = ''
}

async function confirmTakeover(): Promise<void> {
  if (takeoverConfirmBusy.value) return
  takeoverConfirmBusy.value = true
  takeoverConfirmError.value = ''
  try {
    await props.setPermissionMode('takeover')
    pendingTakeover.value = false
  } catch (error) {
    takeoverConfirmError.value = error instanceof Error ? error.message : '切换批准模式失败。'
  } finally {
    takeoverConfirmBusy.value = false
  }
}

const textarea = ref<HTMLTextAreaElement | null>(null)
const stopButton = ref<HTMLButtonElement | null>(null)
const imageDialog = ref<HTMLElement | null>(null)
const selectedImage = ref<{ url: string; name: string } | null>(null)
const dragging = ref(false)

/** 打开图片详情并把焦点移入灯箱，确保 Esc 不会被工作台快捷键误处理。 */
async function openImagePreview(url: string, name: string): Promise<void> {
  selectedImage.value = { url, name }
  await nextTick()
  imageDialog.value?.focus()
}

function closeImagePreview(): void {
  selectedImage.value = null
}

function handleDragOver(event: DragEvent): void {
  if (props.textareaDisabled) return
  event.preventDefault()
  dragging.value = true
}

function handleDragLeave(): void {
  dragging.value = false
}

function handleDrop(event: DragEvent): void {
  event.preventDefault()
  dragging.value = false
  if (props.textareaDisabled) return
  const files = [...(event.dataTransfer?.files ?? [])]
  const paths = window.task.resolveDroppedFilePaths(files)
  if (paths.length > 0) emit('import-dropped-paths', paths)
}

function handlePaste(event: ClipboardEvent): void {
  if (props.textareaDisabled) return
  const items = [...(event.clipboardData?.items ?? [])]
  const files = [...(event.clipboardData?.files ?? [])]
  const hasBinary = files.length > 0 || items.some((item) => item.type.startsWith('image/'))
  if (!hasBinary) return
  event.preventDefault()
  const text = event.clipboardData?.getData('text') ?? ''
  if (text) emit('update:prompt', `${props.prompt}${text}`)
  emit('import-clipboard')
}
const paletteDismissed = ref(false)
const activeIndex = ref(0)

const slashDraft = computed(() => isSlashComposerDraft(props.prompt))
const query = computed(() => slashQuery(props.prompt))
const mergedCommands = computed(() =>
  mergeSlashCommands({
    runtime: props.runtimeCommands ?? [],
    product: PRODUCT_SLASH_COMMANDS
  })
)
const filteredCommands = computed(() => filterSlashCommands(mergedCommands.value, query.value))
const showPalette = computed(() => slashDraft.value && !paletteDismissed.value)
const waitingRuntimeCommands = computed(() =>
  shouldShowSlashRuntimeWaiting(props.runtimeCommands ?? [], query.value)
)

watch(query, () => {
  activeIndex.value = 0
})

watch(slashDraft, (draft) => {
  if (!draft) paletteDismissed.value = false
})

watch(filteredCommands, (items) => {
  if (activeIndex.value >= items.length) {
    activeIndex.value = Math.max(0, items.length - 1)
  }
})

function emitProductAction(action: NonNullable<SlashCommandItem['productAction']>): void {
  if (action === 'open-permission-mode') {
    openPermissionModeFromSlash()
    return
  }
  if (action === 'open-plugins') emit('open-plugins')
  else if (action === 'open-plugins-mcp') emit('open-plugins-mcp')
  else if (action === 'open-plugins-marketplace') emit('open-plugins-marketplace')
  else if (action === 'open-settings-memory') emit('open-settings-memory')
  else if (action === 'open-settings-grok-config') emit('open-settings-grok-config')
  else emit('open-settings')
}

/** 广告的 /always-approve 只打开确认/菜单，不得当成 runtime prompt 发出去。 */
function openPermissionModeFromSlash(): void {
  emit('update:prompt', '')
  void handlePermissionModeSelect('takeover')
}

function submitPaletteItem(item: SlashCommandItem): void {
  const prompt =
    item.source === 'runtime' ? completeSlashComposerPrompt(item, props.prompt) : props.prompt
  const resolved = resolveSlashSubmit(item, prompt)
  if (resolved.kind === 'product') {
    emitProductAction(resolved.action)
    return
  }
  emit('update:prompt', resolved.prompt)
  // 执行中发送被挡住：产品别名仍可导航，runtime 命令不得偷偷 startTurn。
  if (props.action !== 'send') return
  emit('send')
}

/** 输入法确认候选词时保留 Enter，避免未上屏就发送。 */
function handleComposerKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return

  if (event.key === 'Escape' && showPalette.value) {
    event.preventDefault()
    paletteDismissed.value = true
    return
  }
  if (event.key === 'Escape' && showAddMenu.value) {
    event.preventDefault()
    event.stopPropagation()
    closeAddMenu(true)
    return
  }

  if (showPalette.value && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault()
    const count = filteredCommands.value.length
    if (count === 0) return
    const delta = event.key === 'ArrowDown' ? 1 : -1
    activeIndex.value = (activeIndex.value + delta + count) % count
    return
  }

  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()

  if (showPalette.value) {
    const item = filteredCommands.value[activeIndex.value]
    if (item) {
      submitPaletteItem(item)
      return
    }
  }

  // 发送拦截：即便没点命令板，首 token 是产品别名也不 startTurn。
  const productAction = matchProductSlashSubmit(props.prompt)
  if (productAction) {
    emitProductAction(productAction)
    return
  }

  if (props.action === 'stop') return
  emit('send')
}

function handleSendClick(): void {
  const productAction = matchProductSlashSubmit(props.prompt)
  if (productAction) {
    emitProductAction(productAction)
    return
  }
  emit('send')
}

function focus(): void {
  textarea.value?.focus()
}

/** Esc 工作台快捷键把焦点放到停止，而不是先关检查器。 */
function focusStop(): void {
  stopButton.value?.focus()
}

defineExpose({ focus, focusStop, openPermissionModeFromSlash })
</script>

<template>
  <footer class="composer-wrap">
    <div
      class="composer"
      :class="{ dragging }"
      @dragenter="handleDragOver"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <SlashCommandPalette
        v-if="showPalette"
        :items="filteredCommands"
        :active-index="activeIndex"
        :waiting="waitingRuntimeCommands"
        @select="submitPaletteItem"
      />
      <ul v-if="attachments?.length" class="composer-attachments" aria-label="待发送附件">
        <li
          v-for="item in attachments"
          :key="item.attachmentId"
          class="composer-attachment"
          :class="{ 'composer-attachment--image': item.kind === 'image' && item.previewUrl }"
          :aria-label="item.originalName"
        >
          <button
            v-if="item.kind === 'image' && item.previewUrl"
            type="button"
            class="composer-attachment-image-trigger"
            :title="`查看 ${item.originalName}`"
            :aria-label="`查看 ${item.originalName}`"
            @click="openImagePreview(item.previewUrl, item.originalName)"
          >
            <img
              :src="item.previewUrl"
              :alt="item.originalName"
              class="composer-attachment-thumb"
            />
          </button>
          <span v-else class="composer-attachment-name" :title="item.originalName">{{
            item.originalName
          }}</span>
          <button
            type="button"
            class="composer-attachment-remove"
            :title="`移除 ${item.originalName}`"
            :aria-label="`移除 ${item.originalName}`"
            @click="emit('remove-attachment', item.attachmentId)"
          >
            <X :size="12" weight="bold" />
          </button>
        </li>
      </ul>
      <textarea
        ref="textarea"
        :value="prompt"
        :disabled="textareaDisabled"
        :aria-describedby="disabledMessage ? 'prompt-capability-message' : undefined"
        :aria-expanded="showPalette ? 'true' : 'false'"
        :aria-controls="showPalette ? 'slash-command-list' : undefined"
        rows="1"
        placeholder="描述你想修改、排查或验证的内容…"
        @input="emit('update:prompt', ($event.target as HTMLTextAreaElement).value)"
        @keydown="handleComposerKeydown"
        @paste="handlePaste"
      />
      <div class="composer-footer">
        <div class="composer-context">
          <ModelSelector
            :model="model"
            :load-models="loadModels"
            :select-model="selectModel"
            :busy="modelBusy"
            :disabled="modelDisabled"
            @changed="emit('modelChanged', $event)"
            @error="emit('modelError', $event)"
          />
          <TaskPermissionModeMenu
            :mode="permissionMode ?? 'ask'"
            :busy="permissionBusy"
            :disabled="modelDisabled"
            :takeover-applied="takeoverApplied === true"
            :takeover-may-still-be-active="takeoverMayStillBeActive === true"
            @select="handlePermissionModeSelect"
          />
          <div class="composer-add-menu">
            <button
              ref="addMenuTrigger"
              type="button"
              class="composer-add-trigger"
              :class="{ 'is-plan': planSwitch.pressed }"
              title="添加能力"
              aria-label="添加能力"
              :aria-expanded="showAddMenu"
              aria-controls="composer-add-panel"
              aria-haspopup="menu"
              :disabled="addMenuDisabled"
              @click="toggleAddMenu"
            >
              <span aria-hidden="true">＋</span>
            </button>
            <div
              v-if="showAddMenu"
              id="composer-add-panel"
              ref="addMenuPanel"
              class="composer-add-panel"
              role="menu"
              aria-label="添加能力"
              @keydown="handleAddMenuKeydown"
            >
              <button
                type="button"
                class="composer-add-item"
                role="menuitemcheckbox"
                :class="{ 'is-plan': planSwitch.pressed }"
                :disabled="planSwitch.disabled"
                :aria-checked="planSwitch.pressed"
                :title="planSwitch.title"
                @click="togglePlanMode"
              >
                <ListChecks :size="15" weight="fill" />
                <span>
                  <strong>{{ planSwitch.pressed ? '关闭计划模式' : '计划模式' }}</strong>
                  <small>{{
                    planSwitch.pressed ? '下一轮继续使用普通模式' : '让 Grok 先拆解并确认计划'
                  }}</small>
                </span>
                <span v-if="planSwitch.pressed" class="composer-add-check" aria-hidden="true"
                  >●</span
                >
              </button>
              <button
                type="button"
                class="composer-add-item"
                role="menuitem"
                :disabled="addMenuDisabled"
                @click="handlePickAttachments"
              >
                <Paperclip :size="15" />
                <span>
                  <strong>上传附件</strong>
                  <small>图片、文档或其他文件</small>
                </span>
              </button>
            </div>
          </div>
          <span v-if="planStatusCopy" class="composer-plan-status" role="status">{{
            planStatusCopy
          }}</span>
        </div>
        <div class="composer-actions">
          <button
            v-if="contextUsage"
            type="button"
            class="composer-usage"
            :title="contextUsage.title"
            :aria-label="contextUsage.ariaLabel"
            :aria-describedby="showUsageDetails ? usageDetailsId : undefined"
            :aria-expanded="showUsageDetails"
            @mouseenter="handleUsagePointerEnter"
            @mouseleave="handleUsagePointerLeave"
            @focus="handleUsageFocus"
            @blur="handleUsageBlur"
            @keydown.esc.stop.prevent="dismissUsageDetails"
          >
            <!-- 纯净圆环进度指示器：中心无数字，保持视觉清爽优雅 -->
            <span
              class="composer-usage-ring"
              :class="{ 'is-unknown': contextUsage.percentage === null }"
              aria-hidden="true"
            >
              <svg viewBox="0 0 36 36">
                <circle class="composer-usage-ring-track" cx="18" cy="18" r="14" pathLength="100" />
                <circle
                  class="composer-usage-ring-value"
                  cx="18"
                  cy="18"
                  r="14"
                  pathLength="100"
                  :stroke-dasharray="`${contextUsage.percentage ?? 0} 100`"
                />
              </svg>
            </span>
            <!-- 悬浮用量卡片：对齐图3的居中精致卡片视觉 -->
            <span
              v-if="showUsageDetails"
              :id="usageDetailsId"
              class="composer-usage-details"
              role="tooltip"
            >
              <span class="composer-usage-card-title">背景信息窗口：</span>
              <strong class="composer-usage-card-headline">{{ contextUsage.cardHeadline }}</strong>
              <span class="composer-usage-card-subline">{{ contextUsage.cardTokenDetail }}</span>
            </span>
          </button>
          <span
            v-if="composerHudCopy"
            class="composer-takeover-hud no-drag"
            role="status"
            :title="composerHudCopy"
          >
            {{ composerHudCopy }}
          </span>
          <button
            v-if="action === 'stop'"
            ref="stopButton"
            class="stop-button"
            type="button"
            data-composer-stop
            :title="stopTitle"
            :aria-label="stopAriaLabel || stopTitle"
            @click="emit('stop')"
          >
            <Stop :size="15" weight="fill" />停止
          </button>
          <button
            v-else
            class="send-button"
            type="button"
            :disabled="!canSend"
            :title="disabledMessage || '发送'"
            :aria-label="disabledMessage || '发送'"
            :aria-describedby="disabledMessage ? 'prompt-capability-message' : undefined"
            @click="handleSendClick"
          >
            <PaperPlaneTilt :size="17" weight="fill" />
          </button>
        </div>
      </div>
    </div>
    <div v-if="selectedImage" class="attachment-image-backdrop" @click.self="closeImagePreview">
      <section
        ref="imageDialog"
        class="attachment-image-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="`预览 ${selectedImage.name}`"
        tabindex="-1"
        @keydown.esc.stop="closeImagePreview"
      >
        <button
          type="button"
          class="attachment-image-close"
          title="关闭图片预览"
          aria-label="关闭图片预览"
          @click="closeImagePreview"
        >
          <X :size="18" weight="bold" />
        </button>
        <img :src="selectedImage.url" :alt="selectedImage.name" />
      </section>
    </div>
    <p
      v-if="disabledMessage || promptMediaHint"
      id="prompt-capability-message"
      class="capability-message"
      role="status"
    >
      {{ disabledMessage || promptMediaHint }}
    </p>
    <TaskTakeoverConfirmDialog
      v-if="pendingTakeover"
      :busy="takeoverConfirmBusy"
      :error="takeoverConfirmError"
      @confirm="confirmTakeover"
      @cancel="cancelTakeoverConfirm"
    />
  </footer>
</template>

<style scoped>
.composer {
  container-type: inline-size;
}

/* 上下文用量按钮容器：圆形微交互与平滑过渡 */
.composer-usage {
  position: relative;
  display: inline-grid;
  width: 28px;
  min-width: 28px;
  height: 28px;
  min-height: 28px;
  max-width: none;
  place-items: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 50%;
  color: var(--text-3);
  background: transparent;
  cursor: help;
  transition: all 0.15s ease;
}

.composer-usage:hover,
.composer-usage:focus-visible,
.composer-usage[aria-expanded='true'] {
  border-color: color-mix(in srgb, var(--border-strong) 65%, transparent);
  color: var(--text-1);
  background: color-mix(in srgb, var(--surface-3) 60%, transparent);
  outline: none;
}

.composer-usage:focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 34%, transparent);
}

/* 纯净环形进度指示器：中心无数字，线条纤细精致 */
.composer-usage-ring {
  position: relative;
  display: grid;
  width: 20px;
  height: 20px;
  place-items: center;
}

.composer-usage-ring svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  transform: rotate(-90deg);
}

.composer-usage-ring circle {
  fill: none;
  stroke-width: 3.2;
}

.composer-usage-ring-track {
  stroke: color-mix(in srgb, var(--border-strong) 75%, transparent);
}

.composer-usage-ring-value {
  stroke: var(--accent);
  stroke-linecap: round;
  transition: stroke-dasharray 0.2s ease;
}

.composer-usage-ring.is-unknown .composer-usage-ring-value {
  stroke: var(--text-3);
  stroke-dasharray: 5 7;
}

/* 悬浮用量详情卡片：对照图3圆润精致卡片设计 */
.composer-usage-details {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 175px;
  padding: 12px 18px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-soft);
  color: var(--text-2);
  text-align: center;
  background: var(--surface-overlay);
  box-shadow:
    0 10px 30px -4px rgba(0, 0, 0, 0.35),
    0 4px 12px rgba(0, 0, 0, 0.15);
  white-space: nowrap;
  pointer-events: none;
  user-select: none;
}

/* 浅色主题卡片表面与阴影微调 */
:global(html[data-theme='light']) .composer-usage-details {
  background: #ffffff;
  border-color: rgba(0, 0, 0, 0.08);
  box-shadow:
    0 8px 24px -4px rgba(0, 0, 0, 0.12),
    0 2px 8px rgba(0, 0, 0, 0.06);
}

/* 卡片顶部标题：如「背景信息窗口：」 */
.composer-usage-card-title {
  font-size: var(--text-xs);
  color: var(--text-2);
  line-height: 1.3;
  margin-bottom: 3px;
  opacity: 0.9;
}

/* 卡片主数据行：如「14% 已用（剩余 86%）」 */
.composer-usage-card-headline {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--text-1);
  line-height: 1.35;
  margin-bottom: 3px;
  letter-spacing: -0.01em;
}

/* 卡片副数据行：如「已用 35k 标记，共 258k」 */
.composer-usage-card-subline {
  font-size: var(--text-sm);
  color: var(--text-2);
  line-height: 1.3;
}

@media (prefers-reduced-motion: reduce) {
  .composer-usage-ring-value {
    transition: none;
  }
}
</style>
