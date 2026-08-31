<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
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
import type { TaskPermissionMode } from '../../../shared/task-takeover'
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
  takeoverHud?: string | null
  /** 上下文 used/limit；没数据时不传或传空，模板藏起来。 */
  contextUsage?: string | null
  runtimeCommands?: AgentAvailableCommand[]
  attachments?: Array<{
    attachmentId: string
    originalName: string
    kind: TaskAttachmentKind
    previewUrl?: string
  }>
  promptMediaHint?: string | null
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
  'permission-mode-select': [mode: TaskPermissionMode]
}>()

const pendingTakeover = ref(false)

function handlePermissionModeSelect(mode: TaskPermissionMode): void {
  if (props.modelBusy || props.modelDisabled) return
  if (mode === 'takeover') {
    pendingTakeover.value = true
    return
  }
  emit('permission-mode-select', mode)
}

function confirmTakeover(): void {
  pendingTakeover.value = false
  emit('permission-mode-select', 'takeover')
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
  if (action === 'open-plugins') emit('open-plugins')
  else if (action === 'open-plugins-mcp') emit('open-plugins-mcp')
  else if (action === 'open-plugins-marketplace') emit('open-plugins-marketplace')
  else if (action === 'open-settings-memory') emit('open-settings-memory')
  else if (action === 'open-settings-grok-config') emit('open-settings-grok-config')
  else emit('open-settings')
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

function focus(): void {
  textarea.value?.focus()
}

/** Esc 工作台快捷键把焦点放到停止，而不是先关检查器。 */
function focusStop(): void {
  stopButton.value?.focus()
}

defineExpose({ focus, focusStop })
</script>

<template>
  <footer class="composer-wrap">
    <p v-if="takeoverHud" class="composer-takeover-hud" role="status">{{ takeoverHud }}</p>
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
            :mode="permissionMode ?? 'assist'"
            :busy="modelBusy"
            :disabled="modelDisabled"
            @select="handlePermissionModeSelect"
          />
          <span v-if="contextUsage" class="composer-usage" title="上下文用量">{{
            contextUsage
          }}</span>
        </div>
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
        <template v-else>
          <button
            class="attach-button"
            type="button"
            title="添加图片或文件"
            aria-label="添加图片或文件"
            :disabled="textareaDisabled"
            @click="emit('pick-attachments')"
          >
            <Paperclip :size="16" />
          </button>
          <button
            class="send-button"
            type="button"
            :disabled="!canSend"
            :title="disabledMessage || '发送'"
            :aria-label="disabledMessage || '发送'"
            :aria-describedby="disabledMessage ? 'prompt-capability-message' : undefined"
            @click="emit('send')"
          >
            <PaperPlaneTilt :size="17" weight="fill" />
          </button>
        </template>
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
      @confirm="confirmTakeover"
      @cancel="pendingTakeover = false"
    />
  </footer>
</template>
