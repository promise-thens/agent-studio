<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import {
  PhCaretDown as CaretDown,
  PhCheck as Check,
  PhCircleNotch as CircleNotch,
  PhWarningCircle as WarningCircle
} from '@phosphor-icons/vue'
import {
  toSerializableProviderModel,
  type ProviderConfigSummary,
  type ProviderModelOption,
  type ProviderTestResult
} from '../../../shared/provider'

interface Props {
  model: ProviderModelOption | null
  loadModels: () => Promise<ProviderTestResult>
  selectModel: (model: ProviderModelOption) => Promise<ProviderConfigSummary>
  busy?: boolean
  disabled?: boolean
}

const props = withDefaults(defineProps<Props>(), { busy: false, disabled: false })
const emit = defineEmits<{
  changed: [summary: ProviderConfigSummary]
  error: [message: string]
}>()

const id = useId()
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const models = ref<ProviderModelOption[]>([])
const isOpen = ref(false)
const isLoading = ref(false)
const selectingId = ref<string | null>(null)
const activeIndex = ref(0)
const menuError = ref('')

const isDisabled = computed(() => props.busy || props.disabled || selectingId.value !== null)
const discoveredCurrentModel = computed(() =>
  models.value.find((model) => model.modelId === props.model?.modelId)
)
const currentLabel = computed(() => {
  const currentModel = discoveredCurrentModel.value ?? props.model
  return currentModel ? modelLabel(currentModel) : '选择模型'
})
const triggerTitle = computed(() => {
  if (props.busy) return '任务执行中，暂时不能切换模型'
  if (props.disabled) return '当前不可切换模型'
  return currentLabel.value
})

watch(
  () => [props.busy, props.disabled],
  ([busy, disabled]) => {
    if (busy || disabled) closeMenu()
  }
)

onMounted(() => document.addEventListener('pointerdown', handleOutsideClick))
onBeforeUnmount(() => document.removeEventListener('pointerdown', handleOutsideClick))

/** 模型名称必须来自 Provider，不拼接 Runtime 或 Provider 前缀。 */
function modelLabel(model: ProviderModelOption): string {
  return model.displayName?.trim() || model.modelId
}

async function toggleMenu(): Promise<void> {
  if (isDisabled.value) return
  if (isOpen.value) return closeMenu()
  await openMenu()
}

async function openMenu(edge?: 'first' | 'last'): Promise<void> {
  if (isDisabled.value) return
  isOpen.value = true
  await refreshModels()
  if (!isOpen.value || !models.value.length) return

  const selectedIndex = models.value.findIndex((option) => option.modelId === props.model?.modelId)
  activeIndex.value =
    edge === 'first' ? 0 : edge === 'last' ? models.value.length - 1 : Math.max(0, selectedIndex)
  await focusOption(activeIndex.value)
}

function closeMenu(restoreFocus = false): void {
  isOpen.value = false
  menuError.value = ''
  if (restoreFocus) void nextTick(() => trigger.value?.focus())
}

/** 每次打开重新读取真实模型列表，避免缓存过期名称。 */
async function refreshModels(): Promise<void> {
  if (isLoading.value) return
  isLoading.value = true
  menuError.value = ''

  try {
    const result = await props.loadModels()
    if (!result.ok) throw new Error(result.message || '读取模型列表失败。')

    const seen = new Set<string>()
    models.value = (result.models ?? []).filter((model) => {
      if (!model.modelId.trim() || seen.has(model.modelId)) return false
      seen.add(model.modelId)
      return true
    })
    if (!models.value.length) menuError.value = '服务没有返回可切换的模型。'
  } catch (error) {
    models.value = []
    menuError.value = errorMessage(error)
  } finally {
    isLoading.value = false
  }
}

/**
 * 等主进程确认切换成功后才通知父组件。
 * 同一 modelId 的真实名称发生变化时也重新保存，用于修正旧缓存名称。
 * 列表项来自 Vue ref，必须先摊成纯对象，否则 Electron IPC 无法 structuredClone。
 */
async function chooseModel(model: ProviderModelOption): Promise<void> {
  if (isDisabled.value) return
  const isSameModel = model.modelId === props.model?.modelId
  const hasSameDisplayName = Boolean(props.model && modelLabel(model) === modelLabel(props.model))
  if (isSameModel && hasSameDisplayName) return closeMenu(true)

  selectingId.value = model.modelId
  menuError.value = ''
  try {
    emit('changed', await props.selectModel(toSerializableProviderModel(model)))
    closeMenu(true)
  } catch (error) {
    menuError.value = errorMessage(error)
    emit('error', menuError.value)
  } finally {
    selectingId.value = null
  }
}

function handleTriggerKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    void openMenu(event.key === 'ArrowDown' ? 'first' : 'last')
  } else if (event.key === 'Escape' && isOpen.value) {
    event.preventDefault()
    closeMenu(true)
  }
}

function handleMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeMenu(true)
  } else if (event.key === 'Tab') {
    closeMenu()
  } else if (models.value.length && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    if (event.key === 'Home') activeIndex.value = 0
    else if (event.key === 'End') activeIndex.value = models.value.length - 1
    else {
      const step = event.key === 'ArrowDown' ? 1 : -1
      activeIndex.value = (activeIndex.value + step + models.value.length) % models.value.length
    }
    void focusOption(activeIndex.value)
  }
}

async function focusOption(index: number): Promise<void> {
  await nextTick()
  menu.value?.querySelectorAll<HTMLButtonElement>('[role="option"]')[index]?.focus()
}

function handleOutsideClick(event: PointerEvent): void {
  if (isOpen.value && !root.value?.contains(event.target as Node)) closeMenu()
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : '模型切换失败。'
}
</script>

<template>
  <div ref="root" class="model-selector">
    <button
      ref="trigger"
      type="button"
      class="model-trigger"
      :title="triggerTitle"
      :disabled="isDisabled"
      :aria-expanded="isOpen"
      :aria-controls="`${id}-menu`"
      aria-haspopup="dialog"
      @click="toggleMenu"
      @keydown="handleTriggerKeydown"
    >
      <CircleNotch v-if="selectingId" :size="13" class="spin" />
      <span>{{ currentLabel }}</span>
      <CaretDown :size="12" />
    </button>

    <section
      v-if="isOpen"
      :id="`${id}-menu`"
      ref="menu"
      class="model-menu"
      role="dialog"
      aria-label="选择模型"
      :aria-busy="isLoading"
      @keydown="handleMenuKeydown"
    >
      <header>
        <strong>切换模型</strong><span>{{ isLoading ? '正在读取' : models.length }}</span>
      </header>

      <div v-if="isLoading" class="menu-state" aria-live="polite">
        <CircleNotch :size="16" class="spin" />正在获取模型
      </div>
      <div v-else-if="menuError" class="menu-state error" role="alert">
        <WarningCircle :size="16" weight="fill" />
        <span>{{ menuError }}</span>
        <button type="button" @click="refreshModels">重试</button>
      </div>
      <div v-else class="model-options" role="listbox" aria-label="可用模型">
        <button
          v-for="(option, index) in models"
          :key="option.modelId"
          type="button"
          role="option"
          :aria-selected="option.modelId === model?.modelId"
          :title="modelLabel(option)"
          :disabled="Boolean(selectingId)"
          @focus="activeIndex = index"
          @click="chooseModel(option)"
        >
          <span>
            <strong>{{ modelLabel(option) }}</strong>
            <small v-if="modelLabel(option) !== option.modelId" :title="option.modelId">
              {{ option.modelId }}
            </small>
          </span>
          <CircleNotch v-if="selectingId === option.modelId" :size="14" class="spin" />
          <Check v-else-if="option.modelId === model?.modelId" :size="14" weight="bold" />
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.model-selector {
  position: relative;
  min-width: 0;
  max-width: min(44%, 300px);
}

.model-trigger {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  min-height: 25px;
  padding: 0 7px;
  border: 1px solid transparent;
  border-radius: 10px;
  color: var(--text-3);
  background: transparent;
  cursor: pointer;
}

.model-trigger:hover:not(:disabled),
.model-trigger[aria-expanded='true'] {
  border-color: var(--border);
  color: var(--text-2);
  background: var(--surface-2);
}

.model-trigger > span {
  overflow: hidden;
  min-width: 0;
  font-size: 9px;
  font-weight: 620;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.model-menu {
  position: absolute;
  bottom: calc(100% + 7px);
  left: 0;
  z-index: 12;
  width: min(330px, calc(100vw - 42px));
  max-height: min(330px, 48vh);
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-soft);
  color: var(--text-1);
  background: var(--surface-2);
  box-shadow: 0 18px 48px rgb(2 5 9 / 46%);
}

.model-menu > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 34px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  font-size: 9px;
}

.model-menu > header span {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.model-options {
  max-height: min(294px, calc(48vh - 35px));
  overflow-y: auto;
  padding: 5px;
}

.model-options > button {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 16px;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 35px;
  padding: 7px 8px;
  border: 0;
  border-radius: 10px;
  color: var(--text-2);
  text-align: left;
  background: transparent;
  cursor: pointer;
}

.model-options > button:hover:not(:disabled),
.model-options > button:focus-visible {
  color: var(--text-1);
  background: var(--surface-3);
}

.model-options > button[aria-selected='true'] {
  color: var(--text-1);
  background: color-mix(in srgb, var(--accent) 9%, var(--surface-3));
}

.model-options > button > span,
.model-options strong,
.model-options small {
  display: block;
  overflow: hidden;
  min-width: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-options strong {
  font-size: 10px;
  font-weight: 620;
}

.model-options small {
  margin-top: 3px;
  color: var(--text-3);
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 8px;
}

.model-options svg {
  color: var(--accent);
}

.menu-state {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  min-height: 68px;
  padding: 12px;
  color: var(--text-3);
  font-size: 9px;
}

.menu-state.error {
  grid-template-columns: 18px minmax(0, 1fr) auto;
  color: color-mix(in srgb, var(--danger) 84%, white);
}

.menu-state button {
  min-height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  color: var(--text-2);
  background: var(--surface-1);
  font-size: 9px;
  cursor: pointer;
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 820px) {
  .model-selector {
    max-width: min(58%, 260px);
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
  }
}
</style>
