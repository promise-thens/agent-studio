import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
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
  type AgentRuntimeMcpServer,
  type AgentRuntimePermissionCancellation,
  type AgentRuntimePermissionResolution,
  type AgentRuntimeSessionContext,
  type AgentRuntimeSessionRef,
  type AgentRuntimeTurnContext,
  type AgentRuntimeTurnRef,
  type AgentRuntimeTurnResult
} from '../../agent/agent-runtime-adapter'
import { toAcpMcpServers } from '../../mcp/mcp-server-to-acp'
import { updateAgentRuntimeCapabilitySnapshot } from '../../agent/runtime-capabilities'
import type { ProviderRuntimeConfig } from '../../provider/provider-config-store'
import {
  AGENT_STUDIO_MODEL_ALIAS,
  AGENT_STUDIO_MODEL_API_KEY_ENV,
  writeGrokProviderConfig
} from '../../provider/grok-provider-config'
import type { AgentAvailableCommand } from '../../../shared/agent-available-command'
import {
  GROK_RUNTIME_ID,
  areGrokAuthorizationSnapshotsEquivalent,
  isSafeGrokToolCallId,
  createGrokCapabilitySnapshot,
  createGrokEventBase,
  mapGrokAvailableCommands,
  mapGrokInitializeCapabilitySnapshot,
  mapGrokPermissionRequest,
  mapGrokPromptResponse,
  mapGrokSessionUpdate,
  mergeGrokToolCallAuthorizationPatch,
  type GrokToolCallAuthorizationSnapshot
} from './grok-acp-mappers'
import {
  CONTROLLED_ACP_E2E_DIRECTORIES,
  CONTROLLED_ACP_E2E_FIXTURE_FILE,
  CONTROLLED_ACP_E2E_SCENARIOS,
  CONTROLLED_ACP_E2E_ADAPTER_TRACE_FILE,
  type ControlledAcpFixtureLaunch
} from './controlled-acp-fixture'
import {
  describeSessionIdShape,
  summarizeInitializeResponse,
  summarizePermissionRequest,
  summarizeSessionUpdate,
  type GrokAcpObservationRecord,
  type GrokAcpProtocolObserver
} from './grok-acp-protocol-observer'

interface PendingPermission {
  request: AgentRuntimePermissionCancellation
  activeTurn: ActiveTurn
  allowOnceOptionId?: string
  rejectOnceOptionId?: string
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
  toolCallAuthorizationSnapshots: Map<string, GrokToolCallAuthorizationSnapshot>
  terminalToolCallIds: Set<string>
  rejectAllToolPermissions: boolean
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
const MAX_PERMISSION_OPTION_ID_BYTES = 4 * 1024
const MAX_TOOL_CALL_AUTHORIZATION_SNAPSHOTS = 2_000
const MAX_TERMINAL_TOOL_CALL_IDS = 2_000

export interface GrokAcpAdapterOptions {
  userDataPath: string
  getProviderConfig: () => ProviderRuntimeConfig | null
  redactText: (text: string) => string
  /** 仅由 Main 开发态 E2E bootstrap 注入；绝不接受 Renderer、IPC 或普通环境变量。 */
  controlledFixture?: ControlledAcpFixtureLaunch
  /** 仅 GACP-01 真机观察 bootstrap 注入；生产路径必须缺省。 */
  protocolObserver?: GrokAcpProtocolObserver
  /** 已映射的 MCP 描述；Adapter 转成 ACP，不自己 spawn MCP。 */
  getMcpServers?: () => Promise<readonly AgentRuntimeMcpServer[]> | readonly AgentRuntimeMcpServer[]
  /** 缺省视为开启，避免宿主 GROK_MEMORY=0 把桌面记忆关掉。 */
  isMemoryEnabled?: () => Promise<boolean> | boolean
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
  /**
   * 当前 Runtime session 绑定的产品 Task。
   * 命令快照常在 startTurn 之前到达，不能从 activeTurn 或 AgentRuntimeSessionRef 读取。
   */
  private boundTaskId: string | null = null
  /** 单调递增，含空列表清空；跨 disconnect 不归零，避免 Service 丢弃重连后的新快照。 */
  private availableCommandsRevision = 0
  private activeTurn: ActiveTurn | null = null
  private pendingPermissions = new Map<string, PendingPermission>()
  private controlledTraceWrite: Promise<void> = Promise.resolve()
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

    let child: ChildProcessWithoutNullStreams
    if (this.options.controlledFixture) {
      try {
        child = await this.spawnControlledFixture(workspace, this.options.controlledFixture)
      } catch {
        // 受控 E2E 的校验错误不携带路径或环境，避免测试日志成为额外的信息出口。
        const adapterError = this.createError(
          'operation-failed',
          '无法启动受控 ACP Runtime Electron E2E。'
        )
        this.updateStatus({ state: 'error', message: adapterError.message, workspace })
        throw adapterError
      }
    } else {
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

      // 生产默认启动参数必须保持原样，不能经由通用 command/args 抽象。
      const memoryEnabled = (await this.options.isMemoryEnabled?.()) ?? true
      child = spawn(
        this.resolveBinary(),
        ['--no-auto-update', 'agent', '--no-leader', '-m', AGENT_STUDIO_MODEL_ALIAS, 'stdio'],
        {
          cwd: workspace,
          env: buildGrokRuntimeEnvironment(providerConfig, grokHome, process.env, {
            memoryEnabled
          }),
          stdio: ['pipe', 'pipe', 'pipe']
        }
      )
    }
    const connectionGeneration = ++this.connectionGeneration
    this.process = child

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => {
      // Runtime stderr 只在主进程排空并脱敏，不提升为产品事件。
      void this.safeRedact(text)
      if (text.trim()) this.observe({ kind: 'stderr', hasText: true })
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
    this.assertProductTaskId(context.taskId)
    const current = this.beginSessionOperation(context.workspace)
    const previousTaskId = this.boundTaskId
    const previousSelectedSession = this.selectedSession

    try {
      const response = await current.connection.newSession({
        cwd: context.workspace,
        mcpServers: await this.resolveAcpMcpServers(context.mcpServers)
      })
      this.assertSessionOperationCurrent(current)
      if (!response.sessionId) {
        this.observe({
          kind: 'session-op',
          method: 'new',
          sessionIdShape: 'empty',
          ok: false,
          errorCode: 'operation-failed'
        })
        throw this.createError('operation-failed', 'Runtime 未返回有效会话标识。')
      }
      this.observe({
        kind: 'session-op',
        method: 'new',
        sessionIdShape: describeSessionIdShape(response.sessionId),
        ok: true
      })
      const session: AgentRuntimeSessionRef = {
        runtimeId: GROK_RUNTIME_ID,
        runtimeSessionId: response.sessionId,
        workspace: context.workspace
      }
      // newSession 返回 sessionId 后立刻认这个 session：set_model 完成前 Grok 就会推命令快照。
      this.adoptSession(session, context.taskId)
      await this.bindAgentStudioModel(current, response.sessionId, context.workspace)
      this.activateSession(session, context.taskId)
      this.verifyCapability('session.create', 'stable')
      return session
    } catch (error) {
      this.rollbackAdoptedSession(current, previousTaskId, previousSelectedSession)
      if (error instanceof AgentRuntimeAdapterError) throw error
      this.assertSessionOperationCurrent(current)
      throw this.toAdapterError(error, 'operation-failed', '创建 Runtime 会话失败')
    }
  }

  /** 只在 initialize 明确声明 load 后尝试恢复，首次真实成功后再提升为 verified。 */
  async loadSession(
    session: AgentRuntimeSessionRef,
    taskId: string,
    mcpServers?: AgentRuntimeMcpServer[]
  ): Promise<void> {
    this.assertSessionRef(session)
    this.assertProductTaskId(taskId)
    this.assertRestoreCapability('session.load')
    const current = this.beginSessionOperation(session.workspace)
    const previousTaskId = this.boundTaskId
    const previousSelectedSession = this.selectedSession

    try {
      await current.connection.loadSession({
        sessionId: session.runtimeSessionId,
        cwd: session.workspace,
        mcpServers: await this.resolveAcpMcpServers(mcpServers)
      })
      this.assertSessionOperationCurrent(current)
      // load RPC 返回后立刻认 session，避免 set_model 窗口丢掉 available_commands_update。
      this.adoptSession(session, taskId)
      await this.bindAgentStudioModel(current, session.runtimeSessionId, session.workspace)
      this.activateSession(session, taskId)
      this.verifyCapability('session.load', 'stable')
      this.observe({
        kind: 'session-op',
        method: 'load',
        sessionIdShape: describeSessionIdShape(session.runtimeSessionId),
        ok: true
      })
    } catch (error) {
      this.rollbackAdoptedSession(current, previousTaskId, previousSelectedSession)
      this.observe({
        kind: 'session-op',
        method: 'load',
        sessionIdShape: describeSessionIdShape(session.runtimeSessionId),
        ok: false,
        errorCode: error instanceof AgentRuntimeAdapterError ? error.code : 'operation-failed'
      })
      if (error instanceof AgentRuntimeAdapterError) throw error
      this.assertSessionOperationCurrent(current)
      throw this.toRestoreError(error, '加载 Runtime 会话失败')
    }
  }

  /** resume 不回放历史事件，用于 Task 切回时恢复原 Grok 上下文。 */
  async resumeSession(
    session: AgentRuntimeSessionRef,
    taskId: string,
    mcpServers?: AgentRuntimeMcpServer[]
  ): Promise<void> {
    this.assertSessionRef(session)
    this.assertProductTaskId(taskId)
    this.assertRestoreCapability('session.resume')
    const current = this.beginSessionOperation(session.workspace)
    const previousTaskId = this.boundTaskId
    const previousSelectedSession = this.selectedSession

    try {
      await current.connection.resumeSession({
        sessionId: session.runtimeSessionId,
        cwd: session.workspace,
        mcpServers: await this.resolveAcpMcpServers(mcpServers)
      })
      this.assertSessionOperationCurrent(current)
      // resume RPC 返回后立刻认 session，避免 set_model 窗口丢掉 available_commands_update。
      this.adoptSession(session, taskId)
      await this.bindAgentStudioModel(current, session.runtimeSessionId, session.workspace)
      this.activateSession(session, taskId)
      this.verifyCapability('session.resume', 'stable')
      this.observe({
        kind: 'session-op',
        method: 'resume',
        sessionIdShape: describeSessionIdShape(session.runtimeSessionId),
        ok: true
      })
    } catch (error) {
      this.rollbackAdoptedSession(current, previousTaskId, previousSelectedSession)
      this.observe({
        kind: 'session-op',
        method: 'resume',
        sessionIdShape: describeSessionIdShape(session.runtimeSessionId),
        ok: false,
        errorCode: error instanceof AgentRuntimeAdapterError ? error.code : 'operation-failed'
      })
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
      this.clearAvailableCommandSnapshot()
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

    this.observe({
      kind: 'session-op',
      method: 'close',
      sessionIdShape: describeSessionIdShape(session.runtimeSessionId),
      ok: closeError == null,
      ...(closeError ? { errorCode: closeError.code } : {})
    })
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
      toolCallAuthorizationSnapshots: new Map(),
      terminalToolCallIds: new Set(),
      rejectAllToolPermissions: false,
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
      if (typeof response.stopReason === 'string') {
        this.observe({ kind: 'prompt-stop', stopReason: response.stopReason })
      }
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

  respondPermission(requestId: string, resolution: AgentRuntimePermissionResolution): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return

    this.pendingPermissions.delete(requestId)
    if (!this.isActiveTurnCurrent(pending.activeTurn)) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
      return
    }
    const optionId =
      resolution === 'allow-once'
        ? pending.allowOnceOptionId
        : resolution === 'deny-once'
          ? pending.rejectOnceOptionId
          : undefined
    pending.resolve(
      optionId
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

    this.observe(
      summarizeInitializeResponse(
        response as unknown as Record<string, unknown>,
        acp.PROTOCOL_VERSION
      )
    )
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
    if (
      activeTurn.rejectAllToolPermissions ||
      activeTurn.terminalToolCallIds.has(params.toolCall.toolCallId) ||
      params.toolCall.status === 'completed' ||
      params.toolCall.status === 'failed'
    ) {
      this.markToolCallTerminal(activeTurn, params.toolCall.toolCallId)
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    }
    if (!isSafeGrokToolCallId(params.toolCall.toolCallId)) {
      this.rejectAllToolPermissions(activeTurn)
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    }

    const id = randomUUID()
    const { allowOnceOptionId, rejectOnceOptionId } = findPermissionOptions(params)
    this.observe(summarizePermissionRequest(params as unknown as Record<string, unknown>))
    const previousSnapshot = activeTurn.toolCallAuthorizationSnapshots.get(
      params.toolCall.toolCallId
    )
    const authorizationSnapshot = mergeGrokToolCallAuthorizationPatch(
      previousSnapshot,
      params.toolCall
    )
    this.rememberToolCallAuthorizationSnapshot(activeTurn, authorizationSnapshot)
    if (activeTurn.rejectAllToolPermissions) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    }
    if (
      previousSnapshot &&
      !areGrokAuthorizationSnapshotsEquivalent(previousSnapshot, authorizationSnapshot)
    ) {
      // 新权限请求改写了同一 ToolCall 的授权事实，旧审批必须先撤销，避免批准陈旧目标。
      this.cancelPendingPermissionsForToolCall(activeTurn, params.toolCall.toolCallId)
    }
    const request = mapGrokPermissionRequest(
      params,
      id,
      activeTurn.taskId,
      activeTurn.turnId,
      (text) => this.safeRedact(text),
      allowOnceOptionId != null,
      authorizationSnapshot
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
        request: {
          requestId: id,
          runtimeId: GROK_RUNTIME_ID,
          taskId: activeTurn.taskId,
          turnId: activeTurn.turnId,
          runtimeSessionId: activeTurn.runtimeSessionId,
          toolCallId: params.toolCall.toolCallId
        },
        activeTurn,
        ...(request.executionSupported && allowOnceOptionId ? { allowOnceOptionId } : {}),
        ...(rejectOnceOptionId ? { rejectOnceOptionId } : {}),
        resolve
      })
      // E2E trace 只记录固定 ToolCall 身份；不会写入 Prompt、选项、路径或 Provider 数据。
      this.recordControlledFixtureTrace('adapter-permission-pending', params.toolCall.toolCallId)
      try {
        this.sink.onPermission(request)
      } catch {
        this.pendingPermissions.delete(id)
        resolve({ outcome: { outcome: 'cancelled' } })
      }
    })
  }

  /**
   * 命令快照走 session 旁路：连接/session 匹配即可，不要求 activeTurn。
   * Grok 常在 session/new 之后、prompt 之前广告斜杠命令；其它 update 仍必须落在当前 Turn。
   */
  private handleSessionUpdate(
    params: acp.SessionNotification,
    sourceConnection: acp.ClientSideConnection
  ): void {
    if (
      sourceConnection !== this.connection ||
      !this.selectedSession ||
      this.selectedSession.runtimeSessionId !== params.sessionId
    ) {
      return
    }

    const update = params.update
    if (update.sessionUpdate === 'available_commands_update') {
      this.observe(summarizeSessionUpdate(update as unknown as Record<string, unknown>))
      if (this.boundTaskId) {
        this.pushAvailableCommandSnapshot(
          this.boundTaskId,
          mapGrokAvailableCommands(update, (text) => this.safeRedact(text))
        )
      }
      return
    }

    const activeTurn = this.activeTurn
    if (
      !activeTurn ||
      activeTurn.connection !== sourceConnection ||
      !this.isActiveTurnCurrent(activeTurn) ||
      activeTurn.runtimeSessionId !== params.sessionId
    ) {
      return
    }

    this.observe(summarizeSessionUpdate(update as unknown as Record<string, unknown>))
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      if (!isSafeGrokToolCallId(update.toolCallId)) {
        this.rejectAllToolPermissions(activeTurn)
      } else if (update.status === 'completed' || update.status === 'failed') {
        this.markToolCallTerminal(activeTurn, update.toolCallId)
      } else if (
        !activeTurn.rejectAllToolPermissions &&
        !activeTurn.terminalToolCallIds.has(update.toolCallId)
      ) {
        const previousSnapshot = activeTurn.toolCallAuthorizationSnapshots.get(update.toolCallId)
        const snapshot = mergeGrokToolCallAuthorizationPatch(previousSnapshot, update)
        this.rememberToolCallAuthorizationSnapshot(activeTurn, snapshot)
        if (
          previousSnapshot &&
          !activeTurn.rejectAllToolPermissions &&
          !areGrokAuthorizationSnapshotsEquivalent(previousSnapshot, snapshot)
        ) {
          // title、status 等展示更新不撤销审批；真实授权事实变化才使旧审批失效。
          this.cancelPendingPermissionsForToolCall(activeTurn, update.toolCallId)
        }
      }
    }

    for (const draft of mapGrokSessionUpdate(params, (text) => this.safeRedact(text))) {
      this.emitDraft(activeTurn, draft)
    }
  }

  /**
   * 权限事实只保留在当前 Turn；容量超限后拒绝本 Turn 后续工具授权，禁止淘汰旧项后复活身份。
   */
  private rememberToolCallAuthorizationSnapshot(
    activeTurn: ActiveTurn,
    snapshot: GrokToolCallAuthorizationSnapshot
  ): void {
    activeTurn.toolCallAuthorizationSnapshots.delete(snapshot.toolCallId)
    activeTurn.toolCallAuthorizationSnapshots.set(snapshot.toolCallId, snapshot)
    if (activeTurn.toolCallAuthorizationSnapshots.size <= MAX_TOOL_CALL_AUTHORIZATION_SNAPSHOTS) {
      return
    }
    activeTurn.toolCallAuthorizationSnapshots.clear()
    this.rejectAllToolPermissions(activeTurn)
  }

  private rejectAllToolPermissions(activeTurn: ActiveTurn): void {
    activeTurn.rejectAllToolPermissions = true
    activeTurn.terminalToolCallIds.clear()
    activeTurn.toolCallAuthorizationSnapshots.clear()
    this.cancelPendingPermissions(activeTurn)
  }

  /** ToolCall 终态先建立 tombstone，再删除快照并精确撤销同一 ToolCall 的等待权限。 */
  private markToolCallTerminal(activeTurn: ActiveTurn, toolCallId: string): void {
    if (activeTurn.rejectAllToolPermissions) {
      this.cancelPendingPermissionsForToolCall(activeTurn, toolCallId)
      return
    }
    if (!activeTurn.terminalToolCallIds.has(toolCallId)) {
      if (activeTurn.terminalToolCallIds.size >= MAX_TERMINAL_TOOL_CALL_IDS) {
        this.rejectAllToolPermissions(activeTurn)
        return
      }
      activeTurn.terminalToolCallIds.add(toolCallId)
    }
    activeTurn.toolCallAuthorizationSnapshots.delete(toolCallId)
    this.cancelPendingPermissionsForToolCall(activeTurn, toolCallId)
  }

  /** 只撤销完全匹配当前 Turn 与 ToolCall 的权限，其他并发请求保持 FIFO。 */
  private cancelPendingPermissionsForToolCall(activeTurn: ActiveTurn, toolCallId: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.activeTurn !== activeTurn || pending.request.toolCallId !== toolCallId) continue
      this.cancelPendingPermission(requestId, pending)
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
      this.cancelPendingPermission(requestId, pending)
    }
  }

  private cancelPendingPermission(requestId: string, pending: PendingPermission): void {
    this.pendingPermissions.delete(requestId)
    pending.resolve({ outcome: { outcome: 'cancelled' } })
    this.recordControlledFixtureTrace('adapter-permission-cancelled', pending.request.toolCallId)
    try {
      this.sink.onPermissionCancelled(pending.request)
    } catch {
      // 服务层通知失败不影响 ACP Promise 的本地安全收束。
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

  private isSessionOperationCurrent(current: CurrentConnection): boolean {
    return (
      this.connection === current.connection &&
      this.connectionGeneration === current.connectionGeneration &&
      this.sessionOperationGeneration === current.sessionOperationGeneration
    )
  }

  private assertSessionOperationCurrent(current: CurrentConnection): void {
    if (!this.isSessionOperationCurrent(current)) {
      throw this.createError('invalid-state', 'Runtime 会话操作已失效。')
    }
  }

  /**
   * 拿到 Runtime sessionId 后立刻绑定产品和 selectedSession。
   * 必须早于 set_model：Grok 常在这个窗口推 available_commands_update。
   */
  private adoptSession(session: AgentRuntimeSessionRef, taskId: string): void {
    this.rebindProductTask(taskId)
    this.selectedSession = { ...session }
  }

  /**
   * load/resume/new 失败且本次操作仍有效时滚回绑定。
   * set_model 失败已经 disconnectInternal，不能把 Task 绑回已死 session。
   */
  private rollbackAdoptedSession(
    current: CurrentConnection,
    previousTaskId: string | null,
    previousSelectedSession: AgentRuntimeSessionRef | null
  ): void {
    if (!this.isSessionOperationCurrent(current)) return
    if (previousTaskId) this.rebindProductTask(previousTaskId)
    else this.clearAvailableCommandSnapshot()
    this.selectedSession = previousSelectedSession ? { ...previousSelectedSession } : null
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
        this.observe({
          kind: 'set-model',
          accepted: false,
          responseShape: response === null ? 'null' : 'missing'
        })
        throw this.createError(
          'operation-failed',
          'Grok Runtime 未确认 Agent Studio 模型绑定，已阻止继续执行。'
        )
      }
      this.observe({ kind: 'set-model', accepted: true, responseShape: 'object' })
    } catch (error) {
      // Runtime 可能已经切换到目标 session；绑定失败时必须废弃整条连接，避免本地仍记录旧 Task。
      this.assertSessionOperationCurrent(current)
      if (!(error instanceof AgentRuntimeAdapterError)) {
        this.observe({ kind: 'set-model', accepted: false, responseShape: 'failed' })
      }
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

  private activateSession(session: AgentRuntimeSessionRef, taskId: string): void {
    this.rebindProductTask(taskId)
    this.selectedSession = { ...session }
    this.sessionGeneration += 1
    this.updateStatus({
      state: 'ready',
      message: 'Grok Build 已连接',
      workspace: session.workspace,
      runtimeSessionId: session.runtimeSessionId
    })
  }

  private assertProductTaskId(taskId: string): void {
    if (typeof taskId !== 'string' || !taskId) {
      throw this.createError('invalid-state', '产品 Task 身份缺失。')
    }
  }

  /**
   * 切换绑定 Task。旧 Task 必须先收到空快照，命令板不能继续展示上一会话的广告。
   */
  private rebindProductTask(taskId: string): void {
    if (this.boundTaskId === taskId) return
    if (this.boundTaskId) {
      this.pushAvailableCommandSnapshot(this.boundTaskId, [])
    }
    this.boundTaskId = taskId
  }

  /** 断开、失败或关闭当前绑定会话时清空快照；没有绑定 Task 则不推送。 */
  private clearAvailableCommandSnapshot(): void {
    const taskId = this.boundTaskId
    if (!taskId) return
    this.pushAvailableCommandSnapshot(taskId, [])
    this.boundTaskId = null
  }

  private pushAvailableCommandSnapshot(taskId: string, commands: AgentAvailableCommand[]): void {
    this.availableCommandsRevision += 1
    try {
      this.sink.onAvailableCommands({
        taskId,
        revision: this.availableCommandsRevision,
        commands
      })
    } catch {
      // 服务层快照通知失败不影响 ACP 连接与 Turn 路径。
    }
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
    this.clearAvailableCommandSnapshot()

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
    this.clearAvailableCommandSnapshot()
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

  /**
   * 受控 Runtime 仅运行仓库内固定 fixture，且其路径与临时目录会在 Main 和 Adapter 两层复核。
   * 该分支不复用 Grok 的 HOME/PATH 继承环境，也不接受任意 executable、args 或 Renderer 输入。
   */
  private async spawnControlledFixture(
    workspace: string,
    launch: ControlledAcpFixtureLaunch
  ): Promise<ChildProcessWithoutNullStreams> {
    await assertControlledFixtureLaunch(this.options.userDataPath, workspace, launch)
    return spawn(
      process.execPath,
      [launch.fixturePath, '--scenario', launch.scenario, '--user-data', launch.userDataPath],
      {
        cwd: workspace,
        env: buildControlledFixtureEnvironment(launch.runtimeHomeDirectory, launch.userDataPath),
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
  }

  /** 观察记录缺省为空操作，避免生产路径多写协议字段。 */
  private observe(record: GrokAcpObservationRecord): void {
    this.options.protocolObserver?.record(record)
  }

  /** 受控 E2E 辅助 trace 按 Adapter 调用顺序串行写入，生产路径不会触及该文件。 */
  private recordControlledFixtureTrace(event: string, toolCallId: string): void {
    const launch = this.options.controlledFixture
    if (!launch) return
    const record = JSON.stringify({ source: 'adapter', event, toolCallId })
    this.controlledTraceWrite = this.controlledTraceWrite
      .catch(() => undefined)
      .then(() =>
        fs.appendFile(
          join(launch.traceDirectory, CONTROLLED_ACP_E2E_ADAPTER_TRACE_FILE),
          `${record}\n`,
          {
            encoding: 'utf8',
            mode: 0o600
          }
        )
      )
      .catch(() => undefined)
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
  private async resolveAcpMcpServers(
    explicit?: readonly AgentRuntimeMcpServer[]
  ): Promise<acp.McpServer[]> {
    const servers = explicit ?? (await this.options.getMcpServers?.()) ?? []
    return toAcpMcpServers(servers)
  }

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

/**
 * Adapter 侧再次验证受控 fixture 的不可变边界。
 * 即使未来 Main 装配出现回归，也不能将测试描述符变成任意本地子进程入口。
 */
async function assertControlledFixtureLaunch(
  userDataPath: string,
  workspace: string,
  launch: ControlledAcpFixtureLaunch
): Promise<void> {
  if (!isControlledFixtureScenario(launch.scenario)) throw new Error('invalid-controlled-fixture')
  if (resolve(launch.userDataPath) !== resolve(userDataPath)) {
    throw new Error('invalid-controlled-fixture')
  }
  await assertControlledFixtureDirectory(
    userDataPath,
    workspace,
    CONTROLLED_ACP_E2E_DIRECTORIES.workspace
  )
  await assertControlledFixtureDirectory(
    userDataPath,
    launch.traceDirectory,
    CONTROLLED_ACP_E2E_DIRECTORIES.trace
  )
  await assertControlledFixtureDirectory(
    userDataPath,
    launch.barrierDirectory,
    CONTROLLED_ACP_E2E_DIRECTORIES.barriers
  )
  await assertControlledFixtureDirectory(
    userDataPath,
    launch.runtimeHomeDirectory,
    CONTROLLED_ACP_E2E_DIRECTORIES.runtimeHome
  )

  const expectedDirectory = resolve(launch.repositoryRootPath, 'tests/e2e')
  const expectedPath = join(expectedDirectory, CONTROLLED_ACP_E2E_FIXTURE_FILE)
  if (resolve(launch.fixturePath) !== expectedPath) throw new Error('invalid-controlled-fixture')

  const [repositoryRootStats, directoryStats, fixtureStats] = await Promise.all([
    fs.lstat(launch.repositoryRootPath),
    fs.lstat(expectedDirectory),
    fs.lstat(launch.fixturePath)
  ])
  if (
    !repositoryRootStats.isDirectory() ||
    repositoryRootStats.isSymbolicLink() ||
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    !fixtureStats.isFile() ||
    fixtureStats.isSymbolicLink()
  ) {
    throw new Error('invalid-controlled-fixture')
  }
  const [canonicalRepositoryRoot, canonicalDirectory, canonicalFixture] = await Promise.all([
    fs.realpath(launch.repositoryRootPath),
    fs.realpath(expectedDirectory),
    fs.realpath(launch.fixturePath)
  ])
  if (
    canonicalRepositoryRoot !== resolve(launch.repositoryRootPath) ||
    canonicalDirectory !== join(canonicalRepositoryRoot, 'tests/e2e') ||
    canonicalFixture !== join(canonicalDirectory, CONTROLLED_ACP_E2E_FIXTURE_FILE) ||
    dirname(canonicalFixture) !== canonicalDirectory
  ) {
    throw new Error('invalid-controlled-fixture')
  }
}

/** 临时目录必须是 userData 的固定直接子目录，拒绝符号链接和跨目录描述符。 */
async function assertControlledFixtureDirectory(
  userDataPath: string,
  directory: string,
  expectedName: string
): Promise<void> {
  if (typeof directory !== 'string') throw new Error('invalid-controlled-fixture')
  const expectedPath = resolve(userDataPath, expectedName)
  if (resolve(directory) !== expectedPath) throw new Error('invalid-controlled-fixture')

  const [userDataStats, directoryStats] = await Promise.all([
    fs.lstat(userDataPath),
    fs.lstat(directory)
  ])
  if (
    !userDataStats.isDirectory() ||
    userDataStats.isSymbolicLink() ||
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink()
  ) {
    throw new Error('invalid-controlled-fixture')
  }
  const [canonicalUserData, canonicalDirectory] = await Promise.all([
    fs.realpath(userDataPath),
    fs.realpath(directory)
  ])
  if (canonicalDirectory !== join(canonicalUserData, expectedName)) {
    throw new Error('invalid-controlled-fixture')
  }
}

function isControlledFixtureScenario(
  value: unknown
): value is ControlledAcpFixtureLaunch['scenario'] {
  return (
    typeof value === 'string' &&
    CONTROLLED_ACP_E2E_SCENARIOS.includes(value as ControlledAcpFixtureLaunch['scenario'])
  )
}

/** 夹具进程只得到临时 HOME 与 userData 所在临时根，不继承宿主 PATH、凭据或 Provider 环境。 */
function buildControlledFixtureEnvironment(
  runtimeHomeDirectory: string,
  userDataPath: string
): NodeJS.ProcessEnv {
  const temporaryDirectory = dirname(userDataPath)
  const environment: NodeJS.ProcessEnv = {
    ELECTRON_RUN_AS_NODE: '1',
    HOME: runtimeHomeDirectory,
    USERPROFILE: runtimeHomeDirectory,
    // fixture 需以 tmpdir() 复核 userData 的直接父目录；这里传入派生路径而非宿主环境。
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory
  }
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
    if (systemRoot) {
      environment.SystemRoot = systemRoot
      environment.WINDIR = systemRoot
    }
  }
  return environment
}

/** optionId 必须在全部 options 中全局唯一，避免拒绝 ID 被 Runtime 同时解释为允许。 */
function findPermissionOptions(params: acp.RequestPermissionRequest): {
  allowOnceOptionId?: string
  rejectOnceOptionId?: string
} {
  const counts = new Map<string, number>()
  for (const option of params.options) {
    if (!isSafePermissionOptionId(option.optionId)) continue
    counts.set(option.optionId, (counts.get(option.optionId) ?? 0) + 1)
  }
  const uniqueByKind = (kind: 'allow_once' | 'reject_once'): string | undefined => {
    const matches = params.options.filter(
      (option) =>
        option.kind === kind &&
        isSafePermissionOptionId(option.optionId) &&
        counts.get(option.optionId) === 1
    )
    return matches.length === 1 ? matches[0].optionId : undefined
  }
  const allowOnceOptionId = uniqueByKind('allow_once')
  const rejectOnceOptionId = uniqueByKind('reject_once')
  return {
    ...(allowOnceOptionId ? { allowOnceOptionId } : {}),
    ...(rejectOnceOptionId ? { rejectOnceOptionId } : {})
  }
}

function isSafePermissionOptionId(optionId: string): boolean {
  return (
    Boolean(optionId.trim()) &&
    !optionId.includes('\0') &&
    Buffer.byteLength(optionId, 'utf8') <= MAX_PERMISSION_OPTION_ID_BYTES
  )
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
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  options: { memoryEnabled?: boolean } = {}
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
  // 显式写入，不继承宿主 GROK_MEMORY=0；设置页关闭记忆时才传 '0'。
  environment.GROK_MEMORY = options.memoryEnabled === false ? '0' : '1'
  if (providerConfig.authMode === 'bearer' && providerConfig.apiKey) {
    environment[AGENT_STUDIO_MODEL_API_KEY_ENV] = providerConfig.apiKey
  }
  return environment
}
