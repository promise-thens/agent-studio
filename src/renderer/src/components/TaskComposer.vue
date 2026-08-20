<script setup lang="ts">
import { ref } from 'vue'
import { PhPaperPlaneTilt as PaperPlaneTilt, PhStop as Stop } from '@phosphor-icons/vue'
import type {
  ProviderConfigSummary,
  ProviderModelOption,
  ProviderTestResult
} from '../../../shared/provider'
import ModelSelector from './ModelSelector.vue'

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
}>()

const emit = defineEmits<{
  'update:prompt': [value: string]
  send: []
  stop: []
  modelChanged: [summary: ProviderConfigSummary]
  modelError: [message: string]
}>()

const textarea = ref<HTMLTextAreaElement | null>(null)
const stopButton = ref<HTMLButtonElement | null>(null)

/** 输入法确认候选词时保留 Enter，避免未上屏就发送。 */
function handleComposerKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
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
      <textarea
        ref="textarea"
        :value="prompt"
        :disabled="textareaDisabled"
        :aria-describedby="disabledMessage ? 'prompt-capability-message' : undefined"
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
