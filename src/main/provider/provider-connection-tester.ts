import type {
  ProviderConfigInput,
  ProviderConnectionInput,
  ProviderErrorCode,
  ProviderModelOption,
  ProviderTestResult,
  ProviderTestStage
} from '../../shared/provider'
import {
  ProviderValidationError,
  validateProviderConfigInput,
  validateProviderConnectionInput,
  type ValidatedProviderConfigInput,
  type ValidatedProviderConnectionInput
} from './provider-validation'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_RESPONSE_TEXT_LENGTH = 2_000_000
const MAX_ERROR_DETAIL_LENGTH = 500

export type ProviderRedactCallback = (text: string) => string

export interface ProviderConnectionTesterOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  redact?: ProviderRedactCallback
}

interface ProviderResponse {
  response: Response
  bodyText: string
}

interface ServiceErrorDetail {
  code?: string
  message?: string
}

class ProviderRequestError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ProviderRequestError'
  }
}

/**
 * 在主进程中完成 OpenAI Chat Completions 兼容服务的模型发现与最小推理测试。
 * API Key 只进入本次请求 Header，返回结果和异常都会先经过脱敏。
 */
export class ProviderConnectionTester {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly redact: ProviderRedactCallback

  constructor(options: ProviderConnectionTesterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.redact = options.redact ?? ((text) => text)

    if (typeof this.fetchImpl !== 'function') {
      throw new Error('当前环境不支持 fetch')
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('Provider 请求超时时间必须大于 0')
    }
  }

  /** 请求标准 /models 端点，只采用服务端实际返回的模型 ID 和显示名称。 */
  async listModels(rawInput: ProviderConnectionInput): Promise<ProviderTestResult> {
    let input: ValidatedProviderConnectionInput
    try {
      input = validateProviderConnectionInput(rawInput)
    } catch (error) {
      return this.toFailureResult(error, 'validation')
    }

    try {
      const endpoint = `${input.baseUrl}/models`
      const { response, bodyText } = await this.request(endpoint, {
        method: 'GET',
        headers: this.createHeaders(input)
      })

      if (!response.ok) {
        return this.mapHttpFailure(response.status, bodyText, 'models', input.apiKey)
      }

      const models = parseModels(bodyText)
      if (!models.length) {
        throw new ProviderRequestError(
          'invalid-response',
          '模型列表响应中没有有效的 data[].id，可改为手动填写 Model ID'
        )
      }

      return {
        ok: true,
        stage: 'models',
        message: `已获取 ${models.length} 个模型`,
        models
      }
    } catch (error) {
      return this.toFailureResult(error, 'models', input.apiKey)
    }
  }

  /** 使用选定 modelId 发起一次极小的非流式请求，确认基础推理链路真实可用。 */
  async testInference(rawInput: ProviderConfigInput): Promise<ProviderTestResult> {
    let input: ValidatedProviderConfigInput
    try {
      input = validateProviderConfigInput(rawInput)
    } catch (error) {
      return this.toFailureResult(error, 'validation')
    }

    try {
      const endpoint = `${input.baseUrl}/chat/completions`
      const { response, bodyText } = await this.request(endpoint, {
        method: 'POST',
        headers: this.createHeaders(input, true),
        body: JSON.stringify({
          model: input.modelId,
          messages: [{ role: 'user', content: 'Reply with OK.' }],
          max_tokens: 8,
          stream: false
        })
      })

      if (!response.ok) {
        return this.mapHttpFailure(response.status, bodyText, 'inference', input.apiKey)
      }

      if (!extractAssistantContent(bodyText)) {
        throw new ProviderRequestError(
          'invalid-response',
          '推理响应缺少有效的 choices[0].message.content'
        )
      }

      return {
        ok: true,
        stage: 'inference',
        message: '模型连接测试成功'
      }
    } catch (error) {
      return this.toFailureResult(error, 'inference', input.apiKey)
    }
  }

  /** 保留简洁的 test 入口，供 IPC 保存流程直接调用。 */
  test(rawInput: ProviderConfigInput): Promise<ProviderTestResult> {
    return this.testInference(rawInput)
  }

  private createHeaders(
    input: ValidatedProviderConnectionInput,
    includeContentType = false
  ): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (includeContentType) headers['Content-Type'] = 'application/json'
    if (input.authMode === 'bearer' && input.apiKey) {
      headers.Authorization = `Bearer ${input.apiKey}`
    }
    return headers
  }

  /** 超时覆盖连接、响应头和响应体读取，避免只中断连接阶段后继续无限等待。 */
  private async request(endpoint: string, init: RequestInit): Promise<ProviderResponse> {
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)

    try {
      // 禁止自动重定向，避免将 Key 或请求内容静默发送到另一个地址。
      const response = await this.fetchImpl(endpoint, {
        ...init,
        redirect: 'error',
        signal: controller.signal
      })
      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_TEXT_LENGTH) {
        throw new ProviderRequestError('invalid-response', 'Provider 响应体过大')
      }

      const bodyText = await response.text()
      if (bodyText.length > MAX_RESPONSE_TEXT_LENGTH) {
        throw new ProviderRequestError('invalid-response', 'Provider 响应体过大')
      }
      return { response, bodyText }
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error
      if (timedOut || isAbortError(error)) {
        throw new ProviderRequestError('request-timeout', '连接模型服务超时', { cause: error })
      }
      if (isTlsError(error)) {
        throw new ProviderRequestError('tls-error', '模型服务 TLS 连接失败', { cause: error })
      }
      throw new ProviderRequestError('network-error', '无法连接模型服务，请检查地址和网络', {
        cause: error
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  private mapHttpFailure(
    status: number,
    bodyText: string,
    stage: ProviderTestStage,
    apiKey?: string
  ): ProviderTestResult {
    const detail = extractServiceErrorDetail(bodyText)
    const signature = `${detail.code ?? ''} ${detail.message ?? ''}`.toLowerCase()
    let code: ProviderErrorCode
    let message: string

    if (status === 401 || status === 403) {
      code = 'authentication-failed'
      message = '认证失败，请检查 API Key 和服务权限'
    } else if (status === 402 || /quota|billing|credit|balance/.test(signature)) {
      code = 'quota-exceeded'
      message = '模型服务额度不足，请检查余额或计费状态'
    } else if (status === 429) {
      code = 'rate-limited'
      message = '请求过于频繁，请稍后重试'
    } else if (status === 408 || status === 504) {
      code = 'request-timeout'
      message = '模型服务响应超时'
    } else if (
      stage === 'inference' &&
      /model.{0,40}(not[_ -]?found|does not exist|unknown|invalid)|unknown.{0,20}model/.test(
        signature
      )
    ) {
      code = 'model-not-found'
      message = '模型不存在或当前账号无权使用，请检查 Model ID'
    } else if (status === 404) {
      code = 'endpoint-not-found'
      message =
        stage === 'models'
          ? '服务没有提供 /models，可手动填写 Model ID'
          : '未找到 /chat/completions，请检查 Base URL'
    } else if (status >= 500) {
      code = 'server-error'
      message = '模型服务暂时异常，请稍后重试'
    } else {
      code = 'http-error'
      message = `模型服务请求失败（HTTP ${status}）`
    }

    const safeDetail = this.sanitizeExternalDetail(detail.message ?? detail.code, apiKey)
    return {
      ok: false,
      stage,
      code,
      message: safeDetail ? `${message}：${safeDetail}` : message
    }
  }

  private toFailureResult(
    error: unknown,
    stage: ProviderTestStage,
    apiKey?: string
  ): ProviderTestResult {
    if (error instanceof ProviderValidationError) {
      return { ok: false, stage: 'validation', code: error.code, message: error.message }
    }
    if (error instanceof ProviderRequestError) {
      return {
        ok: false,
        stage,
        code: error.code,
        message: this.sanitizeExternalDetail(error.message, apiKey) || '模型服务请求失败'
      }
    }

    return {
      ok: false,
      stage,
      code: 'unknown-error',
      message: this.sanitizeExternalDetail(getErrorMessage(error), apiKey) || '未知错误'
    }
  }

  private sanitizeExternalDetail(rawDetail: string | undefined, apiKey?: string): string {
    if (!rawDetail) return ''

    let safeDetail = rawDetail
    if (apiKey) safeDetail = safeDetail.split(apiKey).join('[已脱敏]')
    safeDetail = redactCommonSecretPatterns(safeDetail)

    try {
      safeDetail = this.redact(safeDetail)
    } catch {
      // 外部脱敏器异常时仍使用本地已脱敏结果，不能让错误处理再次泄漏原文。
    }

    return replaceControlCharacters(safeDetail)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_ERROR_DETAIL_LENGTH)
  }
}

function parseModels(bodyText: string): ProviderModelOption[] {
  const payload = parseJsonObject(bodyText)
  if (!Array.isArray(payload.data)) {
    throw new ProviderRequestError('invalid-response', '模型列表响应必须包含 data 数组')
  }

  const modelsById = new Map<string, ProviderModelOption>()
  for (const item of payload.data) {
    if (!isRecord(item)) continue
    const modelId = readNonEmptyString(item.id)
    if (!modelId) continue

    const displayName =
      readNonEmptyString(item.display_name) ??
      readNonEmptyString(item.displayName) ??
      readNonEmptyString(item.name)
    const current = modelsById.get(modelId)
    if (!current || (!current.displayName && displayName)) {
      modelsById.set(modelId, displayName ? { modelId, displayName } : { modelId })
    }
  }

  return [...modelsById.values()].sort((left, right) => left.modelId.localeCompare(right.modelId))
}

function extractAssistantContent(bodyText: string): string | undefined {
  const payload = parseJsonObject(bodyText)
  if (!Array.isArray(payload.choices) || !isRecord(payload.choices[0])) return undefined
  const message = payload.choices[0].message
  if (!isRecord(message)) return undefined

  if (typeof message.content === 'string') {
    return message.content.trim() || undefined
  }
  if (!Array.isArray(message.content)) return undefined

  const text = message.content
    .map((part) => {
      if (typeof part === 'string') return part
      return isRecord(part) && typeof part.text === 'string' ? part.text : ''
    })
    .join('')
    .trim()
  return text || undefined
}

function parseJsonObject(bodyText: string): Record<string, unknown> {
  let payload: unknown
  try {
    payload = JSON.parse(bodyText)
  } catch {
    throw new ProviderRequestError('invalid-response', 'Provider 返回的不是有效 JSON')
  }
  if (!isRecord(payload)) {
    throw new ProviderRequestError('invalid-response', 'Provider 返回的数据结构不兼容')
  }
  return payload
}

function extractServiceErrorDetail(bodyText: string): ServiceErrorDetail {
  if (!bodyText.trim()) return {}

  try {
    const payload: unknown = JSON.parse(bodyText)
    if (!isRecord(payload)) return {}
    const error = payload.error
    if (typeof error === 'string') return { message: error }
    if (isRecord(error)) {
      return {
        code: readNonEmptyString(error.code) ?? readNonEmptyString(error.type),
        message: readNonEmptyString(error.message)
      }
    }
    return {
      code: readNonEmptyString(payload.code),
      message: readNonEmptyString(payload.message)
    }
  } catch {
    return {}
  }
}

function redactCommonSecretPatterns(text: string): string {
  return text
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [已脱敏]')
    .replace(/\b(?:sk|xai)-[a-z0-9_-]{6,}\b/gi, '[已脱敏]')
    .replace(
      /(["']?(?:api[-_]?key|access[-_]?token|token|secret|password)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      '$1[已脱敏]'
    )
}

function replaceControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 31 || codePoint === 127 ? ' ' : character
    })
    .join('')
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function isTlsError(error: unknown): boolean {
  const tlsCodes = new Set([
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  ])

  let current: unknown = error
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (isRecord(current) && typeof current.code === 'string' && tlsCodes.has(current.code)) {
      return true
    }
    current = isRecord(current) ? current.cause : undefined
  }
  return false
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
