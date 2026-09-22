<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  PhBrain as Brain,
  PhCode as Code,
  PhGlobe as Globe,
  PhPalette as Palette,
  PhPlugsConnected as PlugsConnected,
  PhWebhooksLogo as WebhooksLogo,
  PhX as X
} from '@phosphor-icons/vue'
import type { AppAppearanceMode, AppAppearanceState } from '../../../shared/app-appearance'
import type {
  ProviderConfigInput,
  ProviderConfigSummary,
  ProviderConnectionInput,
  ProviderTestResult
} from '../../../shared/provider'
import { APPEARANCE_OPTIONS, SETTINGS_SECTIONS, type SettingsSection } from '../settings-dialog'
import {
  canLeaveSettingsPane,
  mountSettingsFocus,
  settingsPaneFeedback,
  type SettingsPaneState
} from '../settings-dialog-interaction'
import GrokConfigEditor from './GrokConfigEditor.vue'
import GrokHooksPanel from './GrokHooksPanel.vue'
import HostBrowserSettingsPanel from './HostBrowserSettingsPanel.vue'
import MemorySettingsPanel from './MemorySettingsPanel.vue'
import ProviderOnboarding from './ProviderOnboarding.vue'

const props = defineProps<{
  section: SettingsSection
  appearance: AppAppearanceState
  appearancePending?: boolean
  initialSummary?: ProviderConfigSummary | null
  listModels: (input: ProviderConnectionInput) => Promise<ProviderTestResult>
  saveProvider: (input: ProviderConfigInput) => Promise<ProviderConfigSummary>
  clearProvider?: () => Promise<void>
  selectedTaskId?: string
  grokActionsAvailable?: boolean
  projectHint?: string
  runtimeBusy?: boolean
}>()

const emit = defineEmits<{
  close: []
  'update:section': [SettingsSection]
  changeAppearance: [AppAppearanceMode]
  saved: [summary: ProviderConfigSummary]
  'start-turn': [command: string]
}>()

const dialog = ref<HTMLElement | null>(null)
const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
const paneState = ref<SettingsPaneState>({ dirty: false, saving: false, error: '' })
const requestedAppearance = ref<AppAppearanceMode | null>(null)
const appearanceFeedback = ref('更改后自动保存，无需额外点击保存。')
const busy = computed(() => paneState.value.saving || Boolean(props.appearancePending))
const feedback = computed(() =>
  props.section === 'appearance'
    ? props.appearancePending ? '正在保存外观…' : appearanceFeedback.value
    : settingsPaneFeedback(paneState.value)
)
let releaseFocus: (() => void) | undefined

/** 关闭按钮、遮罩和 Esc 共用同一离开检查，保存中不能销毁子页。 */
function requestClose(): void {
  if (busy.value || !canLeaveSettingsPane(paneState.value, () => window.confirm('有未保存的更改，确定丢弃并关闭设置？'))) return
  emit('close')
}

/** 切页只在用户确认丢弃后重置摘要，取消时继续保留原组件和草稿。 */
function requestSection(id: SettingsSection): void {
  if (id === props.section) return
  if (busy.value || !canLeaveSettingsPane(paneState.value, () => window.confirm('有未保存的更改，确定丢弃并离开当前页？'))) return
  paneState.value = { dirty: false, saving: false, error: '' }
  emit('update:section', id)
}

/** 原生 select 在取消离开时必须恢复旧值，不能视觉上先切页。 */
function selectSection(event: Event): void {
  const select = event.target as HTMLSelectElement
  const target = select.value as SettingsSection
  select.value = props.section
  requestSection(target)
}

/** 记忆快捷动作会由 App 关闭设置，同样必须先处理未保存草稿。 */
function requestStartTurn(command: string): void {
  if (busy.value || !canLeaveSettingsPane(paneState.value, () => window.confirm('有未保存的更改，确定丢弃并返回对话？'))) return
  emit('start-turn', command)
}

/** 外观仍通过原有事件保存，只从确认后的 props 推断结果，不做乐观选中。 */
function requestAppearance(mode: AppAppearanceMode): void {
  if (props.appearancePending || mode === props.appearance.mode) return
  requestedAppearance.value = mode
  emit('changeAppearance', mode)
}

watch(() => props.appearancePending, (pending, previous) => {
  if (pending || !previous || !requestedAppearance.value) return
  appearanceFeedback.value = props.appearance.mode === requestedAppearance.value
    ? '外观已保存并生效。'
    : '外观保存失败，仍使用上次确认的外观，请重试。'
  requestedAppearance.value = null
})

onMounted(() => {
  void nextTick(() => {
    if (dialog.value) releaseFocus = mountSettingsFocus(dialog.value, requestClose, returnFocus)
  })
})
onUnmounted(() => releaseFocus?.())

function sectionIcon(id: SettingsSection): typeof Palette {
  if (id === 'appearance') return Palette
  if (id === 'memory') return Brain
  if (id === 'grok-config') return Code
  if (id === 'browser') return Globe
  if (id === 'hooks') return WebhooksLogo
  return PlugsConnected
}
</script>

<template>
  <div class="modal-backdrop settings-backdrop" @click.self="requestClose">
    <section
      ref="dialog"
      class="settings-dialog"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="settings-dialog-title"
    >
      <header class="settings-dialog-header">
        <h2 id="settings-dialog-title">设置</h2>
        <button
          class="icon-button"
          type="button"
          :disabled="busy"
          title="关闭设置"
          aria-label="关闭设置"
          @click="requestClose"
        >
          <X :size="16" />
        </button>
      </header>

      <div class="settings-dialog-body">
        <label class="settings-compact-nav">
          <span>设置栏目</span>
          <select :value="section" :disabled="busy" @change="selectSection">
            <option v-for="item in SETTINGS_SECTIONS" :key="item.id" :value="item.id">
              {{ item.label }}
            </option>
          </select>
        </label>
        <nav class="settings-nav" aria-label="设置栏目">
          <button
            v-for="item in SETTINGS_SECTIONS"
            :key="item.id"
            class="settings-nav-item"
            type="button"
            :disabled="busy"
            :class="{ current: section === item.id }"
            :aria-current="section === item.id ? 'page' : undefined"
            @click="requestSection(item.id)"
          >
            <component :is="sectionIcon(item.id)" :size="15" />
            <span>{{ item.label }}</span>
          </button>
        </nav>

        <div
          class="settings-pane"
        >
          <div v-if="section === 'provider'" class="provider-pane">
            <h3>供应商</h3>
            <p>填写兼容 OpenAI Chat Completions 的服务信息。保存后的 Key 只显示“已保存”。</p>
            <ProviderOnboarding
              layout="embedded"
              :initial-summary="props.initialSummary"
              :list-models="props.listModels"
              :save-provider="props.saveProvider"
              :clear-provider="props.clearProvider"
              @state="paneState = $event"
              @saved="emit('saved', $event)"
            />
          </div>

          <section
            v-else-if="section === 'appearance'"
            class="appearance-pane"
            aria-labelledby="appearance-title"
          >
            <h3 id="appearance-title">外观</h3>
            <p>选择工作台颜色。跟随系统时，系统浅色用米白，系统深色用现有深色。</p>
            <div class="appearance-options" role="radiogroup" aria-labelledby="appearance-title">
              <button
                v-for="option in APPEARANCE_OPTIONS"
                :key="option.mode"
                class="appearance-option"
                type="button"
                role="radio"
                :aria-checked="appearance.mode === option.mode"
                :aria-label="option.label"
                :disabled="appearancePending"
                :class="{ selected: appearance.mode === option.mode }"
                @click="requestAppearance(option.mode)"
              >
                <span class="appearance-swatch" :data-mode="option.mode" aria-hidden="true" />
                <span class="appearance-copy">
                  <strong>{{ option.label }}</strong>
                  <small>{{ option.description }}</small>
                </span>
              </button>
            </div>
          </section>

          <MemorySettingsPanel
            v-else-if="section === 'memory'"
            :selected-task-id="selectedTaskId"
            :grok-actions-available="grokActionsAvailable"
            :project-hint="projectHint"
            @state="paneState = $event"
            @start-turn="requestStartTurn"
          />
          <GrokConfigEditor
            v-else-if="section === 'grok-config'"
            :runtime-busy="runtimeBusy"
            @state="paneState = $event"
          />
          <HostBrowserSettingsPanel
            v-else-if="section === 'browser'"
            :runtime-busy="runtimeBusy"
            @state="paneState = $event"
          />
          <GrokHooksPanel v-else-if="section === 'hooks'" @state="paneState = $event" />
        </div>
      </div>
      <footer class="settings-status" role="status" aria-live="polite">{{ feedback }}</footer>
    </section>
  </div>
</template>

<style scoped>
.settings-backdrop {
  z-index: 24;
  /* 模态遮罩禁止原生窗口拖拽捕获，确保点击事件顺畅直达渲染层 */
  -webkit-app-region: no-drag;
}

.settings-dialog {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: min(1080px, calc(100vw - 48px));
  height: min(760px, calc(100dvh - 48px));
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-panel);
  background: var(--surface-1);
  box-shadow: 0 28px 80px rgb(0 0 0 / 40%);
  /* 弹窗主体确保不可拖拽 */
  -webkit-app-region: no-drag;
}

.settings-dialog-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 12px 20px;
  border-bottom: 1px solid var(--border);
  /* 弹窗顶栏及其关闭按钮彻底脱离原生拖动捕获，确保右上角关闭按钮点击灵敏 */
  -webkit-app-region: no-drag;
}

.settings-dialog-header .icon-button {
  -webkit-app-region: no-drag;
  cursor: pointer;
}

.settings-dialog-header h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}

.settings-dialog-body {
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr);
  min-height: 0;
}

.settings-nav {
  display: grid;
  align-content: start;
  gap: 4px;
  padding: 12px;
  border-right: 1px solid var(--border);
  background: var(--app-bg);
  overflow-y: auto;
}

.settings-nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--radius-control);
  color: var(--text-2);
  background: transparent;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.settings-nav-item.current {
  color: var(--text-1);
  background: color-mix(in srgb, var(--text-1) 8%, transparent);
}

.settings-nav-item:hover {
  color: var(--text-1);
  background: color-mix(in srgb, var(--text-1) 6%, transparent);
}

.settings-pane {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 20px 22px 24px;
  container-type: inline-size;
  container-name: settings-content;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

/* 页面由壳层负责纵向滚动，状态栏占独立行，不覆盖最后一个字段。 */
.settings-status {
  padding: 10px 20px;
  border-top: 1px solid var(--border);
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.settings-compact-nav {
  display: none;
}

.settings-dialog :deep(:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.settings-dialog :deep(h3) {
  font-size: 16px;
  line-height: 1.5;
}

@media (max-width: 980px), (max-height: 560px) {
  .settings-dialog {
    width: calc(100vw - 24px);
    height: calc(100dvh - 24px);
  }

  .settings-dialog-body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }

  .settings-nav {
    display: none;
  }

  .settings-compact-nav {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }

  .settings-compact-nav select {
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    color: var(--text-1);
    background: var(--surface-2);
    font: inherit;
  }

  .settings-pane {
    padding: 16px;
  }
}

.provider-pane,
.appearance-pane {
  display: grid;
  gap: 14px;
  align-content: start;
}

.provider-pane h3,
.appearance-pane h3,
.provider-pane p,
.appearance-pane p {
  margin: 0;
}

.provider-pane h3,
.appearance-pane h3 {
  font-size: 16px;
}

.provider-pane p,
.appearance-pane p {
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.55;
}

.appearance-options {
  display: grid;
  gap: 10px;
}

.appearance-option {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  color: inherit;
  background: var(--surface-2);
  text-align: left;
  cursor: pointer;
}

.appearance-option.selected {
  border-color: color-mix(in srgb, var(--accent) 70%, var(--border));
  background: color-mix(in srgb, var(--accent) 10%, var(--surface-2));
}

.appearance-option:disabled {
  cursor: wait;
  opacity: 0.7;
}

.appearance-copy {
  display: grid;
  gap: 4px;
}

.appearance-copy strong {
  font-size: 13px;
}

.appearance-copy small {
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.45;
}

.appearance-swatch {
  width: 44px;
  height: 32px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
}

.appearance-swatch[data-mode='dark'] {
  background: #0d1117;
}

.appearance-swatch[data-mode='light'] {
  background: #f5f6f8;
}

.appearance-swatch[data-mode='system'] {
  background: linear-gradient(90deg, #0d1117 50%, #f5f6f8 50%);
}
</style>
