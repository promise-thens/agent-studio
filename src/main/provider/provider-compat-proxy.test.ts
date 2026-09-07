import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startProviderCompatProxy, type ProviderCompatProxy } from './provider-compat-proxy'

const openServers: Server[] = []
const openProxies: ProviderCompatProxy[] = []

afterEach(async () => {
  await Promise.all(openProxies.splice(0).map((proxy) => proxy.stop()))
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

describe('startProviderCompatProxy', () => {
  it('转发 /chat/completions 前去掉会让 Gemini 400 的空 enum', async () => {
    let upstreamBody: Record<string, unknown> | undefined
    let authorization: string | undefined
    const upstream = await startUpstream(async (request, response) => {
      authorization = request.headers.authorization
      expect(request.url).toBe('/v1/chat/completions')
      upstreamBody = JSON.parse(await readRequestBody(request)) as Record<string, unknown>
      sendJson(response, 200, { choices: [{ message: { content: 'ok' } }] })
    })
    const proxy = await startTrackedProxy(upstream.baseUrl)

    const response = await fetch(`${proxy.localBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer fake-compat-key',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gemini-3-flash',
        tools: [
          {
            type: 'function',
            function: {
              name: 'todo_write',
              parameters: {
                properties: {
                  status: { enum: ['pending', null, ''] }
                }
              }
            }
          }
        ]
      })
    })

    expect(response.ok).toBe(true)
    expect(authorization).toBe('Bearer fake-compat-key')
    expect(upstreamBody).toMatchObject({
      model: 'gemini-3-flash',
      tools: [
        {
          function: {
            parameters: {
              properties: {
                status: { enum: ['pending'] }
              }
            }
          }
        }
      ]
    })
  })

  it('GET /models 原样转发，错误 token 不得打到上游', async () => {
    let modelsHits = 0
    const upstream = await startUpstream((_request, response) => {
      modelsHits += 1
      sendJson(response, 200, { data: [{ id: 'gemini-3-flash' }] })
    })
    const proxy = await startTrackedProxy(upstream.baseUrl)

    const models = await fetch(`${proxy.localBaseUrl}/models`)
    expect(models.ok).toBe(true)
    expect(await models.json()).toEqual({ data: [{ id: 'gemini-3-flash' }] })
    expect(modelsHits).toBe(1)

    const forged = proxy.localBaseUrl.replace(/\/c\/[^/]+\//, '/c/forged-token/')
    const blocked = await fetch(`${forged}/models`)
    expect(blocked.status).toBe(404)
    expect(modelsHits).toBe(1)
  })

  it('流式响应按块转发，且不跟随上游重定向', async () => {
    const upstream = await startUpstream((request, response) => {
      if (request.url === '/v1/redirect') {
        response.writeHead(302, { Location: 'https://hostile.example/steal' })
        response.end()
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: one\n\n')
      response.write('data: two\n\n')
      response.end()
    })
    const proxy = await startTrackedProxy(upstream.baseUrl)

    const stream = await fetch(`${proxy.localBaseUrl}/stream`)
    expect(await stream.text()).toBe('data: one\n\ndata: two\n\n')

    const redirected = await fetch(`${proxy.localBaseUrl}/redirect`)
    expect(redirected.status).toBe(502)
    expect(await redirected.text()).not.toContain('hostile.example')
  })
})

async function startTrackedProxy(upstreamBaseUrl: string): Promise<ProviderCompatProxy> {
  const proxy = await startProviderCompatProxy({ upstreamBaseUrl })
  openProxies.push(proxy)
  return proxy
}

async function startUpstream(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
): Promise<{ baseUrl: string }> {
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
  return { baseUrl: `http://127.0.0.1:${address.port}/v1` }
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
