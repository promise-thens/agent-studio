<script setup lang="ts">
/**
 * Grok 配置文件编辑器组件
 * 负责编辑应用专属 config.toml 以及选择内核级沙箱执行档位。
 */
import { computed, onMounted, ref, watch } from 'vue'
import {
  PhArrowClockwise as ArrowClockwise,
  PhArrowCounterClockwise as ArrowCounterClockwise,
  PhCaretDown as CaretDown,
  PhFileCode as FileCode,
  PhFloppyDisk as FloppyDisk,
  PhInfo as Info,
  PhShieldCheck as ShieldCheck,
  PhSparkle as Sparkle
} from '@phosphor-icons/vue'
import { matchGrokConfigHint, type GrokConfigHint } from '../../../shared/grok-config-hints'
import { useGrokSandboxSettings } from '../composables/useGrokSandboxSettings'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'
import { parseTomlCursor } from '../grok-config-cursor'
import { reportSettingsPaneState, type SettingsPaneState } from '../settings-dialog-interaction'
import {
  GROK_SANDBOX_DIRTY_TITLE,
  GROK_SANDBOX_INTRO,
  GROK_SANDBOX_OPTIONS,
  GROK_SANDBOX_SAVING_TITLE,
  GROK_SANDBOX_TITLE,
  resolveSandboxPickerTitle,
  resolveSandboxSelectValue
} from '../grok-sandbox-settings'

// 接收外部传入的运行态属性：指示 Grok Runtime 是否处于繁忙执行中
const props = withDefaults(
  defineProps<{
    runtimeBusy?: boolean
  }>(),
  { runtimeBusy: false }
)

// 向外通知配置草稿是否变脏（未保存修改）
const emit = defineEmits<{
  dirty: [value: boolean]
  state: [value: SettingsPaneState]
}>()

// 页面加载状态及错误信息
const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const errorMessage = ref('')
// TOML 配置文本草稿与磁盘持久化基线
const text = ref('')
const savedText = ref('')
const saving = ref(false)
const saveMessage = ref('')
const parseError = ref('')
// 光标偏移量与文本域引用（用于动态提取当前字段说明）
const cursorOffset = ref(0)
const textarea = ref<HTMLTextAreaElement | null>(null)
// Grok 沙箱状态组合式逻辑
const sandbox = useGrokSandboxSettings()

// 计算是否有尚未保存的更改
const dirty = computed(() => text.value !== savedText.value)
// 沙箱档位选择器禁用条件：有未保存更改、Runtime 繁忙、正在保存沙箱或正在保存 TOML
const sandboxDisabled = computed(
  () => dirty.value || props.runtimeBusy || sandbox.saving.value || saving.value
)
// 动态解析沙箱选择器的 Hover 提示文案
const sandboxSelectTitle = computed(() =>
  dirty.value
    ? GROK_SANDBOX_DIRTY_TITLE
    : resolveSandboxPickerTitle({
        dirty: false,
        runtimeBusy: props.runtimeBusy,
        saving: sandbox.saving.value
      })
)
// 当前已确认生效的沙箱配置文案信息
const selectedSandboxCopy = computed(
  () => GROK_SANDBOX_OPTIONS.find((option) => option.profile === sandbox.confirmed.value) ?? null
)
// 无障碍关联说明 ID 组合
const sandboxDescribedBy = computed(() => {
  const ids = ['grok-sandbox-intro']
  if (selectedSandboxCopy.value) ids.push('grok-sandbox-help')
  if (sandbox.errorMessage.value) ids.push('grok-sandbox-error')
  return ids.join(' ')
})
// 当前光标所在的已知 TOML 字段释义
const cursorHint = computed((): GrokConfigHint | null => {
  const cursor = parseTomlCursor(text.value, cursorOffset.value)
  return matchGrokConfigHint(cursor.table, cursor.key)
})
// 当前光标所在的未知字段信息（用于通用指引）
const unknownHint = computed(() => {
  const cursor = parseTomlCursor(text.value, cursorOffset.value)
  if (!cursor.table && !cursor.key) return null
  if (cursorHint.value) return null
  return cursor
})

// 监听脏状态并向父容器同步
watch(dirty, (value) => emit('dirty', value))
reportSettingsPaneState(
  () => ({
    dirty: dirty.value,
    saving: saving.value || sandbox.saving.value,
    error: parseError.value || errorMessage.value || sandbox.errorMessage.value,
    message: saveMessage.value || sandbox.statusMessage.value
  }),
  (state) => emit('state', state)
)
watch(text, () => { saveMessage.value = '' }, { flush: 'sync' })

/**
 * 加载并初始化 Grok 配置文件与沙箱档位
 */
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

/**
 * 保存 TOML 配置文本到本地磁盘
 * 保存成功后提示重载机制并同步重载沙箱状态
 */
async function saveConfig(): Promise<void> {
  if (!dirty.value || saving.value || sandbox.saving.value) return
  saving.value = true
  parseError.value = ''
  saveMessage.value = ''
  // 只把实际提交的文本记为基线，异步完成时不能把后续编辑误记为已保存。
  const submitted = text.value
  try {
    unwrapDesktopIpcResult(await window.app.saveGrokConfig(submitted))
    savedText.value = submitted
    saveMessage.value = '已保存。空闲时会重载 Grok，使 context_window 等原生配置立即生效。'
    await sandbox.reloadFromSaved()
  } catch (error) {
    parseError.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}

/**
 * 用户切换沙箱档位处理
 * 选择器只发已校验四档。必须等 applyProfile 确认 applied 后才刷新 toml，避免两套真相。
 */
async function chooseSandbox(raw: string): Promise<void> {
  if (sandboxDisabled.value) return
  const profile = resolveSandboxSelectValue(raw)
  if (!profile) return
  const applied = await sandbox.applyProfile(profile)
  if (applied) await refreshTomlFromDisk()
}

/**
 * 选择器写盘成功后用主进程文本覆盖编辑器，避免 [sandbox] profile 与档位脱节。
 */
async function refreshTomlFromDisk(): Promise<void> {
  try {
    const document = unwrapDesktopIpcResult(await window.app.getGrokConfig())
    text.value = document.text
    savedText.value = document.text
  } catch (error) {
    parseError.value = error instanceof Error ? error.message : String(error)
  }
}

/**
 * 原生 Select 事件变化监听
 */
function onSandboxChange(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  void chooseSandbox(target.value)
}

/**
 * 放弃所有未保存的文本编辑修改，回滚到基线状态
 */
function discardChanges(): void {
  if (saving.value || sandbox.saving.value) return
  text.value = savedText.value
  parseError.value = ''
  saveMessage.value = ''
}

/**
 * 更新当前文本框光标位置，用于右侧动态分析字段
 */
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
  <!-- Grok 配置主界面容器 -->
  <section class="grok-config-pane" aria-labelledby="grok-config-title">
    <!-- 顶部标题与元信息徽章 -->
    <header class="config-header">
      <div class="header-main">
        <div class="title-cluster">
          <FileCode :size="18" class="title-icon" />
          <h3 id="grok-config-title">Grok 配置</h3>
        </div>
        <p class="header-desc">
          编辑 App 专属 <code>config.toml</code>。不会改家里的
          <code>~/.grok/config.toml</code>。记忆文件经 junction 与终端共用。
        </p>
      </div>
      <div class="header-badges">
        <span class="meta-badge" title="应用配置与用户主目录完全隔离">
          <ShieldCheck :size="13" class="badge-icon success-icon" />
          <span>独立隔离配置</span>
        </span>
        <span class="meta-badge" title="记忆目录跨终端实时共享">
          <Sparkle :size="13" class="badge-icon accent-icon" />
          <span>Junction 同步</span>
        </span>
      </div>
    </header>

    <!-- 加载中状态展示 -->
    <div v-if="loadState === 'loading'" class="state" role="status">正在读取配置…</div>
    <!-- 加载失败错误重试提示 -->
    <div v-else-if="loadState === 'error'" class="state" role="alert">
      <p>{{ errorMessage || '读取配置失败。' }}</p>
      <button
        class="hub-secondary"
        type="button"
        title="重试读取配置"
        aria-label="重试读取配置"
        @click="loadConfig"
      >
        <ArrowClockwise :size="13" />
        <span>重试</span>
      </button>
    </div>

    <!-- 主配置工作区堆栈 -->
    <div v-else class="config-stack">
      <!-- Grok 沙箱档位控制卡片：现代受控控制台质感 -->
      <fieldset class="sandbox-field" :disabled="sandboxDisabled">
        <div class="sandbox-field-top">
          <div class="sandbox-title-wrap">
            <ShieldCheck :size="15" class="sandbox-icon" />
            <legend id="grok-sandbox-title">{{ GROK_SANDBOX_TITLE }}</legend>
          </div>
          <p id="grok-sandbox-intro" class="sandbox-intro-text">{{ GROK_SANDBOX_INTRO }}</p>
        </div>

        <div class="sandbox-action-row">
          <label class="sandbox-select-row" for="grok-sandbox-select">
            <span class="sandbox-select-label">档位</span>
            <div class="sandbox-select-wrapper">
              <!-- 原生 select 必须保留以严格满足单测契约 -->
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
              <CaretDown :size="12" class="select-arrow" aria-hidden="true" />
            </div>
          </label>

          <!-- 选中档位的高保真解释胶囊 -->
          <div v-if="selectedSandboxCopy" id="grok-sandbox-help" class="sandbox-help-pill">
            <span class="help-tag">{{ selectedSandboxCopy.label }}</span>
            <span class="help-divider">·</span>
            <span class="help-desc">{{ selectedSandboxCopy.description }}</span>
          </div>
        </div>

        <!-- 保存中与状态反馈提示 -->
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

      <!-- 双栏配置主体：左侧代码编辑器 + 右侧字段文档检查器 -->
      <div class="config-body">
        <div class="editor-column">
          <div class="editor-frame">
            <!-- 编辑器顶栏操作工具条 -->
            <div class="editor-bar">
              <div class="editor-bar-title">
                <FileCode :size="14" class="file-icon" />
                <span>config.toml</span>
                <span v-if="dirty" class="dirty-dot" title="未保存更改" />
              </div>
              <div class="editor-actions">
                <button
                  class="hub-primary"
                  type="button"
                  title="保存 Grok 配置"
                  :disabled="
                    !dirty || saving || sandbox.saving.value || Boolean(parseError && !dirty)
                  "
                  @click="saveConfig"
                >
                  <FloppyDisk :size="13" />
                  <span>{{ saving ? '保存中…' : '保存' }}</span>
                </button>
                <button
                  class="hub-secondary"
                  type="button"
                  title="放弃未保存的更改"
                  :disabled="!dirty || saving || sandbox.saving.value"
                  @click="discardChanges"
                >
                  <ArrowCounterClockwise :size="13" />
                  <span>放弃</span>
                </button>
              </div>
            </div>

            <!-- TOML 配置源码编辑文本域 -->
            <textarea
              ref="textarea"
              v-model="text"
              spellcheck="false"
              :disabled="saving || sandbox.saving.value"
              aria-label="Grok config.toml 编辑器"
              :aria-invalid="Boolean(parseError)"
              :aria-describedby="parseError ? 'grok-config-save-error' : undefined"
              @click="updateCursor"
              @keyup="updateCursor"
              @select="updateCursor"
            />
          </div>

          <!-- 保存与解析反馈栏 -->
          <div v-if="parseError || saveMessage" class="config-footer">
            <p v-if="parseError" id="grok-config-save-error" class="error" role="alert">{{ parseError }}</p>
            <p v-else class="success" role="status">{{ saveMessage }}</p>
          </div>
        </div>

        <!-- 右侧当前字段智能文档检查器 -->
        <details class="hint-pane">
          <summary class="hint-header">
            <Info :size="13" class="hint-icon" />
            <span class="hint-kicker">当前字段说明</span>
          </summary>

          <div class="hint-body" aria-live="polite">
            <!-- 识别出已知配置项的详细说明 -->
            <template v-if="cursorHint">
              <div class="hint-item">
                <h4 class="hint-field-title">{{ cursorHint.title }}</h4>
                <p class="hint-field-meaning">{{ cursorHint.meaning }}</p>
                <div v-if="cursorHint.values" class="hint-param-box">
                  <span class="param-label">取值：</span>
                  <code class="param-code">{{ cursorHint.values }}</code>
                </div>
                <div v-if="cursorHint.studioNote" class="hint-note-callout">
                  <Sparkle :size="12" class="callout-sparkle" />
                  <p class="callout-text">{{ cursorHint.studioNote }}</p>
                </div>
              </div>
            </template>

            <!-- 未知自定义字段提示 -->
            <template v-else-if="unknownHint">
              <div class="hint-item unknown-item">
                <h4 class="hint-field-title code-badge">
                  {{
                    unknownHint.key ? `${unknownHint.table}.${unknownHint.key}` : unknownHint.table
                  }}
                </h4>
                <p class="hint-field-meaning">Grok 可能认识，桌面不解释；保存前请确认不是密钥。</p>
              </div>
            </template>

            <!-- 默认未聚焦字段时的空白指引 -->
            <div v-else class="hint-empty-card">
              <p>把光标放到某个键或表上，这里会显示中文说明。</p>
            </div>
          </div>
        </details>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 整个面板主布局：撑满父容器 */
.grok-config-pane {
  display: grid;
  gap: 12px;
  min-height: 0;
  grid-template-rows: auto auto;
}

/* 顶部 Header：消除免责声明感 */
.config-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.header-main {
  display: grid;
  gap: 3px;
  min-width: 0;
  flex: 1 1 20rem;
}

.title-cluster {
  display: flex;
  align-items: center;
  gap: 7px;
}

.title-icon {
  color: var(--accent);
}

.title-cluster h3 {
  margin: 0;
  color: var(--text-1);
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.header-desc {
  margin: 0;
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.45;
}

.header-badges {
  display: flex;
  align-items: center;
  gap: 8px;
}

.meta-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-chip);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 11px;
  font-weight: 550;
  box-shadow: 0 1px 2px color-mix(in srgb, black 4%, transparent);
}

.badge-icon.success-icon {
  color: var(--success);
}

.badge-icon.accent-icon {
  color: var(--accent);
}

/* 内容堆栈 */
.config-stack {
  display: grid;
  min-height: 0;
  grid-template-rows: auto auto;
  gap: 12px;
}

/* 沙箱控制面板：现代圆润卡片 */
.sandbox-field {
  display: grid;
  gap: 10px;
  min-width: 0;
  margin: 0;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface-1);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--border-strong) 8%, transparent);
}

.sandbox-field-top {
  display: grid;
  gap: 4px;
}

.sandbox-title-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sandbox-icon {
  color: var(--accent);
}

.sandbox-field legend {
  padding: 0;
  color: var(--text-1);
  font-size: 14px;
  font-weight: 650;
}

.sandbox-intro-text {
  margin: 0;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.5;
}

.sandbox-action-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.sandbox-select-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sandbox-select-label {
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
}

/* 自定义下拉框包裹器：呈现定制圆角与箭头 */
.sandbox-select-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.sandbox-select {
  -webkit-appearance: none;
  appearance: none;
  min-width: 9rem;
  max-width: 14rem;
  padding: 5px 28px 5px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  color: var(--text-1);
  background: var(--surface-2);
  font-size: 12px;
  font-weight: 550;
  cursor: pointer;
  box-shadow: 0 1px 2px color-mix(in srgb, black 4%, transparent);
  transition:
    border-color 120ms ease,
    background 120ms ease;
}

.sandbox-select:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--surface-3);
}

.sandbox-select:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 76%, white);
  outline-offset: 2px;
}

.sandbox-select:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.select-arrow {
  position: absolute;
  right: 10px;
  pointer-events: none;
  color: var(--text-3);
}

.sandbox-help-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: var(--radius-chip);
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 12px;
  box-shadow: 0 1px 2px color-mix(in srgb, black 3%, transparent);
}

.help-tag {
  color: var(--text-1);
  font-weight: 600;
}

.help-divider {
  color: var(--text-3);
}

.help-desc {
  color: var(--text-3);
}

.sandbox-status {
  margin: 0;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.45;
}

/* 主编辑器大卡片：单测严格要求 min-height: 12rem */
.config-body {
  display: grid;
  min-height: 12rem;
  overflow: hidden;
  grid-template-columns: minmax(0, 1fr) minmax(200px, 28%);
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface-1);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--border-strong) 8%, transparent);
}

.editor-column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid var(--border);
}

.editor-frame {
  display: grid;
  min-width: 0;
  min-height: 0;
  flex: 1 0 auto;
  overflow: hidden;
  grid-template-rows: auto minmax(0, 1fr);
  background: var(--surface-2);
}

.editor-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface-2) 96%, var(--surface-1));
}

.editor-bar-title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
}

.file-icon {
  color: var(--text-3);
}

.dirty-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 70%, transparent);
}

.editor-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.editor-actions button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

/* 文本编辑器：单测严格匹配 white-space: pre-wrap 且绝不含 pre 换行 */
textarea {
  width: 100%;
  min-width: 0;
  min-height: 20rem;
  height: 100%;
  padding: 14px;
  border: 0;
  color: var(--text-1);
  background: transparent;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow: auto;
  resize: none;
}

/* 保存反馈容器：单测严格匹配 flex: 0 0 auto */
.config-footer {
  flex: 0 0 auto;
  display: grid;
  gap: 6px;
  min-height: 0;
  padding: 8px 14px;
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface-2) 98%, var(--surface-1));
  overflow-wrap: anywhere;
}

/* 右侧说明侧栏：拓宽并增加结构化卡片排版 */
.hint-pane {
  min-width: 0;
  min-height: 0;
  padding: 14px 16px;
  background: color-mix(in srgb, var(--surface-1) 94%, var(--surface-0));
}

/* 宽栏持续展示说明，窄栏保留原生 details 键盘展开能力。 */
.hint-pane:not([open]) > .hint-body {
  display: flex;
}

.hint-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}

.hint-icon {
  color: var(--accent);
}

.hint-kicker {
  margin: 0;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.hint-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
}

.hint-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hint-field-title {
  margin: 0;
  color: var(--text-1);
  font-size: 13.5px;
  font-weight: 650;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.hint-field-meaning {
  margin: 0;
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.hint-param-box {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 10px;
  border-radius: var(--radius-control);
  background: var(--surface-2);
  border: 1px solid var(--border);
}

.param-label {
  font-size: 11px;
  color: var(--text-3);
  font-weight: 600;
}

.param-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  color: var(--accent);
  word-break: break-all;
}

.hint-note-callout {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-radius: var(--radius-control);
  background: color-mix(in srgb, var(--accent) 8%, var(--surface-2));
  border-left: 3px solid var(--accent);
}

.callout-sparkle {
  color: var(--accent);
  flex-shrink: 0;
  margin-top: 2px;
}

.callout-text {
  margin: 0;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.5;
}

.code-badge {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--accent);
}

.hint-empty-card {
  padding: 20px 10px;
  text-align: center;
  border: 1px dashed var(--border);
  border-radius: var(--radius-control);
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.5;
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

.state {
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.55;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

@container settings-content (max-width: 680px) {
  .config-body {
    grid-template-columns: minmax(0, 1fr);
  }

  .editor-column {
    border-right: 0;
  }

  .hint-pane {
    border-top: 1px solid var(--border);
  }

  .hint-pane:not([open]) > .hint-body {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sandbox-select {
    transition: none;
  }
}
</style>
