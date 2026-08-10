import { describe, expect, it } from 'vitest'
import {
  ProviderValidationError,
  normalizeProviderBaseUrl,
  validateProviderConfigInput,
  validateProviderConnectionInput
} from './provider-validation'

describe('normalizeProviderBaseUrl', () => {
  it('允许远程 HTTPS 并移除末尾斜杠', () => {
    expect(normalizeProviderBaseUrl('  https://API.Example.com/v1///  ')).toBe(
      'https://api.example.com/v1'
    )
  })

  it.each([
    'http://localhost:11434/v1/',
    'http://127.0.0.1:1234/v1',
    'http://[::1]:8080/v1/',
    'http://192.168.1.10:11434/v1/',
    'http://api.example.com/v1/',
    'http://[2001:db8::10]/v1/'
  ])('允许本机、局域网和公网服务使用 HTTP：%s', (baseUrl) => {
    expect(normalizeProviderBaseUrl(baseUrl)).not.toMatch(/\/$/)
  })

  it('拒绝内嵌账号和密码', () => {
    expectValidationCode(
      () => normalizeProviderBaseUrl('https://user:password@api.example.com/v1'),
      'url-credentials-not-allowed'
    )
  })

  it.each([
    'https://api.example.com/v1?api_key=fake-secret',
    'https://api.example.com/v1#token=fake-secret'
  ])('拒绝 query 或 hash 中可能携带凭据：%s', (baseUrl) => {
    expectValidationCode(() => normalizeProviderBaseUrl(baseUrl), 'url-query-or-hash-not-allowed')
  })

  it('拒绝不支持的协议和控制字符', () => {
    expectValidationCode(
      () => normalizeProviderBaseUrl('ftp://api.example.com/v1'),
      'unsupported-protocol'
    )
    expectValidationCode(
      () => normalizeProviderBaseUrl('https://api.example.com/v1\nmalformed'),
      'invalid-base-url'
    )
  })
})

describe('validateProviderConnectionInput', () => {
  it('Bearer 模式要求非空 Key 并规范化外层空白', () => {
    expect(
      validateProviderConnectionInput({
        baseUrl: 'https://api.example.com/v1/',
        authMode: 'bearer',
        apiKey: '  fake-test-key  '
      })
    ).toEqual({
      baseUrl: 'https://api.example.com/v1',
      authMode: 'bearer',
      apiKey: 'fake-test-key'
    })

    expectValidationCode(
      () =>
        validateProviderConnectionInput({
          baseUrl: 'https://api.example.com/v1',
          authMode: 'bearer',
          apiKey: '   '
        }),
      'api-key-required'
    )
  })

  it('none 模式不发送 Key', () => {
    expect(
      validateProviderConnectionInput({
        baseUrl: 'http://localhost:11434/v1',
        authMode: 'none',
        apiKey: ''
      })
    ).toEqual({ baseUrl: 'http://localhost:11434/v1', authMode: 'none' })

    expectValidationCode(
      () =>
        validateProviderConnectionInput({
          baseUrl: 'http://localhost:11434/v1',
          authMode: 'none',
          apiKey: 'should-not-be-here'
        }),
      'api-key-not-allowed'
    )
  })
})

describe('validateProviderConfigInput', () => {
  it('要求实际 Model ID，并原样保留接口真实显示名称', () => {
    expect(
      validateProviderConfigInput({
        baseUrl: 'https://api.example.com/v1',
        authMode: 'bearer',
        apiKey: 'fake-test-key',
        modelId: '  actual-model-id  ',
        modelDisplayName: '  实际模型名称  '
      })
    ).toMatchObject({
      modelId: 'actual-model-id',
      modelDisplayName: '实际模型名称'
    })

    expectValidationCode(
      () =>
        validateProviderConfigInput({
          baseUrl: 'https://api.example.com/v1',
          authMode: 'bearer',
          apiKey: 'fake-test-key',
          modelId: ''
        }),
      'model-id-required'
    )
  })

  it('拒绝可能破坏请求结构的 Model ID 控制字符', () => {
    expectValidationCode(
      () =>
        validateProviderConfigInput({
          baseUrl: 'https://api.example.com/v1',
          authMode: 'bearer',
          apiKey: 'fake-test-key',
          modelId: 'model\ninvalid'
        }),
      'invalid-model-id'
    )
  })
})

function expectValidationCode(action: () => unknown, expectedCode: string): void {
  try {
    action()
    throw new Error('预期校验失败，但函数成功返回')
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderValidationError)
    expect((error as ProviderValidationError).code).toBe(expectedCode)
  }
}
