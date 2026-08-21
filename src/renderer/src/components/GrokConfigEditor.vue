<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { matchGrokConfigHint, type GrokConfigHint } from '../../../shared/grok-config-hints'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'
import { parseTomlCursor } from '../grok-config-cursor'

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

const dirty = computed(() => text.value !== savedText.value)
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
    loadState.value = 'ready'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
    loadState.value = 'error'
  }
}

async function saveConfig(): Promise<void> {
  if (!dirty.value || saving.value) return
  saving.value = true
  parseError.value = ''
  saveMessage.value = ''
  try {
    unwrapDesktopIpcResult(await window.app.saveGrokConfig(text.value))
    savedText.value = text.value
    saveMessage.value = '已写入 Grok 配置，新对话或重新进入后生效。'
  } catch (error) {
    parseError.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
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
    <div v-else class="config-body">
      <div class="editor-column">
        <div class="editor-frame">
          <div class="editor-bar">
            <span>config.toml</span>
            <span v-if="dirty" class="dirty-dot" title="未保存" />
            <button
              class="hub-primary"
              type="button"
              title="保存 Grok 配置"
              :disabled="!dirty || saving || Boolean(parseError && !dirty)"
              @click="saveConfig"
            >
              {{ saving ? '保存中…' : '保存' }}
            </button>
            <button
              class="hub-secondary"
              type="button"
              title="放弃未保存的更改"
              :disabled="!dirty || saving"
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
  </section>
</template>

<style scoped>
.grok-config-pane {
  display: grid;
  gap: 12px;
  min-height: 0;
  height: 100%;
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

.config-body {
  display: grid;
  min-height: 0;
  overflow: hidden;
  grid-template-columns: minmax(0, 1fr) 228px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--app-bg);
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
