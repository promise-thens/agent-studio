<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  PhArrowRight as ArrowRight,
  PhCheckCircle as CheckCircle,
  PhCircleNotch as CircleNotch,
  PhPlugsConnected as PlugsConnected,
  PhWarningCircle as WarningCircle
} from '@phosphor-icons/vue'
import type {
  ProviderAuthMode,
  ProviderConfigInput,
  ProviderConfigSummary,
  ProviderConnectionInput,
  ProviderModelOption,
  ProviderTestResult
} from '../../../shared/provider'
import BrandMark from './BrandMark.vue'

type LoadingAction = 'models' | 'save' | 'clear' | null
type FieldName = 'baseUrl' | 'apiKey' | 'modelId'
type FieldErrors = Partial<Record<FieldName, string>>

interface Props {
  initialSummary?: ProviderConfigSummary | null
  listModels: (input: ProviderConnectionInput) => Promise<ProviderTestResult>
  saveProvider: (input: ProviderConfigInput) => Promise<ProviderConfigSummary>
  clearProvider?: () => Promise<void>
  canCancel?: boolean
  /** page 是首次全屏引导；embedded 嵌进设置弹窗，去掉品牌头。 */
  layout?: 'page' | 'embedded'
}

const props = withDefaults(defineProps<Props>(), {
  initialSummary: null,
  canCancel: false,
  layout: 'page'
})
const emit = defineEmits<{
  saved: [summary: ProviderConfigSummary]
  cancelled: []
  cleared: []
}>()

const baseUrl = ref(props.initialSummary?.baseUrl ?? '')
const authMode = ref<ProviderAuthMode>(props.initialSummary?.authMode ?? 'bearer')
const apiKey = ref('')
const modelId = ref(props.initialSummary?.modelId ?? '')
const models = ref<ProviderModelOption[]>([])
const manualModel = ref(Boolean(props.initialSummary?.modelId))
const loading = ref<LoadingAction>(null)
const errors = ref<FieldErrors>({})
const notice = ref<{ tone: 'error' | 'success'; message: string } | null>(null)
const confirmingClear = ref(false)

const isBusy = computed(() => loading.value !== null)
const selectedModel = computed(() => models.value.find((model) => model.modelId === modelId.value))
const canReuseSavedKey = computed(
  () =>
    authMode.value === 'bearer' &&
    Boolean(props.initialSummary?.hasApiKey) &&
    hasSameOrigin(baseUrl.value, props.initialSummary?.baseUrl)
)
const usesHttp = computed(() => {
  try {
    return new URL(baseUrl.value.trim()).protocol === 'http:'
  } catch {
    return false
  }
})

/** 界面只展示接口实际返回的名称，缺失时原样显示 modelId。 */
function modelLabel(model: ProviderModelOption): string {
  return model.displayName?.trim() || model.modelId
}

function clearFeedback(field?: FieldName): void {
  if (field) errors.value[field] = undefined
  notice.value = null
}

function handleConnectionChange(field: 'baseUrl' | 'apiKey'): void {
  clearFeedback(field)
  if (field === 'baseUrl') {
    models.value = []
    manualModel.value = true
  }
}

function validate(includeModel: boolean): boolean {
  const nextErrors: FieldErrors = {}

  if (!baseUrl.value.trim()) {
    nextErrors.baseUrl = '请输入模型服务地址。'
  } else {
    try {
      new URL(baseUrl.value.trim())
    } catch {
      nextErrors.baseUrl = '请输入完整有效的 URL。'
    }
  }

  if (authMode.value === 'bearer' && !apiKey.value.trim() && !canReuseSavedKey.value) {
    nextErrors.apiKey = 'Bearer 认证需要填写 API Key。'
  }
  if (includeModel && !modelId.value.trim()) {
    nextErrors.modelId = '请选择模型，或手动填写实际 Model ID。'
  }

  errors.value = nextErrors
  return Object.keys(nextErrors).length === 0
}

function connectionInput(): ProviderConnectionInput {
  return {
    baseUrl: baseUrl.value.trim(),
    authMode: authMode.value,
    apiKey: authMode.value === 'bearer' ? apiKey.value.trim() : undefined
  }
}

/** 模型列表不可用时自动开放手填路径，不阻塞非标准兼容服务。 */
async function discoverModels(): Promise<void> {
  if (isBusy.value || !validate(false)) return
  clearFeedback()
  loading.value = 'models'

  try {
    const result = await props.listModels(connectionInput())
    if (!result.ok) {
      models.value = []
      manualModel.value = true
      applyServiceError(result.code ?? '', result.message, 'models')
      return
    }

    models.value = deduplicateModels(result.models ?? [])
    if (!models.value.length) {
      manualModel.value = true
      notice.value = { tone: 'error', message: '服务未返回模型，请手动填写 Model ID。' }
      return
    }

    const current = models.value.find((model) => model.modelId === modelId.value)
    selectDiscoveredModel(current ?? models.value[0])
    manualModel.value = false
    notice.value = { tone: 'success', message: `已获取 ${models.value.length} 个模型。` }
  } catch (error) {
    models.value = []
    manualModel.value = true
    applyUnknownError(error, 'models')
  } finally {
    loading.value = null
  }
}

/** 明文 Key 仅存在于本表单，主进程确认保存后立即清空。 */
async function submitProvider(): Promise<void> {
  if (isBusy.value || !validate(true)) return
  clearFeedback()
  loading.value = 'save'

  try {
    const actualModel = manualModel.value ? undefined : selectedModel.value
    const summary = await props.saveProvider({
      ...connectionInput(),
      modelId: modelId.value.trim(),
      modelDisplayName:
        actualModel?.displayName?.trim() ||
        (hasSameOrigin(baseUrl.value, props.initialSummary?.baseUrl) &&
        modelId.value.trim() === props.initialSummary?.modelId
          ? props.initialSummary.modelDisplayName
          : undefined)
    })

    apiKey.value = ''
    notice.value = { tone: 'success', message: '连接验证通过，配置已保存到本机。' }
    emit('saved', summary)
  } catch (error) {
    applyUnknownError(error, 'save')
  } finally {
    loading.value = null
  }
}

/** 清除需要用户连续确认两次，避免误删已保存凭据和当前 Runtime 配置。 */
async function requestClear(): Promise<void> {
  if (!props.clearProvider || isBusy.value) return
  if (!confirmingClear.value) {
    confirmingClear.value = true
    notice.value = { tone: 'error', message: '再次点击“确认清除”将删除模型配置并断开 Runtime。' }
    return
  }

  loading.value = 'clear'
  try {
    await props.clearProvider()
    emit('cleared')
  } catch (error) {
    applyUnknownError(error, 'clear')
  } finally {
    loading.value = null
    confirmingClear.value = false
  }
}

function deduplicateModels(options: ProviderModelOption[]): ProviderModelOption[] {
  const seen = new Set<string>()
  return options.filter((model) => {
    if (!model.modelId.trim() || seen.has(model.modelId)) return false
    seen.add(model.modelId)
    return true
  })
}

function selectDiscoveredModel(model?: ProviderModelOption): void {
  if (!model) return
  modelId.value = model.modelId
  clearFeedback('modelId')
}

function useManualModel(): void {
  manualModel.value = true
  clearFeedback('modelId')
}

function useDiscoveredModels(): void {
  if (!models.value.length) return
  manualModel.value = false
  selectDiscoveredModel(selectedModel.value ?? models.value[0])
}

function applyUnknownError(error: unknown, action: Exclude<LoadingAction, null>): void {
  const value = error as { code?: unknown; message?: unknown }
  const code = typeof value?.code === 'string' ? value.code : ''
  const message =
    error instanceof Error
      ? error.message
      : typeof value?.message === 'string'
        ? value.message
        : action === 'models'
          ? '读取模型列表失败，请手动填写 Model ID。'
          : action === 'clear'
            ? '清除模型配置失败。'
            : '测试并保存失败。'
  applyServiceError(code, message, action)
}

function applyServiceError(
  code: string,
  message: string,
  action: Exclude<LoadingAction, null>
): void {
  const signature = `${code} ${message}`.toLowerCase()

  if (/url|protocol|服务地址/.test(signature)) errors.value.baseUrl = message
  else if (/auth|key|认证|密钥/.test(signature)) errors.value.apiKey = message
  else if (action === 'save' && /model|模型/.test(signature)) errors.value.modelId = message
  else notice.value = { tone: 'error', message }
}

function hasSameOrigin(left: string, right?: string): boolean {
  if (!right) return false
  try {
    return new URL(left.trim()).origin === new URL(right).origin
  } catch {
    return false
  }
}
</script>

<template>
  <main class="provider-onboarding" :class="{ embedded: layout === 'embedded' }">
    <section
      class="onboarding-panel"
      :aria-labelledby="layout === 'page' ? 'provider-title' : undefined"
      :aria-label="layout === 'embedded' ? '供应商配置' : undefined"
    >
      <header v-if="layout === 'page'" class="onboarding-header">
        <span class="brand-mark" aria-hidden="true"><BrandMark :size="22" /></span>
        <div>
          <p>Agent Studio</p>
          <h1 id="provider-title">连接你的模型服务</h1>
          <span>填写兼容 OpenAI Chat Completions 的服务信息，验证成功后会保存到本机。</span>
        </div>
      </header>

      <form novalidate @submit.prevent="submitProvider">
        <label class="field" for="provider-url">
          <span>Base URL</span>
          <input
            id="provider-url"
            v-model="baseUrl"
            type="url"
            inputmode="url"
            autocomplete="url"
            placeholder="https://api.example.com/v1"
            spellcheck="false"
            :disabled="isBusy"
            :aria-invalid="Boolean(errors.baseUrl)"
            :aria-describedby="
              errors.baseUrl
                ? 'provider-url-error'
                : usesHttp
                  ? 'provider-http-warning provider-url-media-hint'
                  : 'provider-url-media-hint'
            "
            @input="handleConnectionChange('baseUrl')"
          />
          <small v-if="errors.baseUrl" id="provider-url-error" class="field-error">
            {{ errors.baseUrl }}
          </small>
          <small v-else-if="usesHttp" id="provider-http-warning" class="http-warning" role="status">
            <WarningCircle :size="14" weight="fill" />
            <span>HTTP 连接未加密，API Key 和请求内容可能被截获。请仅连接你信任的服务。</span>
          </small>
          <small v-else>保留服务商要求的路径，例如 /v1。</small>
          <small v-if="!errors.baseUrl" id="provider-url-media-hint">
            生图走同一 Base URL，服务需提供 /v1/images/generations。
          </small>
        </label>

        <fieldset class="field auth-field">
          <legend>认证方式</legend>
          <div class="auth-options">
            <label :class="{ selected: authMode === 'bearer' }">
              <input
                v-model="authMode"
                type="radio"
                value="bearer"
                :disabled="isBusy"
                @change="models = []"
              />
              Bearer API Key
            </label>
            <label :class="{ selected: authMode === 'none' }">
              <input
                v-model="authMode"
                type="radio"
                value="none"
                :disabled="isBusy"
                @change="models = []"
              />
              无需认证
            </label>
          </div>
        </fieldset>

        <label v-if="authMode === 'bearer'" class="field" for="provider-key">
          <span>API Key</span>
          <input
            id="provider-key"
            v-model="apiKey"
            type="password"
            autocomplete="new-password"
            :placeholder="canReuseSavedKey ? '留空沿用已保存密钥' : '输入 API Key'"
            spellcheck="false"
            :disabled="isBusy"
            :aria-invalid="Boolean(errors.apiKey)"
            :aria-describedby="errors.apiKey ? 'provider-key-error' : undefined"
            @input="handleConnectionChange('apiKey')"
          />
          <small v-if="errors.apiKey" id="provider-key-error" class="field-error">
            {{ errors.apiKey }}
          </small>
          <small v-else-if="canReuseSavedKey">密钥已安全保存，留空不会更换。</small>
          <small v-else>密钥不会回填到 Renderer，也不会以明文保存。</small>
        </label>

        <section class="model-field" aria-labelledby="model-field-title">
          <header>
            <div>
              <strong id="model-field-title">模型</strong>
              <small>显示接口返回的实际名称；缺失时显示原始 Model ID。</small>
            </div>
            <button
              type="button"
              class="secondary-button"
              :disabled="isBusy"
              @click="discoverModels"
            >
              <CircleNotch v-if="loading === 'models'" :size="15" class="spin" />
              <PlugsConnected v-else :size="15" />
              {{ loading === 'models' ? '正在获取' : '获取模型' }}
            </button>
          </header>

          <template v-if="!manualModel && models.length">
            <select
              v-model="modelId"
              :title="selectedModel ? modelLabel(selectedModel) : undefined"
              :disabled="isBusy"
              :aria-invalid="Boolean(errors.modelId)"
              aria-labelledby="model-field-title"
              :aria-describedby="errors.modelId ? 'provider-model-error' : undefined"
              @change="selectDiscoveredModel(selectedModel)"
            >
              <option v-for="model in models" :key="model.modelId" :value="model.modelId">
                {{ modelLabel(model) }}
              </option>
            </select>
            <small
              v-if="selectedModel && modelLabel(selectedModel) !== selectedModel.modelId"
              class="model-id"
              :title="selectedModel.modelId"
            >
              Model ID：{{ selectedModel.modelId }}
            </small>
            <button type="button" class="text-button" :disabled="isBusy" @click="useManualModel">
              手动填写 Model ID
            </button>
          </template>

          <template v-else-if="manualModel">
            <input
              v-model="modelId"
              type="text"
              autocomplete="off"
              placeholder="填写实际 Model ID"
              spellcheck="false"
              :disabled="isBusy"
              :aria-invalid="Boolean(errors.modelId)"
              aria-labelledby="model-field-title"
              :aria-describedby="errors.modelId ? 'provider-model-error' : undefined"
              @input="clearFeedback('modelId')"
            />
            <button
              v-if="models.length"
              type="button"
              class="text-button"
              :disabled="isBusy"
              @click="useDiscoveredModels"
            >
              返回模型列表
            </button>
          </template>

          <button v-else type="button" class="manual-entry" @click="useManualModel">
            获取失败？直接手动填写 Model ID
          </button>
          <small v-if="errors.modelId" id="provider-model-error" class="field-error">
            {{ errors.modelId }}
          </small>
        </section>

        <div
          v-if="notice"
          class="form-notice"
          :data-tone="notice.tone"
          :role="notice.tone === 'error' ? 'alert' : 'status'"
        >
          <WarningCircle v-if="notice.tone === 'error'" :size="16" weight="fill" />
          <CheckCircle v-else :size="16" weight="fill" />
          <span>{{ notice.message }}</span>
        </div>

        <footer class="form-footer">
          <div class="form-footer-copy">
            <p>保存前会发送一次最小请求，确认所选模型能够正常回答。</p>
            <div class="footer-links">
              <button
                v-if="clearProvider && initialSummary?.configured"
                type="button"
                class="text-button danger-link"
                :disabled="isBusy"
                @click="requestClear"
              >
                {{ loading === 'clear' ? '正在清除' : confirmingClear ? '确认清除' : '清除配置' }}
              </button>
              <button
                v-if="canCancel"
                type="button"
                class="text-button"
                :disabled="isBusy"
                @click="emit('cancelled')"
              >
                返回工作台
              </button>
            </div>
          </div>
          <button type="submit" class="primary-button" :disabled="isBusy">
            <CircleNotch v-if="loading === 'save'" :size="16" class="spin" />
            <template v-if="loading === 'save'">正在测试并保存</template>
            <template v-else>测试并保存 <ArrowRight :size="15" /></template>
          </button>
        </footer>
      </form>
    </section>
  </main>
</template>

<style scoped>
.provider-onboarding {
  min-height: 100%;
  overflow-y: auto;
  padding: clamp(32px, 7vh, 68px) 24px 52px;
  color: var(--text-1);
  background: var(--app-bg);
}

.provider-onboarding.embedded {
  min-height: 0;
  overflow: visible;
  padding: 0;
  background: transparent;
}

.provider-onboarding.embedded .onboarding-panel {
  width: 100%;
}

.provider-onboarding.embedded form {
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.onboarding-panel {
  width: min(640px, 100%);
  margin: 0 auto;
}

.onboarding-header {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  gap: 14px;
  margin-bottom: 22px;
}

.brand-mark {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--border));
  border-radius: var(--radius-panel);
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, var(--surface-2));
}

.onboarding-header p,
.onboarding-header h1,
.onboarding-header span,
.form-footer p {
  margin: 0;
}

.form-footer-copy {
  display: grid;
  gap: 8px;
}

.footer-links {
  display: flex;
  align-items: center;
  gap: 12px;
}

.danger-link {
  color: color-mix(in srgb, var(--danger) 84%, white);
}

.onboarding-header p {
  margin-bottom: 4px;
  color: var(--accent);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.onboarding-header h1 {
  font-size: 25px;
  letter-spacing: -0.025em;
}

.onboarding-header span {
  display: block;
  margin-top: 9px;
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.6;
}

form {
  display: grid;
  gap: 18px;
  padding: 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  background: var(--surface-1);
  box-shadow: 0 24px 60px rgb(2 5 9 / 24%);
}

.field,
.model-field {
  display: grid;
  gap: 7px;
}

.field > span,
.field legend,
.model-field strong {
  color: var(--text-2);
  font-size: 10px;
  font-weight: 650;
}

.field small,
.model-field small {
  color: var(--text-3);
  font-size: 9px;
  line-height: 1.45;
}

input,
select {
  width: 100%;
  min-height: 39px;
  padding: 0 11px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  outline: 0;
  color: var(--text-1);
  background: var(--app-bg);
  font-size: 11px;
}

input:focus,
select:focus {
  border-color: color-mix(in srgb, var(--accent) 72%, var(--border-strong));
}

input[aria-invalid='true'],
select[aria-invalid='true'] {
  border-color: var(--danger);
}

input::placeholder {
  color: var(--text-3);
}

.auth-field {
  margin: 0;
  padding: 0;
  border: 0;
}

.auth-field legend {
  margin-bottom: 7px;
}

.auth-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.auth-options label {
  position: relative;
  padding: 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  color: var(--text-3);
  background: var(--app-bg);
  font-size: 10px;
  cursor: pointer;
}

.auth-options label.selected {
  border-color: color-mix(in srgb, var(--accent) 62%, var(--border));
  color: var(--text-1);
  background: color-mix(in srgb, var(--accent) 7%, var(--app-bg));
}

.auth-options input {
  position: absolute;
  width: 1px;
  min-height: 1px;
  opacity: 0;
}

.auth-options label:focus-within {
  outline: 2px solid color-mix(in srgb, var(--accent) 76%, white);
  outline-offset: 2px;
}

.model-field {
  padding-top: 17px;
  border-top: 1px solid var(--border);
}

.model-field header,
.form-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.model-field header div {
  min-width: 0;
}

.model-field header small {
  display: block;
  margin-top: 4px;
}

.secondary-button,
.primary-button,
.text-button,
.manual-entry {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  border-radius: var(--radius-control);
  font-size: 10px;
  font-weight: 650;
  cursor: pointer;
}

.secondary-button {
  width: auto;
  padding: 0 10px;
}

.primary-button {
  min-width: 142px;
  padding: 0 12px;
}

.text-button {
  width: max-content;
  min-height: 24px;
  padding: 0;
  border: 0;
  color: var(--text-2);
  background: transparent;
}

.text-button:hover:not(:disabled) {
  color: var(--accent-hover);
}

.manual-entry {
  min-height: 39px;
  border: 1px dashed var(--border);
  color: var(--text-3);
  background: color-mix(in srgb, var(--surface-2) 54%, transparent);
}

.manual-entry:hover {
  border-color: var(--border-strong);
  color: var(--text-2);
}

.field-error {
  color: color-mix(in srgb, var(--danger) 88%, white) !important;
}

.http-warning {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  align-items: start;
  gap: 5px;
  color: color-mix(in srgb, var(--accent) 88%, white) !important;
}

.model-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.form-notice {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  align-items: start;
  gap: 7px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  font-size: 9px;
  line-height: 1.5;
}

.form-notice[data-tone='error'] {
  border-color: color-mix(in srgb, var(--danger) 42%, var(--border));
  color: color-mix(in srgb, var(--danger) 86%, white);
}

.form-notice[data-tone='success'] {
  border-color: color-mix(in srgb, var(--success) 42%, var(--border));
  color: color-mix(in srgb, var(--success) 86%, white);
}

.form-footer {
  padding-top: 18px;
  border-top: 1px solid var(--border);
}

.form-footer p {
  max-width: 40ch;
  color: var(--text-3);
  font-size: 9px;
  line-height: 1.5;
}

button:disabled,
input:disabled,
select:disabled {
  cursor: not-allowed;
  opacity: 0.46;
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 640px) {
  .provider-onboarding {
    padding: 28px 14px 40px;
  }

  form {
    padding: 18px;
  }

  .auth-options {
    grid-template-columns: 1fr;
  }

  .form-footer {
    align-items: stretch;
    flex-direction: column;
  }

  .primary-button {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
  }
}
</style>
