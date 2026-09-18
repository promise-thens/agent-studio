import { createConnection } from 'node:net'
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import {
  CHROME_NATIVE_MAX_FRAME_BYTES,
  parseChromeNativeFrameLength,
  parseChromeNativeRequest
} from '../../../shared/chrome-native-bridge'

export interface ChromeNativeHostStdioOptions {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  handle: (request: unknown) => Promise<unknown>
}

/**
 * 把 JSON 编成 Chrome Native Messaging 帧：4 字节小端长度 + UTF-8。
 * 响应也受 1MiB 上限约束，避免 stdio 进程被超大回包拖死。
 */
export function encodeChromeNativeFrame(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8')
  if (json.length > CHROME_NATIVE_MAX_FRAME_BYTES) {
    throw new Error('Native Host 响应超过单帧上限。')
  }
  const header = Buffer.alloc(4)
  header.writeUInt32LE(json.length, 0)
  return Buffer.concat([header, json])
}

/**
 * stdin 长度帧循环。超长帧回错误对象且不调用 handle，未知 command 由 handle 返回错误对象。
 * 本进程是 ELECTRON_RUN_AS_NODE 拉起的 Node，没有 session，不能直接写 Cookie。
 */
export function runChromeNativeHostStdio(options: ChromeNativeHostStdioOptions): () => void {
  let buffer = Buffer.alloc(0)
  let rejected = false
  let pumping = false

  const pump = async (): Promise<void> => {
    if (pumping || rejected) return
    pumping = true
    try {
      for (;;) {
        if (rejected) return
        if (buffer.length < 4) return
        const lengthResult = parseChromeNativeFrameLength(buffer.subarray(0, 4))
        if (!lengthResult.ok) {
          if (lengthResult.code === 'incomplete') return
          rejected = true
          options.stdout.write(
            encodeChromeNativeFrame({
              id: '',
              ok: false,
              error: { code: 'frame-too-large', message: 'Native Host 帧超过上限。' }
            })
          )
          return
        }
        if (buffer.length < 4 + lengthResult.length) return
        const body = buffer.subarray(4, 4 + lengthResult.length)
        buffer = buffer.subarray(4 + lengthResult.length)
        let request: unknown
        try {
          request = JSON.parse(body.toString('utf8'))
        } catch {
          options.stdout.write(
            encodeChromeNativeFrame({
              id: '',
              ok: false,
              error: { code: 'invalid-request', message: 'Native Host 请求无效。' }
            })
          )
          continue
        }
        const response = await options.handle(request)
        options.stdout.write(encodeChromeNativeFrame(response))
      }
    } finally {
      pumping = false
    }
  }

  const onData = (chunk: Buffer | string): void => {
    if (rejected) return
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    void pump()
  }
  options.stdin.on('data', onData)
  return () => {
    options.stdin.off('data', onData)
  }
}

/** 经本机 socket 把已解析请求转到主进程；token 错了由对端断连。 */
export function callChromeNativeHostOverSocket(
  socketPath: string,
  token: string,
  request: unknown
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
    const timer = setTimeout(() => finish(new Error('chrome-native-host-timeout')), 30_000)
    let buffer = ''
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ token, request })}\n`)
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      try {
        const parsed = JSON.parse(buffer.slice(0, newline)) as { result?: unknown }
        finish(null, parsed.result)
      } catch (error) {
        finish(error instanceof Error ? error : new Error('chrome-native-host-parse'))
      }
    })
    socket.on('close', () => finish(new Error('chrome-native-host-closed')))
    socket.on('error', (error) => finish(error))
  })
}

export function shouldRunChromeNativeHostStdioMain(argv1 = process.argv[1]): boolean {
  return typeof argv1 === 'string' && argv1.includes('chrome-native-host-stdio')
}

/**
 * 只认本次包装钉死的状态文件，禁止 -dev json 能 parse 就抢走正式包 socket。
 * SOCKET+TOKEN 仍可覆盖，供测试直连；STATE 指向哪份 json 就只读哪份。
 * 缺 STATE 或该文件不可读时不得回落到另一身份，Cookie 不能写进另一份 partition。
 * 只读 Agent Studio 自己的 json，不打开 Chrome Profile。
 */
export function resolveChromeNativeHostBridge(
  env: NodeJS.ProcessEnv = process.env
): { socketPath: string; token: string } | null {
  const socketFromEnv = env.AGENT_STUDIO_CHROME_NATIVE_SOCKET
  const tokenFromEnv = env.AGENT_STUDIO_CHROME_NATIVE_TOKEN
  if (socketFromEnv && tokenFromEnv) {
    return { socketPath: socketFromEnv, token: tokenFromEnv }
  }
  const statePath = env.AGENT_STUDIO_CHROME_NATIVE_STATE
  if (
    typeof statePath !== 'string' ||
    statePath.trim() === '' ||
    statePath.includes('\0') ||
    !isAbsolute(statePath)
  ) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as {
      socketPath?: unknown
      token?: unknown
    }
    if (typeof parsed.socketPath === 'string' && typeof parsed.token === 'string') {
      return { socketPath: parsed.socketPath, token: parsed.token }
    }
  } catch {
    return null
  }
  return null
}

function main(): void {
  const bridge = resolveChromeNativeHostBridge()
  runChromeNativeHostStdio({
    stdin: process.stdin,
    stdout: process.stdout,
    handle: async (request) => {
      const parsed = parseChromeNativeRequest(request)
      const id = parsed.ok ? parsed.request.id : (parsed.id ?? '')
      if (!bridge) {
        return {
          id,
          ok: false,
          error: { code: 'desktop-not-running', message: 'Agent Studio 未运行。' }
        }
      }
      return callChromeNativeHostOverSocket(bridge.socketPath, bridge.token, request)
    }
  })
}

if (shouldRunChromeNativeHostStdioMain()) {
  main()
}
