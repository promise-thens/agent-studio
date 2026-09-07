import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import type { ProviderRuntimeConfig } from './provider-config-store'
import {
  needsGeminiToolSchemaCompat,
  sanitizeChatCompletionsToolSchemas
} from './gemini-tool-schema-compat'
import { normalizeProviderBaseUrl } from './provider-validation'

const MAX_REQUEST_BODY_BYTES = 2_000_000
const REQUEST_HEADER_ALLOWLIST = new Set(['authorization', 'content-type', 'accept'])
const RESPONSE_HEADER_ALLOWLIST = new Set(['content-type', 'cache-control', 'x-request-id'])

export interface ProviderCompatProxy {
  readonly localBaseUrl: string
  stop(): Promise<void>
}

/**
 * 为 Gemini 把 Grok 的 Base URL 指到本机清洗代理。
 * 真实 URL 仍留在 Provider Store；只有 Runtime 启动配置看到 127.0.0.1。
 */
export async function bindGeminiCompatRuntimeConfig(
  config: ProviderRuntimeConfig
): Promise<{ runtimeConfig: ProviderRuntimeConfig; proxy: ProviderCompatProxy | null }> {
  if (!needsGeminiToolSchemaCompat(config.modelId)) {
    return { runtimeConfig: config, proxy: null }
  }
  const proxy = await startProviderCompatProxy({ upstreamBaseUrl: config.baseUrl })
  return {
    runtimeConfig: { ...config, baseUrl: proxy.localBaseUrl },
    proxy
  }
}

/**
 * 本机反向代理：Grok 把 Chat Completions 打到 127.0.0.1，桌面清掉空 enum 再转发真实 Provider。
 * 只绑定回环地址，路径带一次性 token，禁止跟随重定向，避免把 Key 送到别的 origin。
 */
export async function startProviderCompatProxy(options: {
  upstreamBaseUrl: string
  fetchImpl?: typeof fetch
}): Promise<ProviderCompatProxy> {
  const upstreamBaseUrl = normalizeProviderBaseUrl(options.upstreamBaseUrl)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const token = randomBytes(16).toString('hex')
  const upstream = new URL(upstreamBaseUrl)
  const prefix = `/c/${token}`

  const server = createServer((request, response) => {
    void handleCompatProxyRequest({
      request,
      response,
      prefix,
      token,
      upstream,
      fetchImpl
    }).catch(() => {
      writeProxyError(response, 502, '上游请求失败')
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('兼容代理未能绑定本机端口')
  }

  return {
    localBaseUrl: `http://127.0.0.1:${(address as AddressInfo).port}${prefix}${upstream.pathname}`,
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
  }
}

async function handleCompatProxyRequest(input: {
  request: IncomingMessage
  response: ServerResponse
  prefix: string
  token: string
  upstream: URL
  fetchImpl: typeof fetch
}): Promise<void> {
  const requestUrl = input.request.url ?? '/'
  const pathToken = extractPathToken(requestUrl)
  if (!pathToken || !tokensEqual(pathToken, input.token)) {
    writeProxyError(input.response, 404, 'Not found')
    return
  }

  const upstreamUrl = resolveUpstreamUrl(requestUrl, input.prefix, input.upstream)
  if (!upstreamUrl) {
    writeProxyError(input.response, 404, 'Not found')
    return
  }

  const method = (input.request.method ?? 'GET').toUpperCase()
  let body: Buffer | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      body = maybeSanitizeBody(
        upstreamUrl.pathname,
        method,
        await readLimitedBody(input.request, MAX_REQUEST_BODY_BYTES),
        headerValue(input.request.headers['content-type'])
      )
    } catch (error) {
      if (error instanceof RequestTooLargeError) {
        writeProxyError(input.response, 413, '请求体过大')
        return
      }
      throw error
    }
  }

  const abort = new AbortController()
  input.request.on('aborted', () => abort.abort())
  const upstreamResponse = await input.fetchImpl(upstreamUrl, {
    method,
    headers: collectRequestHeaders(input.request, input.upstream.host),
    // fetch 的 BodyInit 不收 Node Buffer 类型，转成 Uint8Array 再转发。
    body: body ? new Uint8Array(body) : undefined,
    redirect: 'error',
    signal: abort.signal
  })

  if (input.response.destroyed || input.response.writableEnded) return
  input.response.writeHead(
    upstreamResponse.status,
    collectResponseHeaders(upstreamResponse.headers)
  )
  if (!upstreamResponse.body) {
    input.response.end()
    return
  }

  await new Promise<void>((resolve, reject) => {
    const nodeStream = Readable.fromWeb(upstreamResponse.body as never)
    nodeStream.on('error', reject)
    input.response.on('error', reject)
    nodeStream.on('end', () => resolve())
    nodeStream.pipe(input.response)
  })
}

function extractPathToken(requestUrl: string): string | null {
  const path = requestUrl.split('?')[0] ?? ''
  if (!path.startsWith('/c/')) return null
  const rest = path.slice(3)
  const slash = rest.indexOf('/')
  const token = slash === -1 ? rest : rest.slice(0, slash)
  return token || null
}

function tokensEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left)
  const rightBuf = Buffer.from(right)
  if (leftBuf.length !== rightBuf.length) return false
  return timingSafeEqual(leftBuf, rightBuf)
}

/** 把 `/c/<token>` 后面的路径接到真实 origin，拒绝 protocol-relative 和跨 origin。 */
function resolveUpstreamUrl(requestUrl: string, prefix: string, upstream: URL): URL | null {
  const [path, query] = splitPathAndQuery(requestUrl)
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return null
  const rest = path === prefix ? '/' : path.slice(prefix.length)
  if (!rest.startsWith('/') || rest.startsWith('//')) return null
  const forwarded = new URL(rest, upstream.origin)
  if (forwarded.origin !== upstream.origin) return null
  if (query) forwarded.search = query
  return forwarded
}

function splitPathAndQuery(requestUrl: string): [string, string | undefined] {
  const queryIndex = requestUrl.indexOf('?')
  if (queryIndex < 0) return [requestUrl, undefined]
  return [requestUrl.slice(0, queryIndex), requestUrl.slice(queryIndex + 1)]
}

function maybeSanitizeBody(
  pathname: string,
  method: string,
  raw: Buffer,
  contentType: string | undefined
): Buffer {
  if (method !== 'POST' || !pathname.endsWith('/chat/completions')) return raw
  if (!contentType?.toLowerCase().includes('application/json')) return raw
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'))
    return Buffer.from(JSON.stringify(sanitizeChatCompletionsToolSchemas(parsed)), 'utf8')
  } catch {
    return raw
  }
}

function collectRequestHeaders(request: IncomingMessage, upstreamHost: string): Headers {
  const headers = new Headers()
  headers.set('Host', upstreamHost)
  for (const [name, value] of Object.entries(request.headers)) {
    if (!REQUEST_HEADER_ALLOWLIST.has(name.toLowerCase()) || typeof value !== 'string') continue
    headers.set(name, value)
  }
  return headers
}

function collectResponseHeaders(headers: Headers): Record<string, string> {
  const collected: Record<string, string> = {}
  for (const [name, value] of headers.entries()) {
    if (!RESPONSE_HEADER_ALLOWLIST.has(name.toLowerCase())) continue
    collected[name] = value
  }
  return collected
}

async function readLimitedBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > maxBytes) throw new RequestTooLargeError()
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

function writeProxyError(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed || response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ error: { message } }))
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

class RequestTooLargeError extends Error {
  constructor() {
    super('request too large')
    this.name = 'RequestTooLargeError'
  }
}
