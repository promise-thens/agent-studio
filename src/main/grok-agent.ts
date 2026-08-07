import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as acp from '@agentclientprotocol/sdk'
import type { GrokAgentEvent, GrokPermissionRequest, GrokStatus } from '../shared/grok'

type StatusListener = (status: GrokStatus) => void
type EventListener = (event: GrokAgentEvent) => void
type PermissionListener = (request: GrokPermissionRequest) => void

interface PendingPermission {
  resolve: (response: acp.RequestPermissionResponse) => void
}

/**
 * 管理 Grok Build 子进程与 ACP 会话，主进程只向渲染层暴露必要能力。
 */
export class GrokAgentBridge {
  private process: ChildProcessWithoutNullStreams | null = null
  private connection: acp.ClientSideConnection | null = null
  private sessionId: string | null = null
  private pendingPermissions = new Map<string, PendingPermission>()
  private status: GrokStatus = { state: 'idle', message: '尚未连接 Grok Build' }

  constructor(
    private readonly onStatus: StatusListener,
    private readonly onEvent: EventListener,
    private readonly onPermission: PermissionListener
  ) {}

  getStatus(): GrokStatus {
    return this.status
  }

  async connect(workspace: string): Promise<GrokStatus> {
    if (this.connection && this.sessionId && this.status.workspace === workspace) {
      return this.status
    }

    await this.disconnect(false)
    this.updateStatus({ state: 'connecting', message: '正在启动 Grok Build', workspace })

    const binary = this.resolveBinary()
    const child = spawn(binary, ['--no-auto-update', 'agent', 'stdio'], {
      cwd: workspace,
      env: {
        ...process.env,
        PATH: `${join(homedir(), '.grok/bin')}:${process.env.PATH ?? ''}`
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    this.process = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => {
      const cleanText = text.trim()
      if (cleanText) this.onEvent({ kind: 'stderr', text: cleanText })
    })

    child.on('exit', (code) => {
      this.process = null
      this.connection = null
      this.sessionId = null
      if (this.status.state !== 'idle') {
        this.updateStatus({
          state: code === 0 ? 'idle' : 'error',
          message: code === 0 ? 'Grok Build 已断开' : `Grok Build 已退出，代码 ${code ?? '未知'}`,
          workspace
        })
      }
    })

    const input = Writable.toWeb(child.stdin)
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    const stream = acp.ndJsonStream(input, output)

    const connection = new acp.ClientSideConnection(
      () => ({
        requestPermission: (params) => this.requestPermission(params),
        sessionUpdate: (params) => this.handleSessionUpdate(params)
      }),
      stream
    )

    this.connection = connection

    try {
      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: {
          name: 'grok-build-desktop',
          version: '0.1.0'
        }
      })

      const session = await connection.newSession({
        cwd: workspace,
        mcpServers: []
      })

      this.sessionId = session.sessionId
      this.updateStatus({
        state: 'ready',
        message: 'Grok Build 已连接',
        workspace,
        sessionId: session.sessionId
      })
      return this.status
    } catch (error) {
      await this.disconnect(false)
      const message = error instanceof Error ? error.message : String(error)
      this.updateStatus({
        state: 'error',
        message: `连接失败：${message}`,
        workspace
      })
      throw error
    }
  }

  async disconnect(updateStatus = true): Promise<GrokStatus> {
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
    this.pendingPermissions.clear()
    this.process?.kill()
    this.process = null
    this.connection = null
    this.sessionId = null

    if (updateStatus) {
      this.updateStatus({ state: 'idle', message: '已断开 Grok Build' })
    }
    return this.status
  }

  async sendPrompt(prompt: string): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error('请先连接 Grok Build')
    }

    const currentStatus = this.status
    this.updateStatus({ ...currentStatus, state: 'busy', message: 'Grok Build 正在处理' })

    try {
      const response = await this.connection.prompt({
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: prompt }]
      })
      this.onEvent({ kind: 'turn-complete', payload: response })
      this.updateStatus({ ...this.status, state: 'ready', message: 'Grok Build 已连接' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.updateStatus({ ...this.status, state: 'error', message: `执行失败：${message}` })
      throw error
    }
  }

  async cancel(): Promise<void> {
    if (!this.connection || !this.sessionId) return
    await this.connection.cancel({ sessionId: this.sessionId })
  }

  respondPermission(requestId: string, optionId?: string): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return

    pending.resolve(
      optionId
        ? { outcome: { outcome: 'selected', optionId } }
        : { outcome: { outcome: 'cancelled' } }
    )
    this.pendingPermissions.delete(requestId)
  }

  private requestPermission(
    params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    const id = randomUUID()
    this.onPermission({
      id,
      title: params.toolCall.title ?? 'Grok Build 请求执行操作',
      options: params.options
    })

    return new Promise((resolve) => {
      this.pendingPermissions.set(id, { resolve })
    })
  }

  private handleSessionUpdate(params: acp.SessionNotification): void {
    const update = params.update

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.onEvent({
          kind: 'agent-message',
          text: update.content.type === 'text' ? update.content.text : `[${update.content.type}]`,
          messageId: update.messageId ?? undefined
        })
        break
      case 'agent_thought_chunk':
        this.onEvent({
          kind: 'agent-thought',
          text: update.content.type === 'text' ? update.content.text : `[${update.content.type}]`,
          messageId: update.messageId ?? undefined
        })
        break
      case 'tool_call':
        this.onEvent({
          kind: 'tool-call',
          toolCallId: update.toolCallId,
          title: update.title,
          status: update.status,
          payload: update
        })
        break
      case 'tool_call_update':
        this.onEvent({
          kind: 'tool-update',
          toolCallId: update.toolCallId,
          title: update.title ?? undefined,
          status: update.status ?? undefined,
          payload: update
        })
        break
      case 'plan':
        this.onEvent({ kind: 'plan', entries: update.entries, payload: update })
        break
      case 'usage_update':
        this.onEvent({ kind: 'usage', payload: update })
        break
      default:
        this.onEvent({ kind: 'raw', payload: update })
    }
  }

  private resolveBinary(): string {
    const bundledPath = join(homedir(), '.grok/bin/grok')
    return existsSync(bundledPath) ? bundledPath : 'grok'
  }

  private updateStatus(status: GrokStatus): void {
    this.status = status
    this.onStatus(status)
  }
}
