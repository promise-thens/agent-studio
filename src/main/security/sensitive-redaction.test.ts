import { describe, expect, it } from 'vitest'
import { REDACTED_VALUE, redactSensitiveError, redactSensitiveText } from './sensitive-redaction'

describe('redactSensitiveText', () => {
  it('脱敏当前已知密钥及其 URL 编码形式', () => {
    const apiKey = 'fake key/with+symbols'
    const input = `key=${apiKey}; encoded=${encodeURIComponent(apiKey)}`

    const result = redactSensitiveText(input, [apiKey])

    expect(result).not.toContain(apiKey)
    expect(result).not.toContain(encodeURIComponent(apiKey))
    expect(result.match(/\[REDACTED\]/g)).toHaveLength(2)
  })

  it('脱敏 Bearer Authorization Header', () => {
    const result = redactSensitiveText(
      'Authorization: Bearer fake-bearer-token; authorization="Bearer another-token"'
    )

    expect(result).toBe(
      `Authorization: Bearer ${REDACTED_VALUE}; authorization="Bearer ${REDACTED_VALUE}"`
    )
  })

  it('脱敏常见 API Key Header 和敏感对象字段', () => {
    const result = redactSensitiveText(
      'api-key: fake-one, "x-api-key":"fake-two", access_token=fake-three'
    )

    expect(result).toBe(
      `api-key: ${REDACTED_VALUE}, "x-api-key":"${REDACTED_VALUE}", access_token=${REDACTED_VALUE}`
    )
  })

  it('脱敏 URL query、hash 和内嵌账号凭据', () => {
    const result = redactSensitiveText(
      'https://user:fake-password@example.com/v1?api_key=fake-query&model=real-model#token=fake-hash'
    )

    expect(result).toBe(
      `https://${REDACTED_VALUE}@example.com/v1?api_key=${REDACTED_VALUE}&model=real-model#token=${REDACTED_VALUE}`
    )
  })

  it('不修改不含敏感信息的模型与错误说明', () => {
    const input = 'modelId=gpt-5-mini, request failed with status 429'

    expect(redactSensitiveText(input)).toBe(input)
  })
})

describe('redactSensitiveError', () => {
  it('只输出异常消息并移除其中的密钥', () => {
    const error = new Error('request failed with Bearer fake-secret-value')
    error.stack = 'stack contains implementation details'

    const result = redactSensitiveError(error)

    expect(result).toBe(`request failed with Bearer ${REDACTED_VALUE}`)
    expect(result).not.toContain('stack')
    expect(result).not.toContain('fake-secret-value')
  })

  it('循环对象不会导致脱敏流程再次抛错', () => {
    const circular: { self?: unknown } = {}
    circular.self = circular

    expect(redactSensitiveError(circular)).toBe('发生了无法序列化的内部错误。')
  })
})
