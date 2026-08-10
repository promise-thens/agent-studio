import type {
  ProviderAuthMode,
  ProviderConnectionInput,
  ProviderErrorCode
} from '../../shared/provider'

const MAX_BASE_URL_LENGTH = 2_048
const MAX_API_KEY_LENGTH = 8_192
const MAX_MODEL_ID_LENGTH = 256
const MAX_MODEL_DISPLAY_NAME_LENGTH = 256

export interface ValidatedProviderConnectionInput extends ProviderConnectionInput {
  baseUrl: string
  authMode: ProviderAuthMode
  apiKey?: string
}

export interface ValidatedProviderConfigInput extends ValidatedProviderConnectionInput {
  modelId: string
  modelDisplayName?: string
}

/** 主进程使用稳定错误码向上层区分字段问题，不向 Renderer 暴露原始异常。 */
export class ProviderValidationError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ProviderValidationError'
  }
}

/** 校验并规范化 Provider Base URL，同时保留用户明确选择的 HTTP 或 HTTPS 协议。 */
export function normalizeProviderBaseUrl(rawBaseUrl: unknown): string {
  if (typeof rawBaseUrl !== 'string') {
    throw new ProviderValidationError('invalid-base-url', 'Base URL 必须是字符串')
  }

  const baseUrl = rawBaseUrl.trim()
  if (!baseUrl || baseUrl.length > MAX_BASE_URL_LENGTH) {
    throw new ProviderValidationError('invalid-base-url', '请输入有效的 Base URL')
  }

  if (hasControlCharacters(baseUrl)) {
    throw new ProviderValidationError('invalid-base-url', 'Base URL 包含不允许的控制字符')
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(baseUrl)
  } catch {
    throw new ProviderValidationError('invalid-base-url', 'Base URL 格式不正确')
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new ProviderValidationError('unsupported-protocol', 'Base URL 只支持 HTTP 或 HTTPS')
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new ProviderValidationError(
      'url-credentials-not-allowed',
      'Base URL 不能包含用户名、密码或 API Key'
    )
  }

  // 本期不支持 Query Parameter；同时拒绝 hash，避免用户误把凭据放进 URL。
  if (parsedUrl.search || parsedUrl.hash) {
    throw new ProviderValidationError(
      'url-query-or-hash-not-allowed',
      'Base URL 不能包含 query 或 hash，请在认证字段中填写密钥'
    )
  }

  const normalizedPath = parsedUrl.pathname.replace(/\/+$/, '')
  return `${parsedUrl.origin}${normalizedPath}`
}

/** 校验模型发现请求需要的 URL 与认证信息，并返回可直接发请求的规范化值。 */
export function validateProviderConnectionInput(
  rawInput: unknown
): ValidatedProviderConnectionInput {
  const input = requireRecord(rawInput)
  const baseUrl = normalizeProviderBaseUrl(input.baseUrl)
  const authMode = validateAuthMode(input.authMode)
  const apiKey = validateApiKey(authMode, input.apiKey)

  return apiKey ? { baseUrl, authMode, apiKey } : { baseUrl, authMode }
}

/** 校验保存和推理测试所需的完整 Provider 配置。 */
export function validateProviderConfigInput(rawInput: unknown): ValidatedProviderConfigInput {
  const input = requireRecord(rawInput)
  const connection = validateProviderConnectionInput(input)
  const modelId = validateModelId(input.modelId)
  const modelDisplayName = validateModelDisplayName(input.modelDisplayName)

  return modelDisplayName
    ? { ...connection, modelId, modelDisplayName }
    : { ...connection, modelId }
}

function requireRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProviderValidationError('invalid-input', 'Provider 配置必须是对象')
  }
  return input as Record<string, unknown>
}

function validateAuthMode(authMode: unknown): ProviderAuthMode {
  if (authMode !== 'bearer' && authMode !== 'none') {
    throw new ProviderValidationError('invalid-input', '认证方式必须是 bearer 或 none')
  }
  return authMode
}

function validateApiKey(authMode: ProviderAuthMode, rawApiKey: unknown): string | undefined {
  if (authMode === 'none') {
    if (rawApiKey !== undefined && (typeof rawApiKey !== 'string' || rawApiKey.trim())) {
      throw new ProviderValidationError('api-key-not-allowed', '无需认证时不能携带 API Key')
    }
    return undefined
  }

  if (typeof rawApiKey !== 'string' || !rawApiKey.trim()) {
    throw new ProviderValidationError('api-key-required', 'Bearer 认证需要填写 API Key')
  }

  const apiKey = rawApiKey.trim()
  if (apiKey.length > MAX_API_KEY_LENGTH || hasControlCharacters(apiKey)) {
    throw new ProviderValidationError('invalid-api-key', 'API Key 格式不正确')
  }
  return apiKey
}

function validateModelId(rawModelId: unknown): string {
  if (typeof rawModelId !== 'string' || !rawModelId.trim()) {
    throw new ProviderValidationError('model-id-required', '请选择或填写 Model ID')
  }

  const modelId = rawModelId.trim()
  if (modelId.length > MAX_MODEL_ID_LENGTH || hasControlCharacters(modelId)) {
    throw new ProviderValidationError('invalid-model-id', 'Model ID 格式不正确')
  }
  return modelId
}

function validateModelDisplayName(rawDisplayName: unknown): string | undefined {
  if (rawDisplayName === undefined || rawDisplayName === null || rawDisplayName === '') {
    return undefined
  }
  if (typeof rawDisplayName !== 'string') {
    throw new ProviderValidationError('invalid-model-id', '模型显示名称格式不正确')
  }

  const displayName = rawDisplayName.trim()
  if (!displayName) return undefined
  if (displayName.length > MAX_MODEL_DISPLAY_NAME_LENGTH || hasControlCharacters(displayName)) {
    throw new ProviderValidationError('invalid-model-id', '模型显示名称格式不正确')
  }
  return displayName
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127
  })
}
