import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderConnectionTester } from './provider-connection-tester'

interface MockServer {
  baseUrl: string
  server: Server
}

const openServers: Server[] = []

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        })
    )
  )
})

describe('ProviderConnectionTester.listModels', () => {
  it('读取、去重并排序真实模型名称，不添加 Runtime 前缀', async () => {
    let authorization: string | undefined
    const mock = await startMockServer((request, response) => {
      authorization = request.headers.authorization
      expect(request.url).toBe('/v1/models')
      sendJson(response, 200, {
        data: [
          { id: 'model-b', name: '真实模型 B' },
          { id: 'model-a', display_name: '真实模型 A' },
          { id: 'model-a', name: '重复模型名称' }
        ]
      })
    })

    const result = await new ProviderConnectionTester().listModels({
      baseUrl: mock.baseUrl,
      authMode: 'bearer',
      apiKey: 'fake-list-key'
    })

    expect(authorization).toBe('Bearer fake-list-key')
    expect(result).toEqual({
      ok: true,
      stage: 'models',
      message: '已获取 2 个模型',
      models: [
        { modelId: 'model-a', displayName: '真实模型 A' },
        { modelId: 'model-b', displayName: '真实模型 B' }
      ]
    })
    expect(result.models?.some((model) => model.displayName?.includes('Grok ·'))).toBe(false)
  })

  it('禁止自动跟随重定向，避免凭据被带到其他地址', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      expect(init?.redirect).toBe('error')
      return new Response(JSON.stringify({ data: [{ id: 'actual-model-id' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const result = await new ProviderConnectionTester({ fetchImpl }).listModels({
      baseUrl: 'http://api.example.com/v1',
      authMode: 'bearer',
      apiKey: 'fake-redirect-test-key'
    })

    expect(result.ok).toBe(true)
  })

  it('/models 不存在时允许上层切换为手动 Model ID', async () => {
    const mock = await startMockServer((_request, response) => {
      sendJson(response, 404, { error: { message: 'route not found' } })
    })

    const result = await new ProviderConnectionTester().listModels({
      baseUrl: mock.baseUrl,
      authMode: 'none'
    })

    expect(result).toMatchObject({
      ok: false,
      stage: 'models',
      code: 'endpoint-not-found'
    })
    expect(result.message).toContain('手动填写 Model ID')
  })

  it('认证错误先隐藏当前 Key，再交给统一脱敏回调', async () => {
    const fakeKey = 'fake-sensitive-key-123456'
    const mock = await startMockServer((_request, response) => {
      sendJson(response, 401, {
        error: { message: `provider detail: invalid Bearer ${fakeKey}` }
      })
    })
    const redact = vi.fn((text: string) => text.replace('provider detail', '服务详情'))

    const result = await new ProviderConnectionTester({ redact }).listModels({
      baseUrl: mock.baseUrl,
      authMode: 'bearer',
      apiKey: fakeKey
    })

    expect(result.code).toBe('authentication-failed')
    expect(result.message).toContain('服务详情')
    expect(result.message).toContain('[已脱敏]')
    expect(result.message).not.toContain(fakeKey)
    expect(redact).toHaveBeenCalled()
  })

  it('拒绝非标准模型列表结构', async () => {
    const mock = await startMockServer((_request, response) => {
      sendJson(response, 200, { models: [{ id: 'wrong-shape' }] })
    })

    const result = await new ProviderConnectionTester().listModels({
      baseUrl: mock.baseUrl,
      authMode: 'none'
    })

    expect(result).toMatchObject({
      ok: false,
      stage: 'models',
      code: 'invalid-response'
    })
  })
})

describe('ProviderConnectionTester.testInference', () => {
  it('向 /chat/completions 发送实际 modelId 并验证 assistant 内容', async () => {
    let requestBody: Record<string, unknown> | undefined
    let authorization: string | undefined
    const mock = await startMockServer(async (request, response) => {
      authorization = request.headers.authorization
      requestBody = JSON.parse(await readRequestBody(request)) as Record<string, unknown>
      sendJson(response, 200, {
        choices: [{ message: { role: 'assistant', content: 'OK' } }]
      })
    })

    const result = await new ProviderConnectionTester().testInference({
      baseUrl: mock.baseUrl,
      authMode: 'none',
      modelId: 'actual-model-id',
      modelDisplayName: '接口真实名称'
    })

    expect(authorization).toBeUndefined()
    expect(requestBody).toMatchObject({
      model: 'actual-model-id',
      max_tokens: 8,
      stream: false
    })
    expect(result).toEqual({ ok: true, stage: 'inference', message: '模型连接测试成功' })
  })

  it('映射限流错误', async () => {
    const mock = await startMockServer((_request, response) => {
      sendJson(response, 429, { error: { message: 'too many requests' } })
    })

    const result = await new ProviderConnectionTester().testInference({
      baseUrl: mock.baseUrl,
      authMode: 'none',
      modelId: 'actual-model-id'
    })

    expect(result).toMatchObject({ ok: false, stage: 'inference', code: 'rate-limited' })
  })

  it('区分模型不存在和接口不存在', async () => {
    const mock = await startMockServer((_request, response) => {
      sendJson(response, 404, {
        error: { code: 'model_not_found', message: 'model does not exist' }
      })
    })

    const result = await new ProviderConnectionTester().testInference({
      baseUrl: mock.baseUrl,
      authMode: 'none',
      modelId: 'missing-model'
    })

    expect(result.code).toBe('model-not-found')
  })

  it('覆盖响应体读取阶段的超时', async () => {
    const mock = await startMockServer((_request, response) => {
      setTimeout(() => {
        sendJson(response, 200, {
          choices: [{ message: { role: 'assistant', content: 'late' } }]
        })
      }, 80)
    })

    const result = await new ProviderConnectionTester({ timeoutMs: 20 }).testInference({
      baseUrl: mock.baseUrl,
      authMode: 'none',
      modelId: 'slow-model'
    })

    expect(result).toMatchObject({ ok: false, stage: 'inference', code: 'request-timeout' })
  })

  it('拒绝缺少 assistant 内容的成功响应', async () => {
    const mock = await startMockServer((_request, response) => {
      sendJson(response, 200, { choices: [{ message: { role: 'assistant', content: '' } }] })
    })

    const result = await new ProviderConnectionTester().testInference({
      baseUrl: mock.baseUrl,
      authMode: 'none',
      modelId: 'actual-model-id'
    })

    expect(result.code).toBe('invalid-response')
  })

  it('映射底层 TLS 证书错误', async () => {
    const fetchImpl: typeof fetch = async () => {
      const cause = Object.assign(new Error('certificate failed'), {
        code: 'SELF_SIGNED_CERT_IN_CHAIN'
      })
      throw new TypeError('fetch failed', { cause })
    }

    const result = await new ProviderConnectionTester({ fetchImpl }).testInference({
      baseUrl: 'https://api.example.com/v1',
      authMode: 'none',
      modelId: 'actual-model-id'
    })

    expect(result.code).toBe('tls-error')
  })
})

async function startMockServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
): Promise<MockServer> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      sendJson(response, 500, { error: { message: String(error) } })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  openServers.push(server)

  const address = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, server }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed) return
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(payload))
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}
