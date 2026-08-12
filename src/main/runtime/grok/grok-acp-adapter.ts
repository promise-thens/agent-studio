import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type {
  AgentCapabilityId,
  AgentCapabilityMaturity,
  AgentEvent,
  AgentRuntimeCapabilitySnapshot,
  AgentRuntimeStatus,
  AgentTurnOutcome
} from '../../../shared/agent'
import { AgentEventNormalizer, type AgentEventDraft } from '../../agent/event-normalizer'
import {
  AgentRuntimeAdapterError,
  type AgentRuntimeAdapter,
  type AgentRuntimeAdapterErrorCode,
  type AgentRuntimeAdapterSink,
  type AgentRuntimeSessionContext,
  type AgentRuntimeSessionRef,
  type AgentRuntimeTurnContext,
  type AgentRuntimeTurnRef,
  type AgentRuntimeTurnResult
} from '../../agent/agent-runtime-adapter'
import { updateAgentRuntimeCapabilitySnapshot } from '../../agent/runtime-capabilities'
import type { ProviderRuntimeConfig } from '../../provider/provider-config-store'
import {
  AGENT_STUDIO_MODEL_ALIAS,
  AGENT_STUDIO_MODEL_API_KEY_ENV,
  writeGrokProviderConfig
} from '../../provider/grok-provider-config'
import {
  GROK_RUNTIME_ID,
  createGrokCapabilitySnapshot,
  createGrokEventBase,
  mapGrokInitializeCapabilitySnapshot,
  mapGrokPermissionRequest,
  mapGrokPromptResponse,
  mapGrokSessionUpdate
} from './grok-acp-mappers'

interface PendingPermission {
  activeTurn: ActiveTurn
  optionIds: Set<string>
  resolve: (response: acp.RequestPermissionResponse) => void
}

interface ActiveTurn {
  taskId: string
  turnId: string
  runtimeSessionId: string
  connection: acp.ClientSideConnection
  connectionGeneration: number
  sessionGeneration: number
  normalizer: AgentEventNormalizer
  cancelRequested: boolean
  outcome?: AgentTurnOutcome
}

interface CurrentConnection {
  connection: acp.ClientSideConnection
  connectionGeneration: number
  sessionOperationGeneration: number
}

interface GrokSetModelRequest {
  sessionId: string
  modelId: string
}

const GROK_SET_MODEL_METHOD = 'session/set_model'

export interface GrokAcpAdapterOptions {
  userDataPath: string
  getProviderConfig: () => ProviderRuntimeConfig | null
  redactText: (text: string) => string
}

/**
 * Grok Build 的 ACP Runtime Adapter。
 *
 * 该类只管理子进程、ACP 连接、Runtime session 与协议投影；
 * 产品 taskId/turnId 必须由 AgentService 分配后传入，Adapter 不得自行生成。
 */
export class GrokAcpAdapter implements AgentRuntimeAdapter {
  readonly runtimeId = GROK_RUNTIME_ID

  private process: ChildProcessWithoutNullStreams | null = null
  private connection: acp.ClientSideConnection | null = null
  private connectionGeneration = 0
  private sessionOperationGeneration = 0
  private sessionGeneration = 0
  private selectedSession: AgentRuntimeSessionRef | null = null
  private activeTurn: ActiveTurn | null = null
  private pendingPermissions = new Map<string, PendingPermission>()
  private supportsCloseSession = false
  private capabilitySnapshot: AgentRuntimeCapabilitySnapshot
  private status: AgentRuntimeStatus

  constructor(
    private readonly sink: AgentRuntimeAdapterSink,
    private readonly options: GrokAcpAdapterOptions
  ) {
    this.capabilitySnapshot = createGrokCapabilitySnapshot((text) => this.safeRedact(text))
    this.status = {
      runtimeId: GROK_RUNTIME_ID,
      state: 'idle',
      message: '尚未连接 Grok Build',
      capabilitySnapshot: this.capabilitySnapshot
    }
  }

  getStatus(): AgentRuntimeStatus {
    return this.status
  }

  getCapabilitySnapshot(): AgentRuntimeCapabilitySnapshot {
    return this.capabilitySnapshot
  }

  /** 启动 Grok 子进程并完成 ACP 握手，不在连接阶段隐式创建产品 Task 会话。 */
  async connect(workspace: string): Promise<AgentRuntimeStatus> {
    if (this.activeTurn) {
      throw this.createError('invalid-state', '任务执行中，不能重新连接 Runtime。')
    }
    if (this.connection && this.status.workspace === workspace) return this.status

    await this.disconnectInternal(false)
    this.updateStatus({ state: 'connecting', message: '正在启动 Grok Build', workspace })

    const providerConfig = this.options.getProviderConfig()
    if (!providerConfig) {
      const error = this.createError(
        'runtime-unavailable',
        '模型服务配置不可用，请重新配置 URL、Key 和模型。'
      )
      this.updateStatus({ state: 'error', message: error.message, workspace })
      throw error
    }

    let grokHome: string
    try {
      grokHome = await writeGrokProviderConfig(this.options.userDataPath, providerConfig)
    } catch (error) {
      const adapterError = this.createError(
        'operation-failed',
        `无法生成 Grok 配置：${this.redactError(error)}`
      )
      this.updateStatus({ state: 'error', message: adapterError.message, workspace })
      throw adapterError
    }

    const child = spawn(
      this.resolveBinary(),
      ['--no-auto-update', 'agent', '--no-leader', '-m', AGENT_STUDIO_MODEL_ALIAS, 'stdio'],
      {
        cwd: workspace,
        env: buildGrokRuntimeEnvironment(providerConfig, grokHome),
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    const connectionGeneration = ++this.connectionGeneration
    this.process = child

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => {
      // Runtime stderr 只在主进程排空并脱敏，不提升为产品事件。
      void this.safeRedact(text)
    })
    child.once('error', (error) => {
      this.handleRuntimeProcessError(child, connectionGeneration, workspace, error)
    })
    child.on('exit', (code) => {
      this.handleRuntimeProcessExit(child, connectionGeneration, workspace, code)
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
      const initialized = await this.initializeConnection(
        connection,
        child,
        workspace,
        connectionGeneration
      )
      if (!initialized) return this.status

      this.updateStatus({ state: 'ready', message: 'Grok Build 已连接', workspace })
      return this.status
    } catch (error) {
      // 被新连接替换的旧握手只结束自己，禁止断开已建立的新 Runtime。
      if (!this.isCurrentConnection(connection, child, connectionGeneration)) return this.status

      await this.disconnectInternal(false)
      const adapterError = this.toAdapterError(error, 'operation-failed', '连接失败')
      this.updateStatus({
        state: 'error',
        message: `连接失败：${adapterError.message}`,
        workspace
      })
      throw adapterError
    }
  }

  async disconnect(): Promise<AgentRuntimeStatus> {
    return this.disconnectInternal(true)
  }

  /** 在当前已握手连接上创建新 Runtime session，并返回主进程私有引用。 */
  async createSession(context: AgentRuntimeSessionContext): Promise<AgentRuntimeSessionRef> {
    const current = this.beginSessionOperation(context.workspace)

    try {
      const response = await current.connection.newSession({
        cwd: context.workspace,
        mcpServers: []
      })
      this.assertSessionOperationCurrent(current)
      if (!response.sessionId) {
        throw this.createError('operation-failed', 'Runtime 未返回有效会话标识。')
      }
      await this.bindAgentStudioModel(current, response.sessionId, context.workspace)

      const session: AgentRuntimeSessionRef = {
        runtimeId: GROK_RUNTIME_ID,
        runtimeSessionId: response.sessionId,
        workspace: context.workspace
      }
      this.activateSession(session)
      this.verifyCapability('session.create', 'stable')
      return session
    } catch (error) {
      if (error instanceof AgentRuntimeAdapterError) throw error
      this.assertSessionOperationCurrent(current)
      throw this.toAdapterError(error, 'operation-failed', '创建 Runtime 会话失败')
    }
  }

  /** 只在 initialize 明确声明 load 后尝试恢复，首次真实成功后再提升为 verified。 */
  async loadSession(session: AgentRuntimeSessionRef): Promise<void> {
    this.assertSessionRef(session)
    this.assertRestoreCapability('session.load')
    const current = this.beginSessionOperation(session.workspace)

    try {
      await current.connection.loadSession({
        sessionId: session.runtimeSessionId,
        cwd: session.workspace,
        mcpServers: []
      })
      this.assertSessionOperationCurrent(current)
      await this.bindAgentStudioModel(current, session.runtimeSessionId, session.workspace)
      this.activateSession(session)
      this.verifyCapability('session.load', 'stable')
    } catch (error) {
      if (error instanceof AgentRuntimeAdapterError) throw error
      this.assertSessionOperationCurrent(current)
      throw this.toRestoreError(error, '加载 Runtime 会话失败')
    }
  }

  /** resume 不回放历史事件，用于 Task 切回时恢复原 Grok 上下文。 */
  async resumeSession(session: AgentRuntimeSessionRef): Promise<void> {
    this.assertSessionRef(session)
    this.assertRestoreCapability('session.resume')
    const current = this.beginSessionOperation(session.workspace)

    try {
      await current.connection.resumeSession({
        sessionId: session.runtimeSessionId,
        cwd: session.workspace,
        mcpServers: []
      })
      this.assertSessionOperationCurrent(current)
      await this.bindAgentStudioModel(current, session.runtimeSessionId, session.workspace)
      this.activateSession(session)
      this.verifyCapability('session.resume', 'stable')
    } catch (error) {
      if (error instanceof AgentRuntimeAdapterError) throw error
      this.assertSessionOperationCurrent(current)
      throw this.toRestoreError(error, '恢复 Runtime 会话失败')
    }
  }

  /**
   * 显式关闭 Task 时优先调用 Runtime 已声明的 session/close。
   * 未声明 close 时只做本地幂等解绑，不伪造原生能力证据。
   */
  async closeSession(session: AgentRuntimeSessionRef): Promise<void> {
    this.assertSessionRef(session)
    const activeTurn = this.activeTurn
    if (activeTurn && activeTurn.runtimeSessionId !== session.runtimeSessionId) {
      throw this.createError('invalid-state', '当前正在执行其他 Runtime 会话。')
    }

    if (activeTurn) {
      await this.cancelTurn(activeTurn)
      if (this.activeTurn === activeTurn) {
        this.emitDraft(activeTurn, {
          ...createGrokEventBase(activeTurn.runtimeSessionId, 'native'),
          kind: 'turn-complete',
          outcome: 'cancelled'
        })
      }
    }

    let closeError: AgentRuntimeAdapterError | undefined
    const connection = this.connection
    if (connection && this.status.workspace === session.workspace && this.supportsCloseSession) {
      try {
        await connection.closeSession({ sessionId: session.runtimeSessionId })
      } catch (error) {
        closeError = this.toAdapterError(error, 'operation-failed', '关闭 Runtime 会话失败')
      }
    }

    if (this.isSelectedSession(session)) {
      this.selectedSession = null
      this.sessionGeneration += 1
      this.sessionOperationGeneration += 1
      if (this.connection && this.status.workspace === session.workspace) {
        this.updateStatus({
          state: 'ready',
          message: 'Grok Build 已连接',
          workspace: session.workspace
        })
      }
    }

    if (closeError) throw closeError
  }

  /** 启动一次 ACP Prompt，事件封套完全沿用服务层传入的 Task / Turn 身份。 */
  async startTurn(context: AgentRuntimeTurnContext): Promise<AgentRuntimeTurnResult> {
    const connection = this.requireSelectedSession(context)
    if (this.activeTurn) {
      throw this.createError('invalid-state', '已有 Turn 正在执行。')
    }

    const activeTurn: ActiveTurn = {
      taskId: context.taskId,
      turnId: context.turnId,
      runtimeSessionId: context.runtimeSessionId,
      connection,
      connectionGeneration: this.connectionGeneration,
      sessionGeneration: this.sessionGeneration,
      normalizer: new AgentEventNormalizer({ taskId: context.taskId, turnId: context.turnId }),
      cancelRequested: false
    }
    this.activeTurn = activeTurn
    this.updateStatus({
      state: 'busy',
      message: 'Grok Build 正在处理',
      workspace: context.workspace,
      runtimeSessionId: context.runtimeSessionId
    })

    try {
      const response = await connection.prompt({
        sessionId: context.runtimeSessionId,
        prompt: [{ type: 'text', text: context.prompt }]
      })
      if (!this.isActiveTurnCurrent(activeTurn)) {
        return { outcome: activeTurn.outcome ?? 'cancelled' }
      }

      this.verifyCapability('session.prompt.text', 'stable', undefined, false)
      const terminal = mapGrokPromptResponse(response, context.runtimeSessionId)
      this.emitDraft(activeTurn, terminal)
      this.restoreReadyStatus(activeTurn)
      return { outcome: terminal.outcome }
    } catch (error) {
      if (!this.isActiveTurnCurrent(activeTurn)) {
        return { outcome: activeTurn.outcome ?? 'cancelled' }
      }

      this.emitDraft(activeTurn, {
        ...createGrokEventBase(context.runtimeSessionId, 'native'),
        kind: 'error',
        message: `执行失败：${this.redactError(error)}`,
        recoverable: false,
        code: 'prompt-failed'
      })
      this.emitDraft(activeTurn, {
        ...createGrokEventBase(context.runtimeSessionId, 'native'),
        kind: 'turn-complete',
        outcome: 'failed'
      })
      this.restoreReadyStatus(activeTurn)
      return { outcome: 'failed' }
    }
  }

  /** 取消只能命中完全匹配的当前 Turn，旧 Task/Turn 的晚到操作幂等忽略。 */
  async cancelTurn(turn: AgentRuntimeTurnRef): Promise<void> {
    const activeTurn = this.activeTurn
    if (!activeTurn || !this.matchesTurn(activeTurn, turn) || activeTurn.cancelRequested) return

    activeTurn.cancelRequested = true
    this.cancelPendingPermissions(activeTurn)
    try {
      await activeTurn.connection.cancel({ sessionId: activeTurn.runtimeSessionId })
      if (this.isActiveTurnCurrent(activeTurn)) {
        this.verifyCapability('session.cancel', 'stable')
      }
    } catch (error) {
      if (!this.isActiveTurnCurrent(activeTurn)) return
      activeTurn.cancelRequested = false
      // 取消失败必须向 Controller 抛出有限错误，才能解除幂等门禁并允许用户再次尝试。
      throw this.toAdapterError(error, 'operation-failed', '取消失败')
    }
  }

  respondPermission(requestId: string, optionId?: string): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return

    this.pendingPermissions.delete(requestId)
    if (!this.isActiveTurnCurrent(pending.activeTurn)) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
      return
    }
    pending.resolve(
      optionId && pending.optionIds.has(optionId)
        ? { outcome: { outcome: 'selected', optionId } }
        : { outcome: { outcome: 'cancelled' } }
    )
  }

  /** ACP 握手只更新当前连接的能力快照，旧连接的晚到结果必须丢弃。 */
  private async initializeConnection(
    connection: acp.ClientSideConnection,
    child: ChildProcessWithoutNullStreams,
    workspace: string,
    connectionGeneration: number
  ): Promise<boolean> {
    const response = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: {
        name: 'agent-studio',
        version: '0.1.0'
      }
    })
    if (!this.isCurrentConnection(connection, child, connectionGeneration)) return false

    this.capabilitySnapshot = mapGrokInitializeCapabilitySnapshot(
      this.capabilitySnapshot,
      response,
      (text) => this.safeRedact(text),
      acp.PROTOCOL_VERSION
    )
    this.supportsCloseSession = response.agentCapabilities?.sessionCapabilities?.close != null
    this.verifyCapability('runtime.connect', 'stable', undefined, false)
    this.status = {
      runtimeId: GROK_RUNTIME_ID,
      state: 'connecting',
      message: '正在启动 Grok Build',
      workspace,
      capabilitySnapshot: this.capabilitySnapshot
    }
    return true
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
      !this.isActiveTurnCurrent(activeTurn) ||
      activeTurn.runtimeSessionId !== params.sessionId
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

    this.verifyCapability('permission.request', 'stable')
    return new Promise((resolve) => {
      // 先登记再通知上层，避免同步响应早于 pending 状态建立。
      this.pendingPermissions.set(id, {
        activeTurn,
        optionIds: new Set(params.options.map((option) => option.optionId)),
        resolve
      })
      try {
        this.sink.onPermission(request)
      } catch {
        this.pendingPermissions.delete(id)
        resolve({ outcome: { outcome: 'cancelled' } })
      }
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
      !this.isActiveTurnCurrent(activeTurn) ||
      activeTurn.runtimeSessionId !== params.sessionId
    ) {
      return
    }

    for (const draft of mapGrokSessionUpdate(params, (text) => this.safeRedact(text))) {
      this.emitDraft(activeTurn, draft)
    }
  }

  /** 只有当前连接、当前 session 与当前 Turn 三重代次一致时才允许事件发布。 */
  private emitDraft(activeTurn: ActiveTurn, draft: AgentEventDraft): AgentEvent | null {
    if (!this.isActiveTurnCurrent(activeTurn)) return null

    const event = activeTurn.normalizer.normalize(draft)
    if (!event) return null
    this.verifyEventCapability(event)

    if (event.kind === 'turn-complete') {
      this.cancelPendingPermissions(activeTurn)
      activeTurn.outcome = event.outcome
      this.activeTurn = null
    }
    this.sink.onEvent(event)
    return event
  }

  /** Runtime 异常统一形成脱敏 error 与唯一 failed 终态。 */
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
  private cancelPendingPermissions(activeTurn?: ActiveTurn): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (activeTurn && pending.activeTurn !== activeTurn) continue
      this.pendingPermissions.delete(requestId)
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
  }

  private beginSessionOperation(workspace: string): CurrentConnection {
    if (this.activeTurn) {
      throw this.createError('invalid-state', 'Turn 执行中，不能切换 Runtime 会话。')
    }
    const connection = this.connection
    if (!connection || this.status.state !== 'ready' || this.status.workspace !== workspace) {
      throw this.createError('invalid-state', '请先连接对应工作目录的 Grok Runtime。')
    }

    return {
      connection,
      connectionGeneration: this.connectionGeneration,
      sessionOperationGeneration: ++this.sessionOperationGeneration
    }
  }

  private assertSessionOperationCurrent(current: CurrentConnection): void {
    if (
      this.connection !== current.connection ||
      this.connectionGeneration !== current.connectionGeneration ||
      this.sessionOperationGeneration !== current.sessionOperationGeneration
    ) {
      throw this.createError('invalid-state', 'Runtime 会话操作已失效。')
    }
  }

  /**
   * Grok 会在 load/resume 时恢复历史模型选择；激活 session 前必须重新锁定 App 专属别名，
   * 避免用户 Prompt 漂移到 Grok 原生 Responses 后端并绕过当前 Provider 配置。
   */
  private async bindAgentStudioModel(
    current: CurrentConnection,
    sessionId: string,
    workspace: string
  ): Promise<void> {
    try {
      const response = await current.connection.request<unknown, GrokSetModelRequest>(
        GROK_SET_MODEL_METHOD,
        { sessionId, modelId: AGENT_STUDIO_MODEL_ALIAS }
      )
      this.assertSessionOperationCurrent(current)

      if (response === null || typeof response !== 'object' || Array.isArray(response)) {
        throw this.createError(
          'operation-failed',
          'Grok Runtime 未确认 Agent Studio 模型绑定，已阻止继续执行。'
        )
      }
    } catch (error) {
      // Runtime 可能已经切换到目标 session；绑定失败时必须废弃整条连接，避免本地仍记录旧 Task。
      this.assertSessionOperationCurrent(current)
      const adapterError = this.toAdapterError(
        error,
        'operation-failed',
        '绑定 Agent Studio 模型失败'
      )
      await this.disconnectInternal(false)
      this.updateStatus({ state: 'error', message: adapterError.message, workspace })
      throw adapterError
    }
  }

  private activateSession(session: AgentRuntimeSessionRef): void {
    this.selectedSession = { ...session }
    this.sessionGeneration += 1
    this.updateStatus({
      state: 'ready',
      message: 'Grok Build 已连接',
      workspace: session.workspace,
      runtimeSessionId: session.runtimeSessionId
    })
  }

  private requireSelectedSession(context: AgentRuntimeTurnContext): acp.ClientSideConnection {
    if (!context.taskId || !context.turnId || !context.prompt.trim()) {
      throw this.createError('invalid-state', 'Turn 上下文不完整。')
    }
    const connection = this.connection
    if (
      !connection ||
      this.status.state !== 'ready' ||
      !this.selectedSession ||
      this.selectedSession.runtimeId !== GROK_RUNTIME_ID ||
      this.selectedSession.runtimeSessionId !== context.runtimeSessionId ||
      this.selectedSession.workspace !== context.workspace
    ) {
      throw this.createError('invalid-state', '目标 Task 的 Runtime 会话尚未激活。')
    }
    return connection
  }

  private assertSessionRef(session: AgentRuntimeSessionRef): void {
    if (session.runtimeId !== GROK_RUNTIME_ID || !session.runtimeSessionId || !session.workspace) {
      throw this.createError('invalid-state', 'Runtime 会话引用无效。')
    }
  }

  private assertRestoreCapability(capabilityId: 'session.load' | 'session.resume'): void {
    const capability = this.capabilitySnapshot.capabilities[capabilityId]
    if (capability.support !== 'native' || capability.verification === 'unverified') {
      throw this.createError(
        'session-restore-unsupported',
        capabilityId === 'session.resume'
          ? 'Grok Runtime 当前未声明 session/resume 支持。'
          : 'Grok Runtime 当前未声明 session/load 支持。'
      )
    }
  }

  private isCurrentConnection(
    connection: acp.ClientSideConnection,
    child: ChildProcessWithoutNullStreams,
    connectionGeneration: number
  ): boolean {
    return (
      this.connection === connection &&
      this.process === child &&
      this.connectionGeneration === connectionGeneration
    )
  }

  private isActiveTurnCurrent(activeTurn: ActiveTurn): boolean {
    return (
      this.activeTurn === activeTurn &&
      this.connection === activeTurn.connection &&
      this.connectionGeneration === activeTurn.connectionGeneration &&
      this.sessionGeneration === activeTurn.sessionGeneration &&
      this.selectedSession?.runtimeSessionId === activeTurn.runtimeSessionId
    )
  }

  private matchesTurn(activeTurn: ActiveTurn, turn: AgentRuntimeTurnRef): boolean {
    return (
      activeTurn.taskId === turn.taskId &&
      activeTurn.turnId === turn.turnId &&
      activeTurn.runtimeSessionId === turn.runtimeSessionId
    )
  }

  private isSelectedSession(session: AgentRuntimeSessionRef): boolean {
    return (
      this.selectedSession?.runtimeId === session.runtimeId &&
      this.selectedSession.runtimeSessionId === session.runtimeSessionId &&
      this.selectedSession.workspace === session.workspace
    )
  }

  private restoreReadyStatus(activeTurn: ActiveTurn): void {
    if (
      this.connection === activeTurn.connection &&
      this.connectionGeneration === activeTurn.connectionGeneration &&
      this.selectedSession?.runtimeSessionId === activeTurn.runtimeSessionId
    ) {
      this.updateStatus({
        state: 'ready',
        message: 'Grok Build 已连接',
        workspace: this.selectedSession.workspace,
        runtimeSessionId: activeTurn.runtimeSessionId
      })
    }
  }

  private async disconnectInternal(updateStatus: boolean): Promise<AgentRuntimeStatus> {
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
    this.connectionGeneration += 1
    this.sessionOperationGeneration += 1
    this.sessionGeneration += 1
    this.process = null
    this.connection = null
    this.selectedSession = null
    this.supportsCloseSession = false
    process?.kill()
    this.resetCapabilitySnapshot()

    if (updateStatus) {
      this.updateStatus({ state: 'idle', message: '已断开 Grok Build' })
    }
    return this.status
  }

  private handleRuntimeProcessError(
    child: ChildProcessWithoutNullStreams,
    connectionGeneration: number,
    workspace: string,
    error: unknown
  ): void {
    if (this.process !== child || this.connectionGeneration !== connectionGeneration) return
    const message = `无法启动 Grok Build：${this.redactError(error)}`
    this.failActiveTurn(message, 'runtime-process-error')
    this.clearFailedConnection()
    this.updateStatus({ state: 'error', message, workspace })
  }

  private handleRuntimeProcessExit(
    child: ChildProcessWithoutNullStreams,
    connectionGeneration: number,
    workspace: string,
    code: number | null
  ): void {
    // 旧进程退出时不得清空已建立的新连接。
    if (this.process !== child || this.connectionGeneration !== connectionGeneration) return

    const hadActiveTurn = this.activeTurn != null
    const message =
      code === 0 && !hadActiveTurn
        ? 'Grok Build 已断开'
        : `Grok Build 已退出，代码 ${code ?? '未知'}`
    if (hadActiveTurn) this.failActiveTurn(message, 'runtime-process-exit')
    this.clearFailedConnection()
    if (this.status.state !== 'idle') {
      this.updateStatus({
        state: code === 0 && !hadActiveTurn ? 'idle' : 'error',
        message,
        workspace
      })
    }
  }

  private clearFailedConnection(): void {
    this.connectionGeneration += 1
    this.sessionOperationGeneration += 1
    this.sessionGeneration += 1
    this.process = null
    this.connection = null
    this.selectedSession = null
    this.supportsCloseSession = false
    this.cancelPendingPermissions()
    this.resetCapabilitySnapshot()
  }

  /** 所有状态都重新附加 Adapter 内部快照，禁止协议原对象从调用方混入。 */
  private updateStatus(status: Omit<AgentRuntimeStatus, 'runtimeId' | 'capabilitySnapshot'>): void {
    this.status = {
      ...status,
      runtimeId: GROK_RUNTIME_ID,
      capabilitySnapshot: this.capabilitySnapshot
    }
    this.sink.onStatus(this.status)
  }

  /** 新连接、断开与失败均恢复静态基线，避免旧 Runtime 证据泄漏到下一连接。 */
  private resetCapabilitySnapshot(): void {
    this.capabilitySnapshot = createGrokCapabilitySnapshot((text) => this.safeRedact(text))
  }

  /** 真实 Runtime 操作成功后才将单项能力提升为 verified/runtime。 */
  private verifyCapability(
    capabilityId: AgentCapabilityId,
    maturity: AgentCapabilityMaturity,
    reason?: string,
    publish = true
  ): void {
    const current = this.capabilitySnapshot.capabilities[capabilityId]
    if (current.verification === 'verified' && current.source === 'runtime') return

    this.capabilitySnapshot = updateAgentRuntimeCapabilitySnapshot(
      this.capabilitySnapshot,
      {
        capabilityId,
        support: 'native',
        maturity,
        verification: 'verified',
        source: 'runtime',
        ...(reason ? { reason } : {})
      },
      { redactText: (text) => this.safeRedact(text) }
    )
    if (publish) this.publishCapabilitySnapshot()
  }

  /** 只有已安全归一化的事件才能作为 Runtime 能力运行证据。 */
  private verifyEventCapability(event: AgentEvent): void {
    switch (event.kind) {
      case 'agent-message':
        this.verifyCapability('event.agent-message', 'stable')
        break
      case 'agent-thought':
        this.verifyCapability('event.agent-thought', 'stable')
        break
      case 'plan':
        this.verifyCapability('event.plan', 'stable')
        break
      case 'tool-call':
      case 'tool-update':
        this.verifyCapability('event.tool', 'stable')
        break
      case 'diff':
        this.verifyCapability('event.diff', 'stable')
        break
      case 'usage':
        this.verifyCapability(
          event.usage.scope === 'context' ? 'usage.context' : 'usage.turn',
          'experimental',
          'Grok Runtime 已返回实验性 Usage 数据。'
        )
        break
      case 'turn-complete':
        if (event.usage) {
          this.verifyCapability(
            'usage.turn',
            'experimental',
            'Grok Runtime 已返回实验性 Turn Usage 数据。'
          )
        }
        break
      case 'error':
        break
    }
  }

  private publishCapabilitySnapshot(): void {
    this.updateStatus({
      state: this.status.state,
      message: this.status.message,
      ...(this.status.workspace ? { workspace: this.status.workspace } : {}),
      ...(this.status.runtimeSessionId ? { runtimeSessionId: this.status.runtimeSessionId } : {})
    })
  }

  private resolveBinary(): string {
    const bundledPath = join(homedir(), '.grok/bin/grok')
    return existsSync(bundledPath) ? bundledPath : 'grok'
  }

  /** 统一执行主进程脱敏；脱敏器自身异常时失败关闭，绝不回退原文。 */
  private safeRedact(text: string): string {
    try {
      return this.options.redactText(text)
    } catch {
      return '敏感错误信息已隐藏。'
    }
  }

  /** 只提取可展示的错误文本并立即脱敏，不向 Renderer 暴露堆栈或原始对象。 */
  private redactError(error: unknown): string {
    return this.safeRedact(error instanceof Error ? error.message : String(error))
  }

  /** 创建 Adapter 有限错误前再次脱敏，作为所有错误出口的最终安全边界。 */
  private createError(
    code: AgentRuntimeAdapterErrorCode,
    message: string
  ): AgentRuntimeAdapterError {
    return new AgentRuntimeAdapterError(code, this.safeRedact(message))
  }

  /** 保留已归一化错误，其余异常统一转换为带上下文的有限 Adapter 错误。 */
  private toAdapterError(
    error: unknown,
    code: AgentRuntimeAdapterErrorCode,
    prefix: string
  ): AgentRuntimeAdapterError {
    if (error instanceof AgentRuntimeAdapterError) return error
    return this.createError(code, `${prefix}：${this.redactError(error)}`)
  }

  /** 将恢复失败区分为会话缺失与通用失败，同时只使用已脱敏文本做诊断。 */
  private toRestoreError(error: unknown, prefix: string): AgentRuntimeAdapterError {
    const message = this.redactError(error)
    const code: AgentRuntimeAdapterErrorCode = /not[ -]?found|unknown session|未找到|不存在/i.test(
      message
    )
      ? 'session-not-found'
      : 'operation-failed'
    return this.createError(code, `${prefix}：${message}`)
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

/**
 * 构造 Grok Runtime 专属的最小环境，避免宿主密钥、npm 凭据和其他无关变量被子进程继承。
 * Provider Key 只进入 Grok Runtime，并由生成的 shell_environment_policy 从工具子进程中剔除。
 */
export function buildGrokRuntimeEnvironment(
  providerConfig: ProviderRuntimeConfig,
  grokHome: string,
  sourceEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const name of RUNTIME_ENV_ALLOWLIST) {
    const value = sourceEnvironment[name]
    if (value) environment[name] = value
  }

  environment.PATH = [join(homedir(), '.grok/bin'), sourceEnvironment.PATH]
    .filter(Boolean)
    .join(delimiter)
  environment.GROK_HOME = grokHome
  if (providerConfig.authMode === 'bearer' && providerConfig.apiKey) {
    environment[AGENT_STUDIO_MODEL_API_KEY_ENV] = providerConfig.apiKey
  }
  return environment
}
