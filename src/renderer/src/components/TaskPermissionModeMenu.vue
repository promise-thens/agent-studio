<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import {
  PhCaretDown as CaretDown,
  PhCheck as Check,
  PhHand as Hand,
  PhShieldCheck as ShieldCheck,
  PhWarning as Warning
} from '@phosphor-icons/vue'
import {
  shouldResubmitPermissionMode,
  TASK_PERMISSION_MODE_COPY,
  TASK_PERMISSION_MODES,
  type TaskPermissionMode
} from '../../../shared/task-takeover'

const props = withDefaults(
  defineProps<{
    mode: TaskPermissionMode
    busy?: boolean
    disabled?: boolean
    takeoverApplied?: boolean
    takeoverMayStillBeActive?: boolean
  }>(),
  { busy: false, disabled: false }
)

const emit = defineEmits<{
  select: [mode: TaskPermissionMode]
}>()

const id = useId()
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const isOpen = ref(false)
const activeIndex = ref(0)
const selecting = ref(false)

const isDisabled = computed(() => props.busy || props.disabled || selecting.value)
const currentCopy = computed(() => TASK_PERMISSION_MODE_COPY[props.mode])
const triggerTitle = computed(() => {
  if (props.busy) return '任务执行中，暂时不能切换批准模式'
  if (props.disabled) return '当前不可切换批准模式'
  return currentCopy.value.title
})

watch(
  () => [props.busy, props.disabled],
  ([busy, disabled]) => {
    if (busy || disabled) closeMenu()
  }
)

onMounted(() => document.addEventListener('pointerdown', handleOutsideClick))
onBeforeUnmount(() => document.removeEventListener('pointerdown', handleOutsideClick))

function toggleMenu(): void {
  if (isDisabled.value) return
  if (isOpen.value) return closeMenu()
  void openMenu()
}

async function openMenu(edge?: 'first' | 'last'): Promise<void> {
  if (isDisabled.value) return
  isOpen.value = true
  const selectedIndex = TASK_PERMISSION_MODES.indexOf(props.mode)
  activeIndex.value =
    edge === 'first'
      ? 0
      : edge === 'last'
        ? TASK_PERMISSION_MODES.length - 1
        : Math.max(0, selectedIndex)
  await focusOption(activeIndex.value)
}

function closeMenu(restoreFocus = false): void {
  isOpen.value = false
  if (restoreFocus) void nextTick(() => trigger.value?.focus())
}

function chooseMode(mode: TaskPermissionMode): void {
  if (isDisabled.value) return
  if (
    !shouldResubmitPermissionMode({
      current: props.mode,
      next: mode,
      takeoverApplied: props.takeoverApplied === true,
      takeoverMayStillBeActive: props.takeoverMayStillBeActive
    })
  ) {
    return closeMenu(true)
  }
  selecting.value = true
  emit('select', mode)
  closeMenu(true)
  selecting.value = false
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
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    if (event.key === 'Home') activeIndex.value = 0
    else if (event.key === 'End') activeIndex.value = TASK_PERMISSION_MODES.length - 1
    else {
      const step = event.key === 'ArrowDown' ? 1 : -1
      activeIndex.value =
        (activeIndex.value + step + TASK_PERMISSION_MODES.length) % TASK_PERMISSION_MODES.length
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
</script>

<template>
  <div ref="root" class="permission-mode-menu">
    <button
      ref="trigger"
      type="button"
      class="permission-mode-trigger"
      :class="{ 'is-takeover': mode === 'takeover' }"
      :title="triggerTitle"
      :aria-label="triggerTitle"
      :disabled="isDisabled"
      :aria-expanded="isOpen"
      :aria-controls="`${id}-menu`"
      aria-haspopup="dialog"
      @click="toggleMenu"
      @keydown="handleTriggerKeydown"
    >
      <Warning v-if="mode === 'takeover'" :size="13" weight="fill" />
      <ShieldCheck v-else-if="mode === 'assist'" :size="13" weight="fill" />
      <Hand v-else :size="13" weight="fill" />
      <span>{{ mode === 'ask' ? '请求批准' : mode === 'assist' ? '帮我批准' : '完全访问' }}</span>
      <CaretDown :size="12" />
    </button>

    <section
      v-if="isOpen"
      :id="`${id}-menu`"
      ref="menu"
      class="permission-mode-panel"
      role="dialog"
      aria-label="应如何批准操作？"
      @keydown="handleMenuKeydown"
    >
      <header>
        <strong>应如何批准操作？</strong>
      </header>
      <div class="permission-mode-options" role="listbox" aria-label="批准模式">
        <button
          v-for="(option, index) in TASK_PERMISSION_MODES"
          :key="option"
          type="button"
          role="option"
          :class="{ 'is-takeover': option === 'takeover' }"
          :aria-selected="option === mode"
          :title="TASK_PERMISSION_MODE_COPY[option].title"
          @focus="activeIndex = index"
          @click="chooseMode(option)"
        >
          <span>
            <strong>{{
              option === 'ask' ? '请求批准' : option === 'assist' ? '帮我批准' : '完全访问'
            }}</strong>
            <small>{{
              option === 'ask'
                ? '编辑外部文件、出网和危险命令始终询问'
                : option === 'assist'
                  ? '仅对检测到的风险操作请求批准'
                  : '可不受限制地访问互联网和电脑上的文件'
            }}</small>
          </span>
          <Check v-if="option === mode" :size="14" weight="bold" />
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.permission-mode-menu {
  position: relative;
  flex: 0 0 auto;
  min-width: 0;
}

.permission-mode-trigger {
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

.permission-mode-trigger.is-takeover {
  color: var(--danger);
}

.permission-mode-trigger:hover:not(:disabled),
.permission-mode-trigger[aria-expanded='true'] {
  border-color: var(--border);
  color: var(--text-2);
  background: var(--surface-2);
}

.permission-mode-trigger.is-takeover:hover:not(:disabled),
.permission-mode-trigger.is-takeover[aria-expanded='true'] {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 42%, var(--border));
  background: color-mix(in srgb, var(--danger) 10%, transparent);
}

.permission-mode-trigger > span {
  overflow: hidden;
  min-width: 0;
  font-size: 9px;
  font-weight: 620;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.permission-mode-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.permission-mode-panel {
  position: absolute;
  bottom: calc(100% + 7px);
  left: 0;
  z-index: 12;
  width: min(330px, calc(100vw - 42px));
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-soft);
  color: var(--text-1);
  background: var(--surface-2);
  box-shadow: 0 18px 48px rgb(2 5 9 / 46%);
}

.permission-mode-panel > header {
  display: flex;
  align-items: center;
  min-height: 34px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  font-size: 9px;
}

.permission-mode-options {
  padding: 5px;
}

.permission-mode-options > button {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 16px;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  padding: 7px 8px;
  border: 0;
  border-radius: 10px;
  color: var(--text-2);
  text-align: left;
  background: transparent;
  cursor: pointer;
}

.permission-mode-options > button:hover,
.permission-mode-options > button:focus-visible {
  color: var(--text-1);
  background: var(--surface-3);
}

.permission-mode-options > button[aria-selected='true'] {
  color: var(--text-1);
  background: color-mix(in srgb, var(--accent) 9%, var(--surface-3));
}

.permission-mode-options > button.is-takeover {
  color: var(--danger);
}

.permission-mode-options > button.is-takeover[aria-selected='true'] {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, var(--surface-3));
}

.permission-mode-options strong,
.permission-mode-options small {
  display: block;
  overflow: hidden;
  min-width: 0;
}

.permission-mode-options strong {
  font-size: 10px;
  font-weight: 620;
}

.permission-mode-options small {
  margin-top: 3px;
  color: var(--text-3);
  font-size: 8px;
  line-height: 1.4;
  white-space: normal;
}

.permission-mode-options > button.is-takeover small {
  color: color-mix(in srgb, var(--danger) 72%, var(--text-3));
}

.permission-mode-options svg {
  color: var(--accent);
}

.permission-mode-options > button.is-takeover svg {
  color: var(--danger);
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
