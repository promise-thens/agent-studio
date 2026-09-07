<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { matchGrokConfigHint, type GrokConfigHint } from '../../../shared/grok-config-hints'
import { useGrokSandboxSettings } from '../composables/useGrokSandboxSettings'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'
import { parseTomlCursor } from '../grok-config-cursor'
import {
  GROK_SANDBOX_DIRTY_TITLE,
  GROK_SANDBOX_INTRO,
  GROK_SANDBOX_OPTIONS,
  GROK_SANDBOX_SAVING_TITLE,
  GROK_SANDBOX_TITLE,
  resolveSandboxPickerTitle,
  resolveSandboxSelectValue
} from '../grok-sandbox-settings'

const props = withDefaults(
  defineProps<{
    runtimeBusy?: boolean
  }>(),
  { runtimeBusy: false }
)

const emit = defineEmits<{
  dirty: [value: boolean]
}>()

const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const errorMessage = ref('')
const text = ref('')
const savedText = ref('')
const saving = ref(false)
const saveMessage = ref('')
const parseError = ref('')
const cursorOffset = ref(0)
const textarea = ref<HTMLTextAreaElement | null>(null)
const sandbox = useGrokSandboxSettings()

const dirty = computed(() => text.value !== savedText.value)
const sandboxDisabled = computed(
  () => dirty.value || props.runtimeBusy || sandbox.saving.value || saving.value
)
const sandboxSelectTitle = computed(() =>
  dirty.value
    ? GROK_SANDBOX_DIRTY_TITLE
    : resolveSandboxPickerTitle({
        dirty: false,
        runtimeBusy: props.runtimeBusy,
        saving: sandbox.saving.value
      })
)
const selectedSandboxCopy = computed(
  () => GROK_SANDBOX_OPTIONS.find((option) => option.profile === sandbox.confirmed.value) ?? null
)
const sandboxDescribedBy = computed(() => {
  const ids = ['grok-sandbox-intro']
  if (selectedSandboxCopy.value) ids.push('grok-sandbox-help')
  if (sandbox.errorMessage.value) ids.push('grok-sandbox-error')
  return ids.join(' ')
})
const cursorHint = computed((): GrokConfigHint | null => {
  const cursor = parseTomlCursor(text.value, cursorOffset.value)
  return matchGrokConfigHint(cursor.table, cursor.key)
})
const unknownHint = computed(() => {
  const cursor = parseTomlCursor(text.value, cursorOffset.value)
  if (!cursor.table && !cursor.key) return null
  if (cursorHint.value) return null
  return cursor
})

watch(dirty, (value) => emit('dirty', value))

async function loadConfig(): Promise<void> {
  loadState.value = 'loading'
  errorMessage.value = ''
  try {
    const document = unwrapDesktopIpcResult(await window.app.getGrokConfig())
    text.value = document.text
    savedText.value = document.text
    await sandbox.load()
    loadState.value = 'ready'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
    loadState.value = 'error'
    await sandbox.load()
  }
}

async function saveConfig(): Promise<void> {
  if (!dirty.value || saving.value || sandbox.saving.value) return
  saving.value = true
  parseError.value = ''
  saveMessage.value = ''
  try {
    unwrapDesktopIpcResult(await window.app.saveGrokConfig(text.value))
    savedText.value = text.value
    saveMessage.value = '已保存。空闲时会重载 Grok，使 context_window 等原生配置立即生效。'
    await sandbox.reloadFromSaved()
  } catch (error) {
    parseError.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}

/**
 * 选择器只发已校验四档。必须等 applyProfile 确认 applied 后才刷新 toml，避免两套真相。
 */
async function chooseSandbox(raw: string): Promise<void> {
  if (sandboxDisabled.value) return
  const profile = resolveSandboxSelectValue(raw)
  if (!profile) return
  const applied = await sandbox.applyProfile(profile)
  if (applied) await refreshTomlFromDisk()
}

/** 选择器写盘成功后用主进程文本覆盖编辑器，避免 [sandbox] profile 与档位脱节。 */
async function refreshTomlFromDisk(): Promise<void> {
  try {
    const document = unwrapDesktopIpcResult(await window.app.getGrokConfig())
    text.value = document.text
    savedText.value = document.text
  } catch (error) {
    parseError.value = error instanceof Error ? error.message : String(error)
  }
}

function onSandboxChange(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  void chooseSandbox(target.value)
}

function discardChanges(): void {
  text.value = savedText.value
  parseError.value = ''
  saveMessage.value = ''
}

function updateCursor(): void {
  const element = textarea.value
  if (!element) return
  cursorOffset.value = element.selectionStart
}

onMounted(() => {
  void loadConfig()
})
</script>

<template>
  <section class="grok-config-pane" aria-labelledby="grok-config-title">
    <header>
      <h3 id="grok-config-title">Grok 配置</h3>
      <p>
        编辑 App 专属 <code>config.toml</code>。不会改家里的
        <code>~/.grok/config.toml</code>。记忆文件经 junction 与终端共用。
      </p>
    </header>

    <div v-if="loadState === 'loading'" class="state">正在读取配置…</div>
    <div v-else-if="loadState === 'error'" class="state" role="alert">
      <p>{{ errorMessage || '读取配置失败。' }}</p>
      <button
        class="hub-secondary"
        type="button"
        title="重试读取配置"
        aria-label="重试读取配置"
        @click="loadConfig"
      >
        重试
      </button>
    </div>
    <div v-else class="config-stack">
      <fieldset class="sandbox-field" :disabled="sandboxDisabled">
        <legend id="grok-sandbox-title">{{ GROK_SANDBOX_TITLE }}</legend>
        <p id="grok-sandbox-intro">{{ GROK_SANDBOX_INTRO }}</p>
        <label class="sandbox-select-row" for="grok-sandbox-select">
          <span class="sandbox-select-label">档位</span>
          <select
            id="grok-sandbox-select"
            class="sandbox-select"
            :value="sandbox.confirmed.value ?? ''"
            :disabled="sandboxDisabled"
            :title="sandboxSelectTitle"
            :aria-label="GROK_SANDBOX_TITLE"
            :aria-describedby="sandboxDescribedBy"
            :aria-invalid="sandbox.errorMessage.value ? 'true' : undefined"
            :aria-busy="sandbox.saving.value ? 'true' : undefined"
            @change="onSandboxChange"
          >
            <option
              v-for="option in GROK_SANDBOX_OPTIONS"
              :key="option.profile"
              :value="option.profile"
            >
              {{ option.label }}
            </option>
          </select>
        </label>
        <p v-if="selectedSandboxCopy" id="grok-sandbox-help" class="sandbox-help">
          {{ selectedSandboxCopy.label }}：{{ selectedSandboxCopy.description }}
        </p>
        <p v-if="sandbox.saving.value" class="sandbox-status" role="status">
          {{ GROK_SANDBOX_SAVING_TITLE }}
        </p>
        <p
          v-else-if="sandbox.errorMessage.value"
          id="grok-sandbox-error"
          class="error"
          role="alert"
        >
          {{ sandbox.errorMessage.value }}
        </p>
        <p v-else-if="sandbox.statusMessage.value" class="success" role="status">
          {{ sandbox.statusMessage.value }}
        </p>
      </fieldset>
      <div class="config-body">
        <div class="editor-column">
          <div class="editor-frame">
            <div class="editor-bar">
              <span>config.toml</span>
              <span v-if="dirty" class="dirty-dot" title="未保存" />
              <button
                class="hub-primary"
                type="button"
                title="保存 Grok 配置"
                :disabled="
                  !dirty || saving || sandbox.saving.value || Boolean(parseError && !dirty)
                "
                @click="saveConfig"
              >
                {{ saving ? '保存中…' : '保存' }}
              </button>
              <button
                class="hub-secondary"
                type="button"
                title="放弃未保存的更改"
                :disabled="!dirty || saving || sandbox.saving.value"
                @click="discardChanges"
              >
                放弃
              </button>
            </div>
            <textarea
              ref="textarea"
              v-model="text"
              spellcheck="false"
              aria-label="Grok config.toml 编辑器"
              @click="updateCursor"
              @keyup="updateCursor"
              @select="updateCursor"
            />
          </div>
          <div v-if="parseError || saveMessage" class="config-footer">
            <p v-if="parseError" class="error" role="alert">{{ parseError }}</p>
            <p v-else class="success" role="status">{{ saveMessage }}</p>
          </div>
        </div>
        <aside class="hint-pane" aria-live="polite">
          <p class="hint-kicker">当前字段</p>
          <template v-if="cursorHint">
            <h4>{{ cursorHint.title }}</h4>
            <p>{{ cursorHint.meaning }}</p>
            <p v-if="cursorHint.values"><strong>取值：</strong>{{ cursorHint.values }}</p>
            <p v-if="cursorHint.studioNote">{{ cursorHint.studioNote }}</p>
          </template>
          <template v-else-if="unknownHint">
            <h4>
              {{ unknownHint.key ? `${unknownHint.table}.${unknownHint.key}` : unknownHint.table }}
            </h4>
            <p>Grok 可能认识，桌面不解释；保存前请确认不是密钥。</p>
          </template>
          <p v-else>把光标放到某个键或表上，这里会显示中文说明。</p>
        </aside>
      </div>
    </div>
  </section>
</template>

<style scoped>
.grok-config-pane {
  display: grid;
  gap: 12px;
  min-height: 0;
  height: 100%;
  overflow: auto;
  grid-template-rows: auto minmax(0, 1fr);
}

header h3,
header p {
  margin: 0;
}

header h3 {
  font-size: 16px;
}

header p,
.state,
.hint-pane {
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.55;
}

.config-stack {
  display: grid;
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 12px;
}

.sandbox-field {
  display: grid;
  gap: 10px;
  min-width: 0;
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--app-bg);
}

.sandbox-field legend {
  padding: 0 4px;
  color: var(--text-1);
  font-size: 14px;
  font-weight: 650;
}

.sandbox-field > p {
  margin: 0;
}

.sandbox-select-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.sandbox-select-label {
  color: var(--text-3);
  font-size: 12px;
}

.sandbox-select {
  min-width: 0;
  flex: 1 1 12rem;
  max-width: 16rem;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  color: var(--text-1);
  background: var(--surface-2);
}

.sandbox-select:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.sandbox-select:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 76%, white);
  outline-offset: 2px;
}

.sandbox-help,
.sandbox-status {
  margin: 0;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.45;
}

.config-body {
  display: grid;
  min-height: 12rem;
  overflow: hidden;
  grid-template-columns: minmax(0, 1fr) 228px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--app-bg);
}

@media (prefers-reduced-motion: reduce) {
  .sandbox-select {
    transition: none;
  }
}

.editor-column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.editor-frame {
  display: grid;
  min-width: 0;
  min-height: 0;
  flex: 1 1 0;
  overflow: hidden;
  grid-template-rows: auto minmax(0, 1fr);
}

.editor-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text-3);
  font-size: 12px;
}

.editor-bar span:first-child {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dirty-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
}

textarea {
  width: 100%;
  min-width: 0;
  min-height: 0;
  height: 100%;
  padding: 12px;
  border: 0;
  color: var(--text-1);
  background: transparent;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow: auto;
  resize: none;
}

.hint-pane {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 14px;
  border-left: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface-1) 88%, var(--app-bg));
}

.hint-kicker {
  margin: 0 0 8px;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.04em;
}

.hint-pane h4,
.hint-pane p {
  margin: 0 0 8px;
  overflow-wrap: anywhere;
}

.hint-pane h4 {
  color: var(--text-1);
  font-size: 13px;
  line-height: 1.4;
}

/* 保存反馈固定在编辑区下方，避免长 TOML 把提示挤出圆角卡片。 */
.config-footer {
  flex: 0 0 auto;
  display: grid;
  gap: 6px;
  min-height: 0;
  padding: 8px 12px;
  overflow-wrap: anywhere;
}

.error {
  margin: 0;
  color: var(--danger);
  font-size: 12px;
}

.success {
  margin: 0;
  color: var(--success);
  font-size: 12px;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
