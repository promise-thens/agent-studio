import { createConnection } from 'node:net'
import { HOST_BROWSER_ACTION_NAMES } from '../../shared/host-browser'
import { HOST_BROWSER_MCP_SERVER_NAME } from './host-browser-mcp'

export interface HostBrowserMcpStdioOptions {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
}

const PROTOCOL_VERSION = '2024-11-05'

/**
 * 最小 JSON-RPC MCP：只实现 initialize / tools/list / tools/call。
 * 不引入 MCP SDK，不把 Electron 或密钥环境带进这个进程。
 */
export function runHostBrowserMcpStdio(options: HostBrowserMcpStdioOptions): () => void {
  let buffer = ''
  const onData = (chunk: Buffer | string): void => {
    buffer += String(chunk)
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) void handleLine(line, options)
      newline = buffer.indexOf('\n')
    }
  }
  options.stdin.on('data', onData)
  return () => {
    options.stdin.off('data', onData)
  }
}

async function handleLine(line: string, options: HostBrowserMcpStdioOptions): Promise<void> {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (!isRecord(message) || message.jsonrpc !== '2.0') return
  if (typeof message.method === 'string' && message.id === undefined) return
  if (typeof message.method !== 'string' || message.id === undefined) return
  const response = await dispatch(message.method, message.params, message.id, options.callTool)
  options.stdout.write(`${JSON.stringify(response)}\n`)
}

async function dispatch(
  method: string,
  params: unknown,
  id: unknown,
  callTool: HostBrowserMcpStdioOptions['callTool']
): Promise<unknown> {
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: HOST_BROWSER_MCP_SERVER_NAME, version: '0.1.0' }
      }
    }
  }
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: HOST_BROWSER_ACTION_NAMES.map(toTool) }
    }
  }
  if (method === 'tools/call') {
    const name = isRecord(params) && typeof params.name === 'string' ? params.name : ''
    const args = isRecord(params) && isRecord(params.arguments) ? params.arguments : {}
    if (!HOST_BROWSER_ACTION_NAMES.includes(name as (typeof HOST_BROWSER_ACTION_NAMES)[number])) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: unsupportedToolMessage(name) }]
        }
      }
    }
    try {
      const value = await callTool(name, args)
      return { jsonrpc: '2.0', id, result: toCallResult(value) }
    } catch {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: '浏览器动作失败。' }]
        }
      }
    }
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: 'Method not found' }
  }
}

function toTool(name: (typeof HOST_BROWSER_ACTION_NAMES)[number]): {
  name: string
  description: string
  inputSchema: Record<string, unknown>
} {
  return {
    name,
    description: toolDescription(name),
    inputSchema: toolSchema(name)
  }
}

/**
 * 工具说明必须写清坐标空间，否则模型会去调不存在的 evaluate / Playwright 名。
 */
function toolDescription(name: (typeof HOST_BROWSER_ACTION_NAMES)[number]): string {
  if (name === 'browser_click') {
    return 'Click a snapshot node by ref. If the node has x,y,width,height, always use this instead of click_xy. Does not run JavaScript.'
  }
  if (name === 'browser_click_xy' || name === 'browser_click_at') {
    return 'Last-resort click at latest screenshot PNG pixels (1 pixel = 1 CSS). Only iframe/canvas or when snapshot has no option. Do not OCR, do not use Python/PIL, do not use 0-1000. Does not run JavaScript.'
  }
  if (name === 'browser_snapshot') {
    return 'Accessibility snapshot with viewport CSS box x,y,width,height. After opening a dropdown or dialog, snapshot again then browser_click(ref). Prefer this over screenshot. Cross-origin iframe internals may be missing.'
  }
  if (name === 'browser_screenshot') {
    return 'PNG of the built-in page (CSS pixels). Confirm once after a batch, do not screenshot every step, do not compute click coordinates from the image. Text includes viewportWidth/Height.'
  }
  return 'Operate the built-in browser the user is looking at in Agent Studio.'
}

/** Grok 常猜 evaluate；点名拒绝并指向坐标点击，避免它反复发明脚本工具。 */
function unsupportedToolMessage(name: string): string {
  if (
    name === 'browser_evaluate' ||
    name === 'evaluate' ||
    name === 'evaluate_script' ||
    name === 'Runtime.evaluate' ||
    name === 'browser_run_javascript'
  ) {
    return '内置浏览器不允许执行 JavaScript。请优先 browser_click（snapshot ref，看节点 x/y/width/height），iframe 再 browser_click_xy。'
  }
  return '不支持该浏览器动作。'
}

function toolSchema(name: (typeof HOST_BROWSER_ACTION_NAMES)[number]): Record<string, unknown> {
  if (name === 'browser_navigate' || name === 'browser_tabs_open') {
    return {
      type: 'object',
      properties: { url: { type: 'string' } },
      additionalProperties: false
    }
  }
  if (name === 'browser_tabs_select' || name === 'browser_tabs_close') {
    return {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
      additionalProperties: false
    }
  }
  if (name === 'browser_click') {
    return {
      type: 'object',
      properties: { ref: { type: 'string' } },
      required: ['ref'],
      additionalProperties: false
    }
  }
  if (name === 'browser_click_xy' || name === 'browser_click_at') {
    return {
      type: 'object',
      properties: {
        x: {
          type: 'number',
          description:
            'Viewport CSS X of the built-in page (0 <= x <= viewportWidth). Do not use normalized 0-1000 or global desktop coordinates.'
        },
        y: {
          type: 'number',
          description:
            'Viewport CSS Y of the built-in page (0 <= y <= viewportHeight). Do not use normalized 0-1000 or global desktop coordinates.'
        }
      },
      required: ['x', 'y'],
      additionalProperties: false
    }
  }
  if (name === 'browser_type') {
    return {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        text: { type: 'string' },
        submit: { type: 'boolean' }
      },
      required: ['ref', 'text'],
      additionalProperties: false
    }
  }
  if (name === 'browser_scroll') {
    return {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'integer' }
      },
      required: ['direction'],
      additionalProperties: false
    }
  }
  return { type: 'object', properties: {}, additionalProperties: false }
}

function toCallResult(value: unknown): { content: unknown[]; isError?: true } {
  if (isRecord(value) && value.ok === false) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ ok: false }) }]
    }
  }
  if (
    isRecord(value) &&
    value.ok === true &&
    isRecord(value.data) &&
    value.data.kind === 'screenshot' &&
    Buffer.isBuffer(value.data.bytes)
  ) {
    const meta: Record<string, unknown> = { kind: 'screenshot' }
    if (typeof value.data.viewportWidth === 'number') meta.viewportWidth = value.data.viewportWidth
    if (typeof value.data.viewportHeight === 'number')
      meta.viewportHeight = value.data.viewportHeight
    return {
      content: [
        { type: 'text', text: JSON.stringify(meta) },
        {
          type: 'image',
          mimeType: 'image/png',
          data: value.data.bytes.toString('base64')
        }
      ]
    }
  }
  return { content: [{ type: 'text', text: JSON.stringify(omitViewportCoordinates(value)) }] }
}

/**
 * MCP 文本不得出现 viewport 坐标，避免进模型上下文、Timeline 或日志。
 */
function omitViewportCoordinates(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitViewportCoordinates)
  if (!isRecord(value)) return value
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'viewportX' || key === 'viewportY') continue
    next[key] = omitViewportCoordinates(item)
  }
  return next
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 经本机 socket 把 tools/call 转到主进程；token 错了由对端断连。 */
export function callHostBrowserToolOverSocket(
  socketPath: string,
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let settled = false
    const finish = (error: Error | null, value?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('browser-socket-timeout')), 30_000)
    let buffer = ''
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ token, id: 1, action: { name, arguments: args } })}\n`)
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      try {
        const parsed = JSON.parse(buffer.slice(0, newline)) as { result?: unknown }
        finish(null, parsed.result)
      } catch (error) {
        finish(error instanceof Error ? error : new Error('browser-socket-parse'))
      }
    })
    socket.on('close', () => finish(new Error('browser-socket-closed')))
    socket.on('error', (error) => finish(error))
  })
}

export function shouldRunMcpStdioMain(argv1 = process.argv[1]): boolean {
  return typeof argv1 === 'string' && argv1.includes('host-browser-mcp-stdio')
}

function main(): void {
  const socketPath = process.env.AGENT_STUDIO_BROWSER_SOCKET
  const token = process.env.AGENT_STUDIO_BROWSER_TOKEN
  if (!socketPath || !token) {
    process.stderr.write('missing browser socket env\n')
    process.exit(1)
  }
  runHostBrowserMcpStdio({
    stdin: process.stdin,
    stdout: process.stdout,
    callTool: (name, args) => callHostBrowserToolOverSocket(socketPath, token, name, args)
  })
}

if (shouldRunMcpStdioMain()) {
  main()
}
