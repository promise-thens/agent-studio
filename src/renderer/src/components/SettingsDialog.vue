<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import {
  PhBrain as Brain,
  PhCode as Code,
  PhPalette as Palette,
  PhPlugs as Plugs,
  PhPlugsConnected as PlugsConnected,
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
import GrokConfigEditor from './GrokConfigEditor.vue'
import MemorySettingsPanel from './MemorySettingsPanel.vue'
import McpSettingsPanel from './McpSettingsPanel.vue'
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
  projectId?: string
}>()

const emit = defineEmits<{
  close: []
  'update:section': [SettingsSection]
  changeAppearance: [AppAppearanceMode]
  saved: [summary: ProviderConfigSummary]
  'start-turn': [command: string]
}>()

const closeButton = ref<HTMLButtonElement | null>(null)
const paneDirty = ref(false)

function requestClose(): void {
  if (paneDirty.value && !window.confirm('有未保存的更改，确定关闭设置？')) return
  emit('close')
}

function requestSection(id: SettingsSection): void {
  if (id === props.section) return
  if (paneDirty.value && !window.confirm('有未保存的更改，确定离开当前页？')) return
  paneDirty.value = false
  emit('update:section', id)
}

onMounted(() => {
  void nextTick(() => closeButton.value?.focus())
})

function sectionIcon(id: SettingsSection): typeof Palette {
  if (id === 'appearance') return Palette
  if (id === 'memory') return Brain
  if (id === 'mcp') return Plugs
  if (id === 'grok-config') return Code
  return PlugsConnected
}
</script>

<template>
  <div class="modal-backdrop settings-backdrop" @click.self="requestClose">
    <section
      class="settings-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-dialog-title"
      @keydown.esc.stop="requestClose"
    >
      <header class="settings-dialog-header">
        <h2 id="settings-dialog-title">设置</h2>
        <button
          ref="closeButton"
          class="icon-button"
          type="button"
          title="关闭设置"
          aria-label="关闭设置"
          @click="requestClose"
        >
          <X :size="16" />
        </button>
      </header>

      <div class="settings-dialog-body">
        <nav class="settings-nav" aria-label="设置栏目">
          <button
            v-for="item in SETTINGS_SECTIONS"
            :key="item.id"
            class="settings-nav-item"
            type="button"
            :class="{ current: section === item.id }"
            :aria-current="section === item.id ? 'page' : undefined"
            @click="requestSection(item.id)"
          >
            <component :is="sectionIcon(item.id)" :size="15" />
            <span>{{ item.label }}</span>
          </button>
        </nav>

        <div class="settings-pane">
          <div v-if="section === 'provider'" class="provider-pane">
            <h3>供应商</h3>
            <p>填写兼容 OpenAI Chat Completions 的服务信息。保存后的 Key 只显示“已保存”。</p>
            <ProviderOnboarding
              layout="embedded"
              :initial-summary="props.initialSummary"
              :list-models="props.listModels"
              :save-provider="props.saveProvider"
              :clear-provider="props.clearProvider"
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
                @click="emit('changeAppearance', option.mode)"
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
            @dirty="paneDirty = $event"
            @start-turn="emit('start-turn', $event)"
          />
          <McpSettingsPanel v-else-if="section === 'mcp'" :project-id="projectId" />
          <GrokConfigEditor v-else-if="section === 'grok-config'" @dirty="paneDirty = $event" />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-backdrop {
  z-index: 24;
}

.settings-dialog {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  width: min(860px, calc(100vw - 48px));
  height: min(640px, calc(100vh - 48px));
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-panel);
  background: var(--surface-1);
  box-shadow: 0 28px 80px rgb(0 0 0 / 40%);
}

.settings-dialog-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 12px 20px;
  border-bottom: 1px solid var(--border);
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
  background: #f7f7f8;
}

.appearance-swatch[data-mode='system'] {
  background: linear-gradient(90deg, #0d1117 50%, #f7f7f8 50%);
}
</style>
