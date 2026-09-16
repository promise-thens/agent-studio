<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'
import {
  HOST_BROWSER_SETTING_HINT,
  HOST_BROWSER_SETTING_PAGE_TITLE,
  HOST_BROWSER_SETTING_TITLE,
  resolveHostBrowserSettingTitle
} from '../host-browser-settings'

const props = withDefaults(
  defineProps<{
    runtimeBusy?: boolean
  }>(),
  { runtimeBusy: false }
)

const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')
const enabled = ref(true)
const saving = ref(false)
const errorMessage = ref('')
const statusMessage = ref('')

const disabled = computed(() => props.runtimeBusy || saving.value || loadState.value !== 'ready')
const toggleTitle = computed(() =>
  resolveHostBrowserSettingTitle({ runtimeBusy: props.runtimeBusy })
)

onMounted(() => {
  void loadSettings()
})

async function loadSettings(): Promise<void> {
  loadState.value = 'loading'
  loadError.value = ''
  try {
    const state = unwrapDesktopIpcResult(await window.app.getHostBrowserSettings())
    enabled.value = state.enabled
    loadState.value = 'ready'
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
    loadState.value = 'error'
  }
}

/** 必须等主进程确认后才改 checkbox，禁止先乐观显示已关闭。 */
async function onToggle(event: Event): Promise<void> {
  const target = event.target
  if (!(target instanceof HTMLInputElement) || disabled.value) return
  const next = target.checked
  saving.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    const state = unwrapDesktopIpcResult(await window.app.setHostBrowserEnabled(next))
    enabled.value = state.enabled
    statusMessage.value = '已保存。下一 session 生效。'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="browser-settings-pane" aria-labelledby="host-browser-page-title">
    <header>
      <h3 id="host-browser-page-title">{{ HOST_BROWSER_SETTING_PAGE_TITLE }}</h3>
      <p id="host-browser-setting-hint">{{ HOST_BROWSER_SETTING_HINT }}</p>
    </header>

    <div v-if="loadState === 'loading'" class="state">正在读取设置…</div>
    <div v-else-if="loadState === 'error'" class="state" role="alert">
      <p>{{ loadError || '读取设置失败。' }}</p>
      <button
        class="hub-secondary"
        type="button"
        title="重试读取内置浏览器设置"
        aria-label="重试读取内置浏览器设置"
        @click="loadSettings"
      >
        重试
      </button>
    </div>
    <fieldset v-else class="browser-field" :disabled="disabled">
      <legend>{{ HOST_BROWSER_SETTING_TITLE }}</legend>
      <label class="toggle-row" for="host-browser-enabled">
        <input
          id="host-browser-enabled"
          type="checkbox"
          :checked="enabled"
          :disabled="disabled"
          :title="toggleTitle"
          :aria-label="HOST_BROWSER_SETTING_TITLE"
          aria-describedby="host-browser-setting-hint"
          @change="onToggle"
        />
        <span>注入宿主浏览器 MCP</span>
      </label>
      <p v-if="saving" class="status" role="status">正在保存…</p>
      <p v-else-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
      <p v-else-if="statusMessage" class="success" role="status">{{ statusMessage }}</p>
    </fieldset>
  </section>
</template>

<style scoped>
.browser-settings-pane {
  display: grid;
  align-content: start;
  gap: 16px;
}

header h3,
header p {
  margin: 0;
}

header h3 {
  font-size: 16px;
}

header p,
.state {
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.55;
}

.state {
  display: grid;
  gap: 10px;
  justify-items: start;
}

.browser-field {
  display: grid;
  gap: 10px;
  min-width: 0;
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--app-bg);
}

.browser-field legend {
  padding: 0 4px;
  color: var(--text-1);
  font-size: 14px;
  font-weight: 650;
}

.toggle-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--text-1);
  font-size: 13px;
}

.status {
  margin: 0;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.45;
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
</style>
