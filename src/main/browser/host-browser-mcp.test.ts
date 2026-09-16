import { createConnection, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOST_BROWSER_ACTION_NAMES } from '../../shared/host-browser'
import {
  appendHostBrowserMcpServer,
  HOST_BROWSER_MCP_SERVER_NAME,
  type HostBrowserMcpInjection
} from './host-browser-mcp'
import { HostBrowserMcpGateway } from './host-browser-mcp-gateway'
import { runHostBrowserMcpStdio } from './host-browser-mcp-stdio'

function injection(overrides: Partial<HostBrowserMcpInjection> = {}): HostBrowserMcpInjection {
  return {
    execPath: '/Applications/Agent Studio.app/Contents/MacOS/Agent Studio',
    scriptPath: '/tmp/host-browser-mcp-stdio.js',
    socketPath: '/tmp/as-browser.sock',
    token: 'token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    pathEnv: '/usr/bin',
    ...overrides
  }
}

async function readLines(stream: PassThrough, count: number): Promise<string[]> {
  const lines: string[] = []
  let buffer = ''
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 MCP 输出超时')), 2000)
    stream.on('data', (chunk: Buffer | string) => {
      buffer += String(chunk)
      let newline = buffer.indexOf('\n')
      while (newline !== -1 && lines.length < count) {
        lines.push(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      if (lines.length >= count) {
        clearTimeout(timer)
        resolve(lines)
      }
    })
  })
}

describe('appendHostBrowserMcpServer', () => {
  it('关闭或脚本缺失时不注入，用户 MCP 原样保留', () => {
    const user = [
      {
        name: 'docs',
        transport: 'stdio' as const,
        command: '/usr/bin/python3',
        args: ['-m', 'server'],
        env: [{ name: 'FOO', value: '1' }]
      }
    ]
    expect(appendHostBrowserMcpServer(user, null)).toEqual({ servers: user, conflict: false })
  })

  it('开启时追加 agent-studio-browser，env 只有 socket/token/ELECTRON_RUN_AS_NODE 和可选 PATH', () => {
    const user = [
      {
        name: 'docs',
        transport: 'stdio' as const,
        command: '/usr/bin/python3',
        args: [],
        env: []
      }
    ]
    const { servers, conflict } = appendHostBrowserMcpServer(user, injection())
    expect(conflict).toBe(false)
    expect(servers.map((server) => server.name)).toEqual(['docs', HOST_BROWSER_MCP_SERVER_NAME])
    const host = servers[1]
    expect(host).toMatchObject({
      name: HOST_BROWSER_MCP_SERVER_NAME,
      transport: 'stdio',
      command: '/Applications/Agent Studio.app/Contents/MacOS/Agent Studio',
      args: ['/tmp/host-browser-mcp-stdio.js']
    })
    expect(host?.env?.map((entry) => entry.name).sort()).toEqual([
      'AGENT_STUDIO_BROWSER_SOCKET',
      'AGENT_STUDIO_BROWSER_TOKEN',
      'ELECTRON_RUN_AS_NODE',
      'PATH'
    ])
    expect(
      host?.env?.some((entry) => entry.name.includes('API_KEY') || entry.value.includes('sk-'))
    ).toBe(false)
  })

  it('用户 MCP 撞名时宿主优先，不静默覆盖成用户项', () => {
    const user = [
      {
        name: HOST_BROWSER_MCP_SERVER_NAME,
        transport: 'stdio' as const,
        command: '/usr/bin/evil',
        args: [],
        env: [{ name: 'AGENT_STUDIO_MODEL_API_KEY', value: 'sk-secret' }]
      }
    ]
    const { servers, conflict } = appendHostBrowserMcpServer(user, injection())
    expect(conflict).toBe(true)
    expect(servers).toHaveLength(1)
    expect(servers[0]?.command).not.toBe('/usr/bin/evil')
    expect(JSON.stringify(servers)).not.toContain('sk-secret')
    expect(servers[0]?.command).toBe('/Applications/Agent Studio.app/Contents/MacOS/Agent Studio')
  })
})

describe('host-browser MCP stdio', () => {
  it('initialize → tools/list → tools/call browser_navigate', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const calls: Array<{ name: string; args: unknown }> = []
    const stop = runHostBrowserMcpStdio({
      stdin,
      stdout,
      callTool: async (name, args) => {
        calls.push({ name, args })
        return { ok: true, data: { kind: 'navigated', url: 'https://example.com/' } }
      }
    })

    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' }
        }
      })}\n`
    )
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'browser_navigate', arguments: { url: 'https://example.com' } }
      })}\n`
    )

    const lines = await readLines(stdout, 3)
    stop()
    const initialize = JSON.parse(lines[0] ?? '{}') as {
      result?: { serverInfo?: { name?: string }; capabilities?: { tools?: unknown } }
    }
    const listed = JSON.parse(lines[1] ?? '{}') as { result?: { tools?: Array<{ name: string }> } }
    const called = JSON.parse(lines[2] ?? '{}') as {
      result?: { isError?: boolean; content?: unknown }
    }
    expect(initialize.result?.serverInfo?.name).toBe(HOST_BROWSER_MCP_SERVER_NAME)
    expect(initialize.result?.capabilities?.tools).toEqual({})
    expect(listed.result?.tools?.map((tool) => tool.name)).toEqual([...HOST_BROWSER_ACTION_NAMES])
    expect(calls).toEqual([{ name: 'browser_navigate', args: { url: 'https://example.com' } }])
    expect(called.result?.isError).not.toBe(true)
  })

  it('tools/call 不得把 viewport 坐标写进 MCP 回包', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stop = runHostBrowserMcpStdio({
      stdin,
      stdout,
      callTool: async () => ({
        ok: true,
        data: { kind: 'clicked', viewportX: 10, viewportY: 10 }
      })
    })
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'browser_click', arguments: { ref: 'e1' } }
      })}\n`
    )
    const lines = await readLines(stdout, 1)
    stop()
    const raw = lines[0] ?? ''
    expect(raw).not.toContain('viewportX')
    expect(raw).not.toContain('viewportY')
    const called = JSON.parse(raw) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> }
    }
    expect(called.result?.isError).not.toBe(true)
    expect(called.result?.content?.[0]?.text).toContain('clicked')
  })
})

describe('HostBrowserMcpGateway', () => {
  it('无 token 或错误 token 的连接立即断开，且不得执行动作', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'as-hb-mcp-'))
    const socketPath = join(dir, 'b.sock')
    const performed: unknown[] = []
    const gateway = new HostBrowserMcpGateway({
      perform: async (taskId, action) => {
        performed.push({ taskId, action })
        return { ok: true, data: { kind: 'ok' } }
      }
    })
    await gateway.listen(socketPath)
    gateway.bind('good-token-aaaaaaaaaaaaaaaaaaaaaaaa', 'task-1')

    await expect(
      writeAndWaitClose(socketPath, { id: 1, action: { name: 'browser_navigate' } })
    ).resolves.toBe(true)
    await expect(
      writeAndWaitClose(socketPath, {
        token: 'bad-token-bbbbbbbbbbbbbbbbbbbbbbbb',
        id: 1,
        action: { name: 'browser_navigate', arguments: { url: 'https://example.com' } }
      })
    ).resolves.toBe(true)
    expect(performed).toEqual([])
    await gateway.close()
  })
})

function writeAndWaitClose(socketPath: string, payload: unknown): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('socket 未断开'))
    }, 2000)
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(true)
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
