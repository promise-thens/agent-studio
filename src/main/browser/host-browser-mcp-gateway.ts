import { createHash, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import type { HostBrowserActionResult } from './host-browser-actions'

export interface HostBrowserMcpGatewayDependencies {
  perform: (taskId: string, action: unknown) => Promise<HostBrowserActionResult>
}

/**
 * 本机 socket：MCP 子进程只拿路径和一次性 token。
 * 错误 token 直接断开，避免未授权调用落到 perform。
 */
export class HostBrowserMcpGateway {
  private server: Server | null = null
  private socketPath: string | null = null
  private token = ''
  private taskId = ''
  private readonly sockets = new Set<Socket>()

  constructor(private readonly dependencies: HostBrowserMcpGatewayDependencies) {}

  async listen(socketPath: string): Promise<void> {
    if (this.server && this.socketPath === socketPath) return
    await this.close()
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
    await unlink(socketPath).catch(() => undefined)
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.accept(socket))
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        this.server = server
        this.socketPath = socketPath
        resolve()
      })
    })
    await chmod(socketPath, 0o600).catch(() => undefined)
  }

  bind(token: string, taskId: string): void {
    this.token = token
    this.taskId = taskId
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    const socketPath = this.socketPath
    this.server = null
    this.socketPath = null
    this.token = ''
    this.taskId = ''
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    if (socketPath) await unlink(socketPath).catch(() => undefined)
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) void this.handleLine(socket, line)
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => {
      socket.destroy()
      this.sockets.delete(socket)
    })
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let payload: unknown
    try {
      payload = JSON.parse(line)
    } catch {
      socket.destroy()
      return
    }
    if (
      !isRecord(payload) ||
      !tokensEqual(String(payload.token ?? ''), this.token) ||
      !this.taskId
    ) {
      socket.destroy()
      return
    }
    try {
      const result = await this.dependencies.perform(this.taskId, payload.action)
      if (!socket.destroyed) {
        socket.write(`${JSON.stringify({ id: payload.id ?? null, result })}\n`)
      }
    } catch {
      socket.destroy()
    }
  }
}

function tokensEqual(left: string, right: string): boolean {
  const hashedLeft = createHash('sha256').update(left).digest()
  const hashedRight = createHash('sha256').update(right).digest()
  return timingSafeEqual(hashedLeft, hashedRight)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
