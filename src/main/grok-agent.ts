import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as acp from '@agentclientprotocol/sdk'
import type {
  AgentCapabilityState,
  AgentDiff,
  AgentEvent,
  AgentPermissionRequest,
  AgentRuntimeStatus,
  AgentTurnOutcome,
  AgentTurnUsage
} from '../shared/agent'
import {
  AgentEventNormalizer,
  type AgentEventDraft,
  type AgentEventDraftBase
} from './agent/event-normalizer'
import type { ProviderRuntimeConfig } from './provider/provider-config-store'
import {
  AGENT_STUDIO_MODEL_ALIAS,
  AGENT_STUDIO_MODEL_API_KEY_ENV,
  writeGrokProviderConfig
} from './provider/grok-provider-config'

type StatusListener = (status: AgentRuntimeStatus) => void
type EventListener = (event: AgentEvent) => void
type PermissionListener = (request: AgentPermissionRequest) => void
type TextRedactor = (text: string) => string

const GROK_RUNTIME_ID = 'grok' as const
const MAX_PERMISSION_PAYLOAD_BYTES = 256 * 1024
const MAX_PERMISSION_DISPLAY_TEXT_BYTES = 4 * 1024

interface PendingPermission {
  turnId: string
  optionIds: Set<string>
  resolve: (response: acp.RequestPermissionResponse) => void
}

interface ActiveTurn {
  taskId: string
  turnId: string
  runtimeSessionId: string
  connection: acp.ClientSideConnection
  normalizer: AgentEventNormalizer
  cancelRequested: boolean
}

export interface GrokAgentBridgeOptions {
  userDataPath: string
  getProviderConfig: () => ProviderRuntimeConfig | null
  redactText: (text: string) => string
}

/**
 * 管理 Grok Build 子进程与 ACP 会话，主进程只向渲染层暴露必要能力。
 */
export class GrokAgentBridge {
  private process: ChildProcessWithoutNullStreams | null = null
  private connection: acp.ClientSideConnection | null = null
  private sessionId: string | null = null
  private activeTurn: ActiveTurn | null = null
  private pendingPermissions = new Map<string, PendingPermission>()
  private status: AgentRuntimeStatus = {
    runtimeId: GROK_RUNTIME_ID,
    state: 'idle',
    message: '尚未连接 Grok Build'
  }

  constructor(
    private readonly onStatus: StatusListener,
    private readonly onEvent: EventListener,
    private readonly onPermission: PermissionListener,
    private readonly options: GrokAgentBridgeOptions
  ) {}

  getStatus(): AgentRuntimeStatus {
    return this.status
  }

  async connect(workspace: string): Promise<AgentRuntimeStatus> {
    if (this.connection && this.sessionId && this.status.workspace === workspace) {
      return this.status
    }

    await this.disconnect(false)
    this.updateStatus({ state: 'connecting', message: '正在启动 Grok Build', workspace })

    const providerConfig = this.options.getProviderConfig()
    if (!providerConfig) {
      const message = '模型服务配置不可用，请重新配置 URL、Key 和模型。'
      this.updateStatus({ state: 'error', message, workspace })
      throw new Error(message)
    }

    let grokHome: string
    try {
      grokHome = await writeGrokProviderConfig(this.options.userDataPath, providerConfig)
    } catch (error) {
      const message = this.redactError(error)
      this.updateStatus({ state: 'error', message: `无法生成 Grok 配置：${message}`, workspace })
      throw new Error(message)
    }

    const binary = this.resolveBinary()
    const child = spawn(
      binary,
      ['--no-auto-update', 'agent', '--no-leader', '-m', AGENT_STUDIO_MODEL_ALIAS, 'stdio'],
      {
        cwd: workspace,
        env: buildRuntimeEnvironment(providerConfig, grokHome),
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )

    this.process = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => {
      // Runtime 私有 stderr 只在主进程排空并脱敏，不提升为 Renderer 领域事件。
      void this.safeRedact(text)
    })

    child.once('error', (error) => {
      if (this.process !== child) return
      const message = `无法启动 Grok Build：${this.redactError(error)}`
      this.failActiveTurn(message, 'runtime-process-error')
      this.process = null
      this.connection = null
      this.sessionId = null
      this.updateStatus({
        state: 'error',
        message,
        workspace
      })
    })

    child.on('exit', (code) => {
      // 旧进程退出时不得清空已经建立的新连接。
      if (this.process !== child) return
      const hadActiveTurn = this.activeTurn != null
      const message =
        code === 0 && !hadActiveTurn
          ? 'Grok Build 已断开'
          : `Grok Build 已退出，代码 ${code ?? '未知'}`
      if (hadActiveTurn) this.failActiveTurn(message, 'runtime-process-exit')
      this.process = null
      this.connection = null
      this.sessionId = null
      if (this.status.state !== 'idle') {
        this.updateStatus({
          state: code === 0 && !hadActiveTurn ? 'idle' : 'error',
          message,
          workspace
        })
      }
    })

    const input = Writable.toWeb(child.stdin)
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    const stream = acp.ndJsonStream(input, output)

    const connection = new acp.ClientSideConnection(
      () => ({
        requestPermission: (params) => this.requestPermission(params, connection),
        sessionUpdate: (params) => this.handleSessionUpdate(params, connection)
      }),
      stream
    )

    this.connection = connection

    try {
      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: {
          name: 'agent-studio',
          version: '0.1.0'
        }
      })
      // 异步初始化完成后重新核对身份，旧连接不得覆盖新连接或新进程状态。
      if (this.process !== child || this.connection !== connection) return this.status

      const session = await connection.newSession({
        cwd: workspace,
        mcpServers: []
      })
      if (this.process !== child || this.connection !== connection) return this.status

      this.sessionId = session.sessionId
      this.updateStatus({
        state: 'ready',
        message: 'Grok Build 已连接',
        workspace,
        runtimeSessionId: session.sessionId
      })
      return this.status
    } catch (error) {
      // 被后续 connect 替换的旧连接只结束自己的调用，不得断开当前新连接。
      if (this.process !== child || this.connection !== connection) return this.status

      await this.disconnect(false)
      const message = this.redactError(error)
      this.updateStatus({
        state: 'error',
        message: `连接失败：${message}`,
        workspace
      })
      // 跨 IPC 只返回脱敏后的错误，避免原始异常携带协议或环境细节。
      throw new Error(message)
    }
  }

  async disconnect(updateStatus = true): Promise<AgentRuntimeStatus> {
    const activeTurn = this.activeTurn
    if (activeTurn) {
      this.emitDraft(activeTurn, {
        ...createGrokEventBase(activeTurn.runtimeSessionId, 'native'),
        kind: 'turn-complete',
        outcome: 'cancelled'
      })
    }
    this.cancelPendingPermissions()

    const process = this.process
    this.process = null
    this.connection = null
    this.sessionId = null
    process?.kill()

    if (updateStatus) {
      this.updateStatus({ state: 'idle', message: '已断开 Grok Build' })
    }
    return this.status
  }

  async sendPrompt(prompt: string): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error('请先连接 Grok Build')
    }
    if (this.activeTurn) {
      throw new Error('已有任务正在执行，请等待完成或先取消当前任务')
    }

    const connection = this.connection
    const runtimeSessionId = this.sessionId
    const taskId = randomUUID()
    const turnId = randomUUID()
    const activeTurn: ActiveTurn = {
      taskId,
      turnId,
      runtimeSessionId,
      connection,
      normalizer: new AgentEventNormalizer({ taskId, turnId }),
      cancelRequested: false
    }
    this.activeTurn = activeTurn

    const currentStatus = this.status
    this.updateStatus({ ...currentStatus, state: 'busy', message: 'Grok Build 正在处理' })

    try {
      const response = await connection.prompt({
        sessionId: runtimeSessionId,
        prompt: [{ type: 'text', text: prompt }]
      })
      if (this.activeTurn !== activeTurn) return

      this.emitDraft(activeTurn, mapGrokPromptResponse(response, runtimeSessionId))
      if (this.connection === connection && this.sessionId === runtimeSessionId) {
        this.updateStatus({ ...this.status, state: 'ready', message: 'Grok Build 已连接' })
      }
    } catch (error) {
      if (this.activeTurn !== activeTurn) return

      const message = this.redactError(error)
      this.emitDraft(activeTurn, {
        ...createGrokEventBase(runtimeSessionId, 'native'),
        kind: 'error',
        message: `执行失败：${message}`,
        recoverable: false,
        code: 'prompt-failed'
      })
      this.emitDraft(activeTurn, {
        ...createGrokEventBase(runtimeSessionId, 'native'),
        kind: 'turn-complete',
        outcome: 'failed'
      })
      if (this.connection === connection && this.sessionId === runtimeSessionId) {
        this.updateStatus({ ...this.status, state: 'ready', message: 'Grok Build 已连接' })
      }
    }
  }

  async cancel(): Promise<void> {
    const activeTurn = this.activeTurn
    if (!activeTurn || activeTurn.cancelRequested) return

    activeTurn.cancelRequested = true
    this.cancelPendingPermissions(activeTurn.turnId)
    try {
      await activeTurn.connection.cancel({ sessionId: activeTurn.runtimeSessionId })
    } catch (error) {
      if (this.activeTurn !== activeTurn) return
      activeTurn.cancelRequested = false
      this.emitDraft(activeTurn, {
        ...createGrokEventBase(activeTurn.runtimeSessionId, 'native'),
        kind: 'error',
        message: `取消失败：${this.redactError(error)}`,
        recoverable: true,
        code: 'cancel-failed'
      })
    }
  }

  respondPermission(requestId: string, optionId?: string): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return

    this.pendingPermissions.delete(requestId)
    pending.resolve(
      optionId && pending.optionIds.has(optionId)
        ? { outcome: { outcome: 'selected', optionId } }
        : { outcome: { outcome: 'cancelled' } }
    )
  }

  private requestPermission(
    params: acp.RequestPermissionRequest,
    sourceConnection: acp.ClientSideConnection
  ): Promise<acp.RequestPermissionResponse> {
    const activeTurn = this.activeTurn
    if (
      !activeTurn ||
      activeTurn.cancelRequested ||
      activeTurn.connection !== sourceConnection ||
      this.connection !== sourceConnection ||
      activeTurn.runtimeSessionId !== params.sessionId ||
      this.sessionId !== params.sessionId
    ) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    }

    const id = randomUUID()
    const request = mapGrokPermissionRequest(
      params,
      id,
      activeTurn.taskId,
      activeTurn.turnId,
      (text) => this.safeRedact(text)
    )
    if (!request) {
      this.emitDraft(activeTurn, {
        ...createGrokEventBase(activeTurn.runtimeSessionId, 'native'),
        kind: 'error',
        message: '权限请求内容过大，已安全拒绝。',
        recoverable: true,
        code: 'permission-payload-too-large'
      })
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    }

    return new Promise((resolve) => {
      // 先登记再通知 Renderer，避免同步响应早于 pending 状态建立。
      this.pendingPermissions.set(id, {
        turnId: activeTurn.turnId,
        optionIds: new Set(params.options.map((option) => option.optionId)),
        resolve
      })
      this.onPermission(request)
    })
  }

  private handleSessionUpdate(
    params: acp.SessionNotification,
    sourceConnection: acp.ClientSideConnection
  ): void {
    const activeTurn = this.activeTurn
    if (
      !activeTurn ||
      activeTurn.connection !== sourceConnection ||
      this.connection !== sourceConnection ||
      activeTurn.runtimeSessionId !== params.sessionId ||
      this.sessionId !== params.sessionId
    ) {
      return
    }

    for (const draft of mapGrokSessionUpdate(params, (text) => this.safeRedact(text))) {
      this.emitDraft(activeTurn, draft)
    }
  }

  /** 归一化后才允许事件进入 IPC；首个终态同时释放 active turn。 */
  private emitDraft(activeTurn: ActiveTurn, draft: AgentEventDraft): void {
    const event = activeTurn.normalizer.normalize(draft)
    if (!event) return

    if (event.kind === 'turn-complete' && this.activeTurn === activeTurn) {
      this.cancelPendingPermissions(activeTurn.turnId)
    }
    this.onEvent(event)
    if (event.kind === 'turn-complete' && this.activeTurn === activeTurn) {
      this.activeTurn = null
    }
  }

  /** Runtime 失败统一形成脱敏 error 与唯一 failed 终态。 */
  private failActiveTurn(message: string, code: string): void {
    const activeTurn = this.activeTurn
    if (!activeTurn) return

    this.emitDraft(activeTurn, {
      ...createGrokEventBase(activeTurn.runtimeSessionId, 'native'),
      kind: 'error',
      message,
      recoverable: false,
      code
    })
    this.emitDraft(activeTurn, {
      ...createGrokEventBase(activeTurn.runtimeSessionId, 'native'),
      kind: 'turn-complete',
      outcome: 'failed'
    })
  }

  /** 取消指定 Turn 或全部待处理权限，禁止已失效授权继续进入 Runtime。 */
  private cancelPendingPermissions(turnId?: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (turnId && pending.turnId !== turnId) continue
      this.pendingPermissions.delete(requestId)
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
  }

  private resolveBinary(): string {
    const bundledPath = join(homedir(), '.grok/bin/grok')
    return existsSync(bundledPath) ? bundledPath : 'grok'
  }

  private updateStatus(status: Omit<AgentRuntimeStatus, 'runtimeId'>): void {
    this.status = { ...status, runtimeId: GROK_RUNTIME_ID }
    this.onStatus(this.status)
  }

  private safeRedact(text: string): string {
    try {
      return this.options.redactText(text)
    } catch {
      return '敏感错误信息已隐藏。'
    }
  }

  private redactError(error: unknown): string {
    return this.safeRedact(error instanceof Error ? error.message : String(error))
  }
}

/**
 * 将 ACP SessionUpdate 显式投影为中性事件；未声明字段和未知事件保留在 Adapter 内，
 * 禁止用 payload 或 raw 兜底跨越主进程边界。
 */
export function mapGrokSessionUpdate(
  params: acp.SessionNotification,
  redactText: TextRedactor
): AgentEventDraft[] {
  const update = params.update
  const base = createGrokEventBase(params.sessionId, 'native')

  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      if (update.content.type !== 'text') return []
      return [
        {
          ...base,
          kind: 'agent-message',
          text: redactText(update.content.text),
          ...(update.messageId != null ? { messageId: update.messageId } : {})
        }
      ]
    case 'agent_thought_chunk':
      if (update.content.type !== 'text') return []
      return [
        {
          ...base,
          kind: 'agent-thought',
          text: redactText(update.content.text),
          ...(update.messageId != null ? { messageId: update.messageId } : {})
        }
      ]
    case 'tool_call': {
      const toolEvent: AgentEventDraft = {
        ...base,
        kind: 'tool-call',
        toolCallId: update.toolCallId,
        title: redactText(update.title),
        ...(update.status != null ? { status: update.status } : {})
      }
      return appendMappedDiffEvent(toolEvent, update.toolCallId, update.content, base, redactText)
    }
    case 'tool_call_update': {
      const toolEvent: AgentEventDraft = {
        ...base,
        kind: 'tool-update',
        toolCallId: update.toolCallId,
        ...(update.title != null ? { title: redactText(update.title) } : {}),
        ...(update.status != null ? { status: update.status } : {})
      }
      return appendMappedDiffEvent(toolEvent, update.toolCallId, update.content, base, redactText)
    }
    case 'plan':
      return [
        {
          ...base,
          kind: 'plan',
          entries: update.entries.map((entry) => ({
            content: redactText(entry.content),
            priority: entry.priority,
            status: entry.status
          }))
        }
      ]
    case 'usage_update':
      return [
        {
          ...createGrokEventBase(params.sessionId, 'experimental'),
          kind: 'usage',
          usage: {
            scope: 'context',
            usedTokens: update.used,
            limitTokens: update.size,
            ...(update.cost
              ? { cost: { amount: update.cost.amount, currency: update.cost.currency } }
              : {})
          }
        }
      ]
    case 'user_message_chunk':
    case 'plan_update':
    case 'plan_removed':
    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
      return []
    default:
      return [
        {
          ...createGrokEventBase(params.sessionId, 'unsupported'),
          kind: 'error',
          message: '收到当前版本暂不支持的 Runtime 事件，已安全忽略。',
          recoverable: true,
          code: 'unsupported-runtime-event'
        }
      ]
  }
}

/** 将 ACP PromptResponse 收敛为中性 Turn 终态，丢弃 _meta 等协议扩展字段。 */
export function mapGrokPromptResponse(
  response: acp.PromptResponse,
  runtimeSessionId: string
): Extract<AgentEventDraft, { kind: 'turn-complete' }> {
  return {
    ...createGrokEventBase(runtimeSessionId, 'native'),
    kind: 'turn-complete',
    outcome: mapGrokStopReason(response.stopReason),
    ...(response.usage ? { usage: mapGrokTurnUsage(response.usage) } : {})
  }
}

/** 将 ACP 权限请求逐字段复制到中性结构，避免 _meta 和工具原始内容进入 Renderer。 */
export function mapGrokPermissionRequest(
  params: acp.RequestPermissionRequest,
  requestId: string,
  taskId: string,
  turnId: string,
  redactText: TextRedactor
): AgentPermissionRequest | null {
  const title = limitPermissionDisplayText(
    redactText(params.toolCall.title ?? 'Grok Build 请求执行操作')
  )
  let truncated = title.truncated
  const options = params.options.map((option) => {
    const name = limitPermissionDisplayText(redactText(option.name))
    truncated ||= name.truncated
    return {
      optionId: option.optionId,
      name: name.value,
      kind: option.kind
    }
  })
  const request: AgentPermissionRequest = {
    id: requestId,
    runtimeId: GROK_RUNTIME_ID,
    taskId,
    turnId,
    runtimeSessionId: params.sessionId,
    toolCallId: params.toolCall.toolCallId,
    title: title.value,
    options,
    ...(truncated ? { truncated: true } : {})
  }

  return isPermissionRequestWithinBudget(request) ? request : null
}

/** 权限展示文案按 UTF-8 bytes 截断，避免中文或 emoji 被切成无效编码。 */
function limitPermissionDisplayText(value: string): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= MAX_PERMISSION_DISPLAY_TEXT_BYTES) {
    return { value, truncated: false }
  }

  const characters: string[] = []
  let acceptedBytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (acceptedBytes + characterBytes > MAX_PERMISSION_DISPLAY_TEXT_BYTES) break
    characters.push(character)
    acceptedBytes += characterBytes
  }
  return { value: characters.join(''), truncated: true }
}

/** 标识符保持原值；若完整权限 DTO 仍超限，则整项拒绝而不是破坏 ACP 回传标识。 */
function isPermissionRequestWithinBudget(request: AgentPermissionRequest): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(request), 'utf8') <= MAX_PERMISSION_PAYLOAD_BYTES
  } catch {
    return false
  }
}

function createGrokEventBase(
  runtimeSessionId: string,
  capabilityState: AgentCapabilityState
): AgentEventDraftBase {
  return {
    runtimeId: GROK_RUNTIME_ID,
    runtimeSessionId,
    capabilityState
  }
}

function appendMappedDiffEvent(
  toolEvent: AgentEventDraft,
  toolCallId: string,
  content: acp.ToolCallContent[] | null | undefined,
  base: AgentEventDraftBase,
  redactText: TextRedactor
): AgentEventDraft[] {
  const diffs = mapGrokDiffs(content, redactText)
  if (diffs.length === 0) return [toolEvent]

  return [toolEvent, { ...base, kind: 'diff', toolCallId, diffs }]
}

function mapGrokDiffs(
  content: acp.ToolCallContent[] | null | undefined,
  redactText: TextRedactor
): AgentDiff[] {
  return (content ?? []).flatMap((item) =>
    item.type === 'diff'
      ? [
          {
            format: 'snapshot' as const,
            path: redactText(item.path),
            before: item.oldText == null ? null : redactText(item.oldText),
            after: redactText(item.newText)
          }
        ]
      : []
  )
}

function mapGrokStopReason(stopReason: acp.StopReason): AgentTurnOutcome {
  switch (stopReason) {
    case 'end_turn':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
    case 'refusal':
      return 'refused'
    case 'max_tokens':
    case 'max_turn_requests':
      return 'limit-reached'
  }
}

function mapGrokTurnUsage(usage: acp.Usage): AgentTurnUsage {
  return {
    scope: 'turn',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.thoughtTokens != null ? { thoughtTokens: usage.thoughtTokens } : {}),
    ...(usage.cachedReadTokens != null ? { cachedReadTokens: usage.cachedReadTokens } : {}),
    ...(usage.cachedWriteTokens != null ? { cachedWriteTokens: usage.cachedWriteTokens } : {})
  }
}

const RUNTIME_ENV_ALLOWLIST = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy'
] as const

/** 构造当前 Grok 进程专属的最小环境，避免无关宿主密钥随进程继承。 */
function buildRuntimeEnvironment(
  providerConfig: ProviderRuntimeConfig,
  grokHome: string
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const name of RUNTIME_ENV_ALLOWLIST) {
    const value = process.env[name]
    if (value) environment[name] = value
  }

  environment.PATH = [join(homedir(), '.grok/bin'), process.env.PATH]
    .filter(Boolean)
    .join(delimiter)
  environment.GROK_HOME = grokHome
  if (providerConfig.authMode === 'bearer' && providerConfig.apiKey) {
    environment[AGENT_STUDIO_MODEL_API_KEY_ENV] = providerConfig.apiKey
  }
  return environment
}
