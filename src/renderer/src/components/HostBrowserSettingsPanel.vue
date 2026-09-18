<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  DEFAULT_HOST_BROWSER_SETTINGS,
  type HostBrowserAgentPermissions,
  type HostBrowserSettings
} from '../../../shared/host-browser'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'
import {
  HOST_BROWSER_AGENT_PERMISSION_COLUMNS,
  HOST_BROWSER_AGENT_PERMISSION_OPTIONS,
  HOST_BROWSER_CAUTIOUS_HINT,
  HOST_BROWSER_CHROME_CONNECT_LABEL,
  HOST_BROWSER_CLEAR_DATA_KINDS,
  HOST_BROWSER_CLEAR_DATA_LABEL,
  HOST_BROWSER_CLEAR_DATA_STATUS,
  HOST_BROWSER_CLEAR_DATA_TITLE,
  HOST_BROWSER_COOKIE_SYNC_LABEL,
  HOST_BROWSER_DOWNLOAD_ASK_LABEL,
  HOST_BROWSER_EXTENSION_INSTALL_HINT,
  HOST_BROWSER_EXTENSION_INSTALL_LABEL,
  HOST_BROWSER_EXTENSION_INSTALL_STATUS,
  HOST_BROWSER_EXTENSION_LAST_SYNC_NONE,
  HOST_BROWSER_FULL_CDP_HINT,
  HOST_BROWSER_GROUP_AGENT_PERMISSIONS_TITLE,
  HOST_BROWSER_GROUP_CAUTIOUS_TITLE,
  HOST_BROWSER_GROUP_DOWNLOADS_TITLE,
  HOST_BROWSER_GROUP_EXTENSION_TITLE,
  HOST_BROWSER_GROUP_FULL_CDP_TITLE,
  HOST_BROWSER_GROUP_GENERAL_TITLE,
  HOST_BROWSER_GROUP_PASSWORDS_TITLE,
  HOST_BROWSER_LINK_OPEN_LABEL,
  HOST_BROWSER_LINK_OPEN_OPTIONS,
  HOST_BROWSER_PASSWORDS_BODY,
  HOST_BROWSER_SCREENSHOT_ANNOTATION_LABEL,
  HOST_BROWSER_SCREENSHOT_ANNOTATION_OPTIONS,
  HOST_BROWSER_SCREENSHOT_TOKEN_HINT,
  HOST_BROWSER_SETTING_BUSY_TITLE,
  HOST_BROWSER_SETTING_HINT,
  HOST_BROWSER_SETTING_LOAD_ERROR_COPY,
  HOST_BROWSER_SETTING_LOADING_COPY,
  HOST_BROWSER_SETTING_PAGE_SUBTITLE,
  HOST_BROWSER_SETTING_PAGE_TITLE,
  HOST_BROWSER_SETTING_RETRY_LABEL,
  HOST_BROWSER_SETTING_SAVED_COPY,
  HOST_BROWSER_SETTING_SAVED_SESSION_COPY,
  HOST_BROWSER_SETTING_SAVING_COPY,
  HOST_BROWSER_SETTING_TITLE,
  HOST_BROWSER_SHOW_FULL_URL_LABEL,
  HOST_BROWSER_SYNC_BLACKLIST_HINT,
  HOST_BROWSER_SYNC_BLACKLIST_INVALID_COPY,
  HOST_BROWSER_SYNC_BLACKLIST_LABEL,
  cloneHostBrowserSettingsView,
  formatHostBrowserLastCookieSync,
  formatHostBrowserSyncBlacklist,
  parseHostBrowserSyncBlacklistDraft,
  resolveHostBrowserMasterSwitchDisabled,
  resolveHostBrowserPreferenceDisabled,
  resolveHostBrowserSettingTitle,
  revertHostBrowserCheckbox,
  revertHostBrowserSelect,
  takeHostBrowserCheckboxIntent,
  takeHostBrowserSelectIntent
} from '../host-browser-settings'

const props = withDefaults(
  defineProps<{
    runtimeBusy?: boolean
  }>(),
  { runtimeBusy: false }
)

type BooleanSettingKey =
  | 'showFullUrl'
  | 'downloadAskBefore'
  | 'fullCdp'
  | 'cautiousMode'
  | 'cookieSyncEnabled'
  | 'chromeConnectEnabled'

const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')
const settings = ref<HostBrowserSettings>(
  cloneHostBrowserSettingsView(DEFAULT_HOST_BROWSER_SETTINGS)
)
const blacklistDraft = ref('')
const saving = ref(false)
const errorMessage = ref('')
const statusMessage = ref('')
const lastCookieSyncAt = ref<string | null>(null)
const lastSyncCopy = computed(() => formatHostBrowserLastCookieSync(lastCookieSyncAt.value))

const masterSwitchDisabled = computed(() =>
  resolveHostBrowserMasterSwitchDisabled({
    runtimeBusy: props.runtimeBusy,
    saving: saving.value,
    loadState: loadState.value
  })
)
const preferenceDisabled = computed(() =>
  resolveHostBrowserPreferenceDisabled({
    saving: saving.value,
    loadState: loadState.value
  })
)
const toggleTitle = computed(() =>
  resolveHostBrowserSettingTitle({ runtimeBusy: props.runtimeBusy })
)

onMounted(() => {
  void loadSettings()
  void loadExtensionStatus()
})

function applySettings(next: HostBrowserSettings): void {
  settings.value = cloneHostBrowserSettingsView(next)
  blacklistDraft.value = formatHostBrowserSyncBlacklist(next.syncBlacklist)
}

async function loadSettings(): Promise<void> {
  loadState.value = 'loading'
  loadError.value = ''
  try {
    const state = unwrapDesktopIpcResult(await window.app.getHostBrowserSettings())
    applySettings(state)
    loadState.value = 'ready'
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
    loadState.value = 'error'
  }
}

/** 必须等主进程确认后才改 checkbox；读完意图立刻打回 DOM，禁止原生控件先翻转。 */
async function onToggle(event: Event): Promise<void> {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  const next = takeHostBrowserCheckboxIntent(target, settings.value.enabled)
  if (masterSwitchDisabled.value) return
  saving.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    const state = unwrapDesktopIpcResult(await window.app.setHostBrowserEnabled(next))
    applySettings(state)
    statusMessage.value = HOST_BROWSER_SETTING_SAVED_SESSION_COPY
  } catch (error) {
    revertHostBrowserCheckbox(target, settings.value.enabled)
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}

/** 非总开关字段走补丁 IPC；控件值仍绑定上次确认结果，失败则保持原样。 */
async function savePatch(patch: Partial<Omit<HostBrowserSettings, 'enabled'>>): Promise<boolean> {
  if (preferenceDisabled.value) return false
  saving.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    const state = unwrapDesktopIpcResult(await window.app.setHostBrowserSettings(patch))
    applySettings(state)
    statusMessage.value = HOST_BROWSER_SETTING_SAVED_COPY
    return true
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
    blacklistDraft.value = formatHostBrowserSyncBlacklist(settings.value.syncBlacklist)
    return false
  } finally {
    saving.value = false
  }
}

async function onBooleanChange(key: BooleanSettingKey, event: Event): Promise<void> {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  const next = takeHostBrowserCheckboxIntent(target, settings.value[key])
  if (preferenceDisabled.value) return
  const ok = await savePatch({ [key]: next })
  if (!ok) revertHostBrowserCheckbox(target, settings.value[key])
}

async function onLinkOpenChange(event: Event): Promise<void> {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  const next = takeHostBrowserSelectIntent(target, settings.value.linkOpenTarget)
  if (preferenceDisabled.value) return
  if (next !== 'studio' && next !== 'system') return
  const ok = await savePatch({ linkOpenTarget: next })
  if (!ok) revertHostBrowserSelect(target, settings.value.linkOpenTarget)
}

async function onScreenshotAnnotationChange(event: Event): Promise<void> {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  const next = takeHostBrowserSelectIntent(target, settings.value.screenshotAnnotation)
  if (preferenceDisabled.value) return
  if (next !== 'always' && next !== 'ask' && next !== 'never') return
  const ok = await savePatch({ screenshotAnnotation: next })
  if (!ok) revertHostBrowserSelect(target, settings.value.screenshotAnnotation)
}

async function onAgentPermissionChange(
  key: keyof HostBrowserAgentPermissions,
  event: Event
): Promise<void> {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  const next = takeHostBrowserSelectIntent(target, settings.value.agentPermissions[key])
  if (preferenceDisabled.value) return
  if (next !== 'always' && next !== 'ask') return
  const ok = await savePatch({
    agentPermissions: {
      ...settings.value.agentPermissions,
      [key]: next
    }
  })
  if (!ok) revertHostBrowserSelect(target, settings.value.agentPermissions[key])
}

function onBlacklistInput(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLTextAreaElement)) return
  blacklistDraft.value = target.value
}

async function onBlacklistCommit(): Promise<void> {
  if (preferenceDisabled.value) return
  const parsed = parseHostBrowserSyncBlacklistDraft(blacklistDraft.value)
  if (!parsed) {
    errorMessage.value = HOST_BROWSER_SYNC_BLACKLIST_INVALID_COPY
    statusMessage.value = ''
    return
  }
  const current = settings.value.syncBlacklist
  if (
    parsed.length === current.length &&
    parsed.every((origin, index) => origin === current[index])
  ) {
    blacklistDraft.value = formatHostBrowserSyncBlacklist(current)
    return
  }
  await savePatch({ syncBlacklist: parsed })
}

async function loadExtensionStatus(): Promise<void> {
  try {
    const status = unwrapDesktopIpcResult(await window.app.getHostBrowserExtensionStatus())
    lastCookieSyncAt.value = status.lastCookieSyncAt
  } catch {
    lastCookieSyncAt.value = null
  }
}

/** 主进程 reveal unpacked 目录并写 Native Host 清单；Renderer 不得提交路径。 */
async function onInstallExtension(): Promise<void> {
  if (preferenceDisabled.value) return
  saving.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    unwrapDesktopIpcResult(await window.app.installHostBrowserExtension())
    statusMessage.value = HOST_BROWSER_EXTENSION_INSTALL_STATUS
    await loadExtensionStatus()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}

/** 主进程 Task 4 才真正擦 partition；这里只提交白名单 kinds，不宣称已经清掉。 */
async function onClearData(): Promise<void> {
  if (preferenceDisabled.value) return
  saving.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    unwrapDesktopIpcResult(
      await window.app.clearHostBrowserData([...HOST_BROWSER_CLEAR_DATA_KINDS])
    )
    statusMessage.value = HOST_BROWSER_CLEAR_DATA_STATUS
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
      <p id="host-browser-page-subtitle">{{ HOST_BROWSER_SETTING_PAGE_SUBTITLE }}</p>
    </header>

    <div v-if="loadState === 'loading'" class="state" role="status">
      {{ HOST_BROWSER_SETTING_LOADING_COPY }}
    </div>
    <div v-else-if="loadState === 'error'" class="state" role="alert">
      <p>{{ loadError || HOST_BROWSER_SETTING_LOAD_ERROR_COPY }}</p>
      <button
        class="hub-secondary"
        type="button"
        :title="HOST_BROWSER_SETTING_RETRY_LABEL"
        :aria-label="HOST_BROWSER_SETTING_RETRY_LABEL"
        @click="loadSettings"
      >
        重试
      </button>
    </div>
    <div v-else class="browser-groups" :aria-busy="saving ? 'true' : undefined">
      <p v-if="saving" class="status" role="status">{{ HOST_BROWSER_SETTING_SAVING_COPY }}</p>
      <p v-else-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
      <p v-else-if="statusMessage" class="success" role="status">{{ statusMessage }}</p>

      <fieldset class="browser-field" :disabled="masterSwitchDisabled">
        <legend>{{ HOST_BROWSER_SETTING_TITLE }}</legend>
        <label class="toggle-row" for="host-browser-enabled">
          <input
            id="host-browser-enabled"
            type="checkbox"
            :checked="settings.enabled"
            :disabled="masterSwitchDisabled"
            :title="runtimeBusy ? HOST_BROWSER_SETTING_BUSY_TITLE : toggleTitle"
            :aria-label="HOST_BROWSER_SETTING_TITLE"
            aria-describedby="host-browser-setting-hint"
            @change="onToggle"
          />
          <span>{{ HOST_BROWSER_SETTING_TITLE }}</span>
        </label>
        <p id="host-browser-setting-hint" class="hint">{{ HOST_BROWSER_SETTING_HINT }}</p>
      </fieldset>

      <fieldset class="browser-field" :disabled="preferenceDisabled">
        <legend>{{ HOST_BROWSER_GROUP_GENERAL_TITLE }}</legend>
        <label class="control-row" for="host-browser-link-open">
          <span>{{ HOST_BROWSER_LINK_OPEN_LABEL }}</span>
          <select
            id="host-browser-link-open"
            class="select-control"
            :value="settings.linkOpenTarget"
            :disabled="preferenceDisabled"
            :aria-label="HOST_BROWSER_LINK_OPEN_LABEL"
            @change="onLinkOpenChange"
          >
            <option
              v-for="option in HOST_BROWSER_LINK_OPEN_OPTIONS"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </label>
        <label class="toggle-row" for="host-browser-show-full-url">
          <input
            id="host-browser-show-full-url"
            type="checkbox"
            :checked="settings.showFullUrl"
            :disabled="preferenceDisabled"
            :aria-label="HOST_BROWSER_SHOW_FULL_URL_LABEL"
            @change="onBooleanChange('showFullUrl', $event)"
          />
          <span>{{ HOST_BROWSER_SHOW_FULL_URL_LABEL }}</span>
        </label>
        <label class="control-row" for="host-browser-screenshot-annotation">
          <span>{{ HOST_BROWSER_SCREENSHOT_ANNOTATION_LABEL }}</span>
          <select
            id="host-browser-screenshot-annotation"
            class="select-control"
            :value="settings.screenshotAnnotation"
            :disabled="preferenceDisabled"
            :aria-label="HOST_BROWSER_SCREENSHOT_ANNOTATION_LABEL"
            aria-describedby="host-browser-screenshot-token-hint"
            @change="onScreenshotAnnotationChange"
          >
            <option
              v-for="option in HOST_BROWSER_SCREENSHOT_ANNOTATION_OPTIONS"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </label>
        <p id="host-browser-screenshot-token-hint" class="hint">
          {{ HOST_BROWSER_SCREENSHOT_TOKEN_HINT }}
        </p>
        <button
          class="hub-secondary"
          type="button"
          :title="HOST_BROWSER_CLEAR_DATA_TITLE"
          :aria-label="HOST_BROWSER_CLEAR_DATA_TITLE"
          :disabled="preferenceDisabled"
          @click="onClearData"
        >
          {{ HOST_BROWSER_CLEAR_DATA_LABEL }}
        </button>
      </fieldset>

      <fieldset class="browser-field">
        <legend>{{ HOST_BROWSER_GROUP_PASSWORDS_TITLE }}</legend>
        <p class="hint">{{ HOST_BROWSER_PASSWORDS_BODY }}</p>
      </fieldset>

      <fieldset class="browser-field" :disabled="preferenceDisabled">
        <legend>{{ HOST_BROWSER_GROUP_DOWNLOADS_TITLE }}</legend>
        <label class="toggle-row" for="host-browser-download-ask">
          <input
            id="host-browser-download-ask"
            type="checkbox"
            :checked="settings.downloadAskBefore"
            :disabled="preferenceDisabled"
            :aria-label="HOST_BROWSER_DOWNLOAD_ASK_LABEL"
            @change="onBooleanChange('downloadAskBefore', $event)"
          />
          <span>{{ HOST_BROWSER_DOWNLOAD_ASK_LABEL }}</span>
        </label>
      </fieldset>

      <fieldset class="browser-field" :disabled="preferenceDisabled">
        <legend>{{ HOST_BROWSER_GROUP_AGENT_PERMISSIONS_TITLE }}</legend>
        <div class="permission-grid">
          <label
            v-for="column in HOST_BROWSER_AGENT_PERMISSION_COLUMNS"
            :key="column.key"
            class="control-row"
            :for="`host-browser-permission-${column.key}`"
          >
            <span>{{ column.label }}</span>
            <select
              :id="`host-browser-permission-${column.key}`"
              class="select-control"
              :value="settings.agentPermissions[column.key]"
              :disabled="preferenceDisabled"
              :aria-label="column.label"
              @change="onAgentPermissionChange(column.key, $event)"
            >
              <option
                v-for="option in HOST_BROWSER_AGENT_PERMISSION_OPTIONS"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
          </label>
        </div>
      </fieldset>

      <fieldset class="browser-field" :disabled="preferenceDisabled">
        <legend>{{ HOST_BROWSER_GROUP_EXTENSION_TITLE }}</legend>
        <button
          class="hub-secondary"
          type="button"
          :title="HOST_BROWSER_EXTENSION_INSTALL_LABEL"
          :aria-label="HOST_BROWSER_EXTENSION_INSTALL_LABEL"
          :disabled="preferenceDisabled"
          @click="onInstallExtension"
        >
          {{ HOST_BROWSER_EXTENSION_INSTALL_LABEL }}
        </button>
        <p class="hint">{{ HOST_BROWSER_EXTENSION_INSTALL_HINT }}</p>
        <p class="hint">{{ lastSyncCopy || HOST_BROWSER_EXTENSION_LAST_SYNC_NONE }}</p>
        <label class="control-row" for="host-browser-sync-blacklist">
          <span>{{ HOST_BROWSER_SYNC_BLACKLIST_LABEL }}</span>
          <textarea
            id="host-browser-sync-blacklist"
            class="blacklist-input"
            :value="blacklistDraft"
            :disabled="preferenceDisabled"
            :aria-label="HOST_BROWSER_SYNC_BLACKLIST_LABEL"
            aria-describedby="host-browser-sync-blacklist-hint"
            @input="onBlacklistInput"
            @blur="onBlacklistCommit"
          />
        </label>
        <p id="host-browser-sync-blacklist-hint" class="hint">
          {{ HOST_BROWSER_SYNC_BLACKLIST_HINT }}
        </p>
        <label class="toggle-row" for="host-browser-cookie-sync">
          <input
            id="host-browser-cookie-sync"
            type="checkbox"
            :checked="settings.cookieSyncEnabled"
            :disabled="preferenceDisabled"
            :aria-label="HOST_BROWSER_COOKIE_SYNC_LABEL"
            @change="onBooleanChange('cookieSyncEnabled', $event)"
          />
          <span>{{ HOST_BROWSER_COOKIE_SYNC_LABEL }}</span>
        </label>
        <label class="toggle-row" for="host-browser-chrome-connect">
          <input
            id="host-browser-chrome-connect"
            type="checkbox"
            :checked="settings.chromeConnectEnabled"
            :disabled="preferenceDisabled"
            :aria-label="HOST_BROWSER_CHROME_CONNECT_LABEL"
            @change="onBooleanChange('chromeConnectEnabled', $event)"
          />
          <span>{{ HOST_BROWSER_CHROME_CONNECT_LABEL }}</span>
        </label>
      </fieldset>

      <fieldset class="browser-field" :disabled="preferenceDisabled">
        <legend>{{ HOST_BROWSER_GROUP_FULL_CDP_TITLE }}</legend>
        <label class="toggle-row" for="host-browser-full-cdp">
          <input
            id="host-browser-full-cdp"
            type="checkbox"
            :checked="settings.fullCdp"
            :disabled="preferenceDisabled"
            :aria-label="HOST_BROWSER_GROUP_FULL_CDP_TITLE"
            aria-describedby="host-browser-full-cdp-hint"
            @change="onBooleanChange('fullCdp', $event)"
          />
          <span>{{ HOST_BROWSER_GROUP_FULL_CDP_TITLE }}</span>
        </label>
        <p id="host-browser-full-cdp-hint" class="hint">{{ HOST_BROWSER_FULL_CDP_HINT }}</p>
      </fieldset>

      <fieldset class="browser-field" :disabled="preferenceDisabled">
        <legend>{{ HOST_BROWSER_GROUP_CAUTIOUS_TITLE }}</legend>
        <label class="toggle-row" for="host-browser-cautious-mode">
          <input
            id="host-browser-cautious-mode"
            type="checkbox"
            :checked="settings.cautiousMode"
            :disabled="preferenceDisabled"
            :aria-label="HOST_BROWSER_GROUP_CAUTIOUS_TITLE"
            aria-describedby="host-browser-cautious-hint"
            @change="onBooleanChange('cautiousMode', $event)"
          />
          <span>{{ HOST_BROWSER_GROUP_CAUTIOUS_TITLE }}</span>
        </label>
        <p id="host-browser-cautious-hint" class="hint">{{ HOST_BROWSER_CAUTIOUS_HINT }}</p>
      </fieldset>
    </div>
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
.state,
.hint {
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.55;
}

.state {
  display: grid;
  gap: 10px;
  justify-items: start;
}

.browser-groups {
  display: grid;
  gap: 16px;
  min-width: 0;
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

.toggle-row,
.control-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--text-1);
  font-size: 13px;
}

.control-row {
  justify-content: space-between;
}

.hint {
  margin: 0;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.45;
}

.select-control,
.blacklist-input {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  color: var(--text-1);
  background: var(--app-bg);
  font: inherit;
}

.select-control {
  min-width: 9rem;
  padding: 5px 10px;
}

.select-control:focus-visible,
.blacklist-input:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 76%, white);
  outline-offset: 2px;
}

.blacklist-input {
  width: 100%;
  min-height: 72px;
  padding: 8px 10px;
  resize: vertical;
}

.permission-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
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
