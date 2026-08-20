<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { PhPaperPlaneTilt as PaperPlaneTilt, PhStop as Stop } from '@phosphor-icons/vue'
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
import ModelSelector from './ModelSelector.vue'
import SlashCommandPalette from './SlashCommandPalette.vue'

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
  /** 上下文 used/limit；没数据时不传或传空，模板藏起来。 */
  contextUsage?: string | null
  runtimeCommands?: AgentAvailableCommand[]
}>()

const emit = defineEmits<{
  'update:prompt': [value: string]
  send: []
  stop: []
  modelChanged: [summary: ProviderConfigSummary]
  modelError: [message: string]
  'open-plugins': []
  'open-settings': []
  'open-settings-memory': []
  'open-settings-mcp': []
  'open-settings-grok-config': []
}>()

const textarea = ref<HTMLTextAreaElement | null>(null)
const stopButton = ref<HTMLButtonElement | null>(null)
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
  else if (action === 'open-settings-memory') emit('open-settings-memory')
  else if (action === 'open-settings-mcp') emit('open-settings-mcp')
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
    <div class="composer">
      <SlashCommandPalette
        v-if="showPalette"
        :items="filteredCommands"
        :active-index="activeIndex"
        :waiting="waitingRuntimeCommands"
        @select="submitPaletteItem"
      />
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
        <button
          v-else
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
      </div>
    </div>
    <p
      v-if="disabledMessage"
      id="prompt-capability-message"
      class="capability-message"
      role="status"
    >
      {{ disabledMessage }}
    </p>
  </footer>
</template>
