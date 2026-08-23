export type ProviderAuthMode = 'bearer' | 'none'

export type ProviderCredentialStorage = 'secure' | 'session-only' | 'unavailable' | 'corrupt'

export type ProviderTestStage = 'validation' | 'models' | 'inference'

export type ProviderErrorCode =
  | 'invalid-input'
  | 'invalid-base-url'
  | 'unsupported-protocol'
  | 'url-credentials-not-allowed'
  | 'url-query-or-hash-not-allowed'
  | 'api-key-required'
  | 'api-key-not-allowed'
  | 'invalid-api-key'
  | 'model-id-required'
  | 'invalid-model-id'
  | 'authentication-failed'
  | 'endpoint-not-found'
  | 'rate-limited'
  | 'quota-exceeded'
  | 'request-timeout'
  | 'tls-error'
  | 'network-error'
  | 'model-not-found'
  | 'invalid-response'
  | 'server-error'
  | 'http-error'
  | 'unknown-error'

export interface ProviderConnectionInput {
  baseUrl: string
  authMode: ProviderAuthMode
  apiKey?: string
}

export interface ProviderConfigInput extends ProviderConnectionInput {
  modelId: string
  modelDisplayName?: string
}

export interface ProviderConfigSummary {
  configured: boolean
  baseUrl?: string
  authMode?: ProviderAuthMode
  modelId?: string
  modelDisplayName?: string
  hasApiKey: boolean
  credentialStorage: ProviderCredentialStorage
  testedAt?: string
  updatedAt?: string
}

/** 模型请求使用 modelId，界面只展示服务端真实返回的 displayName。 */
export interface ProviderModelOption {
  modelId: string
  displayName?: string
}

/**
 * 把模型选项摊成 IPC 可 structuredClone 的纯对象。
 * Vue 把列表项变成 Proxy 后不能直接 invoke，Electron 会报 DataCloneError。
 */
export function toSerializableProviderModel(model: ProviderModelOption): ProviderModelOption {
  const modelId = typeof model.modelId === 'string' ? model.modelId : ''
  const displayName = typeof model.displayName === 'string' ? model.displayName.trim() : ''
  return displayName ? { modelId, displayName } : { modelId }
}

export interface ProviderTestResult {
  ok: boolean
  stage: ProviderTestStage
  message: string
  code?: ProviderErrorCode
  models?: ProviderModelOption[]
}

/** Renderer 只能通过这组窄接口管理 Provider，已保存的明文 Key 不可读取。 */
export interface ProviderDesktopApi {
  getSummary: () => Promise<ProviderConfigSummary>
  listModels: (input?: ProviderConnectionInput) => Promise<ProviderTestResult>
  save: (input: ProviderConfigInput) => Promise<ProviderConfigSummary>
  selectModel: (model: ProviderModelOption) => Promise<ProviderConfigSummary>
  clear: () => Promise<ProviderConfigSummary>
}
