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
      <button type="button" title="重试读取配置" aria-label="重试读取配置" @click="loadConfig">
        重试
      </button>
    </div>
    <div v-else class="editor-layout">
      <label class="editor-label">
        <span class="sr-only">Grok config.toml</span>
        <textarea
          ref="textarea"
          v-model="text"
          spellcheck="false"
          aria-label="Grok config.toml 编辑器"
          @click="updateCursor"
          @keyup="updateCursor"
          @select="updateCursor"
        />
      </label>
      <aside class="hint-pane" aria-live="polite">
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

    <p v-if="parseError" class="error" role="alert">{{ parseError }}</p>
    <p v-else-if="saveMessage" class="success" role="status">{{ saveMessage }}</p>
    <div v-if="loadState === 'ready'" class="actions">
      <button
        type="button"
        title="保存 Grok 配置"
        :disabled="!dirty || saving || Boolean(parseError && !dirty)"
        @click="saveConfig"
      >
        {{ saving ? '保存中…' : '保存' }}
      </button>
      <button
        type="button"
        title="放弃未保存的更改"
        :disabled="!dirty || saving"
        @click="discardChanges"
      >
        放弃
      </button>
    </div>
  </section>
</template>

<style scoped>
.grok-config-pane {
  display: grid;
  gap: 12px;
  min-height: 0;
  height: 100%;
  grid-template-rows: auto minmax(0, 1fr) auto auto;
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
.hint-pane,
.actions {
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.55;
}

.editor-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 220px;
  min-height: 0;
  gap: 12px;
}

.editor-label,
textarea {
  min-height: 0;
  height: 100%;
}

textarea {
  width: 100%;
  min-height: 280px;
  padding: 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  color: var(--text-1);
  background: var(--surface-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  resize: none;
}

.hint-pane {
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface-2);
}

.hint-pane h4,
.hint-pane p {
  margin: 0 0 8px;
}

.hint-pane h4 {
  color: var(--text-1);
  font-size: 13px;
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

.actions {
  display: flex;
  gap: 8px;
}

.actions button {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  color: var(--text-1);
  background: var(--surface-2);
  cursor: pointer;
}

.actions button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}
</style>
