import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type {
  AgentCapabilityId,
  AgentCapabilityMaturity,
  AgentContextUsage,
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
  type AgentRuntimeQuestionRequest,
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
  AGENT_STUDIO_MODEL_API_KEY_ENV,
  getManagedGrokHome,
  writeGrokProviderConfig
} from '../../provider/grok-provider-config'
import {
  AGENT_STUDIO_MODEL_ALIAS,
  GROK_ACP_CLIENT_CAPABILITIES,
  GROK_ACP_PRODUCT_MESSAGES,
  GROK_PRODUCTION_AGENT_ARGV,
  GROK_SET_MODEL_METHOD,
  buildGrokAcpClientInfo,
  buildGrokControlledE2ESpawnArgs,
  buildGrokNewSessionRequest,
  classifyGrokConnectError,
  classifyGrokSpawnProcessError,
  isGrokCliMissingSpawnError,
  isGrokSetModelResponseValid,
  projectGrokHandshakeFields,
  resolveGrokAcpFailure
} from './grok-acp-dialect'
import type { AgentAvailableCommand } from '../../../shared/agent-available-command'
import type {
  AgentQuestionItem,
  AgentQuestionResponse
} from '../../../shared/agent-question'
import type { CommandEvidenceStore } from '../../command/command-evidence-store'
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
  mapGrokRuntimeImageContent,
  mapGrokSessionUpdate,
  mergeGrokToolCallAuthorizationPatch,
  type GrokToolCallAuthorizationSnapshot
} from './grok-acp-mappers'
import { buildGrokPromptContentBlocks } from './grok-acp-prompt-blocks'
import {
  DEFAULT_GROK_SESSION_MEDIA_ROOT,
  extractGrokRuntimeMediaPaths,
  readGrokSessionMediaFile,
  toolCallHasGrokRuntimeMedia
} from './grok-runtime-media'
import { readGrokSessionContextUsage } from './grok-session-signals'
import {
  accumulateGrokCommandToolFacts,
  isGrokCommandEvidenceCandidate,
  mapGrokCommandEvidence,
  rememberGrokCommandToolFacts,
  type GrokCommandEvidenceMapping,
  type GrokCommandToolFacts
} from './grok-command-evidence-mapper'
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

/** ask-debug 取消归因；只写枚举值，不写答案正文。 */
type AskCancelReason =
  | 'user-cancel'
  | 'stale-turn'
  | 'pending-clear'
  | 'cancel-turn'
  | 'disconnect'
  | 'service-not-current'
  | 'onQuestion-throw'
  | 'queue-full'

/**
 * Adapter 契约的 cancelReason 是 string（参数逆变，实现不能比基类更窄）。
 * 未知字符串不进归因，避免把任意正文写进 ask-debug。
 */
function resolveAskCancelReason(
  value: string | undefined,
  fallback: AskCancelReason
): AskCancelReason {
  switch (value) {
    case 'user-cancel':
    case 'stale-turn':
    case 'pending-clear':
    case 'cancel-turn':
    case 'disconnect':
    case 'service-not-current':
    case 'onQuestion-throw':
    case 'queue-full':
      return value
    default:
      return fallback
  }
}

type PendingClearSource = 'turn-complete' | 'cancel-turn' | 'disconnect'

interface QuestionResolveMeta {
  cancelReason?: AskCancelReason
  honoredDespiteStaleGeneration?: boolean
}

interface PendingQuestion {
  request: AgentRuntimeQuestionRequest
  activeTurn: ActiveTurn
  resolve: (response: AgentQuestionResponse, meta?: QuestionResolveMeta) => void
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
  /** prompt 已终态但 ask 仍挂起时暂存的 turn-complete draft；答完后再发布。 */
  deferredTurnComplete?: AgentEventDraft
  /** Session update 串行队列，确保图片落盘与文本、工具、终态保持 ACP 到达顺序。 */
  sessionUpdateQueue: Promise<void>
  /** 仅在图片异步入库期间开启；普通文本与工具更新继续同步处理。 */
  sessionUpdateQueueActive: boolean
  /** 同一 Turn 的坏图片只提示一次，避免 Runtime 连续脏块刷满时间线。 */
  runtimeAttachmentErrorReported: boolean
  /** 同一 Turn 已入库的 session 媒体路径，避免 tool_call 与 update 重复落盘。 */
  ingestedRuntimeMediaKeys: Set<string>
  /** signals.json 已发布的最后一份上下文用量；同值快照只允许进入事件链一次。 */
  lastContextUsageFingerprint?: string
  /** Turn 进行中轮询 signals.json 的定时器；终态必须清掉。 */
  contextUsagePollTimer?: ReturnType<typeof setInterval>
  /** 当前 Turn 内命令证据累积；测试夹具可能缺省，读取时必须惰性创建。 */
  commandEvidenceByToolCallId?: Map<string, GrokCommandToolFacts>
}

/** Grok 多数不发 ACP usage_update；Turn 进行中按这个间隔补读 signals.json。 */
export const GROK_CONTEXT_USAGE_POLL_MS = 1000

interface CurrentConnection {
  connection: acp.ClientSideConnection
  connectionGeneration: number
  sessionOperationGeneration: number
}

interface GrokSetModelRequest {
  sessionId: string
  modelId: string
}

const MAX_PERMISSION_OPTION_ID_BYTES = 4 * 1024
const MAX_TOOL_CALL_AUTHORIZATION_SNAPSHOTS = 2_000
const MAX_TERMINAL_TOOL_CALL_IDS = 2_000

/** 只用 token 数量生成去重键，不把 Runtime 原始快照带入事件或日志。 */
function contextUsageFingerprint(usage: AgentContextUsage): string {
  return `${usage.usedTokens}:${usage.limitTokens}`
}

const GROK_QUESTION_METHODS = new Set([
  // Grok 1.0.13 的真实 ACP 请求使用裸方法名；保留命名空间写法兼容其它版本。
  'ask_user_question',
  'askUserQuestion',
  '_ask_user_question',
  '_askUserQuestion',
  'x.ai/ask_user_question',
  'x.ai/askUserQuestion',
  // Grok ACP 会把扩展请求加上 `_` 命名空间前缀；保留两种写法兼容不同版本。
  '_x.ai/ask_user_question',
  '_x.ai/askUserQuestion',
  'x.ai/session/askUserQuestion',
  '_x.ai/session/askUserQuestion',
  'x.ai/session/ask_user_question',
  '_x.ai/session/ask_user_question',
  'session/askUserQuestion',
  '_session/askUserQuestion',
  'session/ask_user_question',
  '_session/ask_user_question'
])
// 计划退出同样可能以裸扩展方法名到达，不能把它当成未知方法返回空对象。
const GROK_PLAN_APPROVAL_METHODS = new Set([
  'exit_plan_mode',
  'x.ai/exit_plan_mode',
  '_x.ai/exit_plan_mode'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** ACP SDK 把 extMethod params 标成 Record，运行时仍可能是 RawValue 字符串。 */
function coerceGrokExtMethodParams(params: unknown): Record<string, unknown> {
  const record = (() => {
    if (typeof params === 'string') {
      try {
        const parsed: unknown = JSON.parse(params)
        return isRecord(parsed) ? parsed : {}
      } catch {
        return {}
      }
    }
    return isRecord(params) ? params : {}
  })()
  // 部分版本把问卷放在 request/params 里；顶层已有 questions 时不要覆盖。
  if (
    !Array.isArray(record.questions) &&
    isRecord(record.request) &&
    Array.isArray(record.request.questions)
  ) {
    return { ...record, ...record.request }
  }
  if (
    !Array.isArray(record.questions) &&
    isRecord(record.params) &&
    Array.isArray(record.params.questions)
  ) {
    return { ...record, ...record.params }
  }
  return record
}

const GROK_EXT_METHOD_ENVELOPES = new Set(['ext_method', '_ext_method'])

/** Grok xai-acp-lib 把扩展请求打成 JSON-RPC `ext_method`，内部 method 才是 x.ai/ask_user_question。 */
function unwrapGrokExtMethodEnvelope(
  method: string,
  params: unknown
): { method: string; params: Record<string, unknown> } {
  const payload = coerceGrokExtMethodParams(params)
  if (!GROK_EXT_METHOD_ENVELOPES.has(method) || typeof payload.method !== 'string') {
    return { method, params: payload }
  }
  return {
    method: payload.method,
    params: coerceGrokExtMethodParams(payload.params ?? payload.request ?? payload)
  }
}

function boundedText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) return fallback
  const trimmed = value.trim()
  return trimmed || fallback
}

/** 把 Grok 私有 AskUserQuestion 的有限字段投影成中性问答 DTO。 */
function mapGrokQuestionRequest(
  params: Record<string, unknown>,
  activeTurn: ActiveTurn,
  requestId: string
): AgentRuntimeQuestionRequest | null {
  const rawQuestions = Array.isArray(params.questions)
    ? params.questions
    : isRecord(params.request) && Array.isArray(params.request.questions)
      ? params.request.questions
      : []
  if (rawQuestions.length === 0 || rawQuestions.length > 20) return null

  const questions: AgentQuestionItem[] = []
  const questionIds = new Set<string>()
  for (let index = 0; index < rawQuestions.length; index += 1) {
    const raw = rawQuestions[index]
    if (!isRecord(raw)) return null
    const question = boundedText(raw.question ?? raw.prompt)
    if (!question) return null
    const rawOptions = Array.isArray(raw.options) ? raw.options : []
    if (rawOptions.length > 50) return null
    const options = rawOptions.flatMap((option, optionIndex) => {
      if (!isRecord(option)) return []
      const label = boundedText(option.label ?? option.title)
      if (!label) return []
      const value = boundedText(option.value ?? option.id, label || `option-${optionIndex + 1}`)
      return [{
        value,
        label,
        ...(boundedText(option.description) ? { description: boundedText(option.description) } : {}),
        ...(boundedText(option.preview) ? { preview: boundedText(option.preview) } : {})
      }]
    })
    // 个别坏选项丢弃即可；全部失败时降成文本题，避免整张采访卡被取消。
    const multiSelect =
      raw.multiSelect === true || raw.multi_select === true || raw.multiple === true
    const kind: AgentQuestionItem['kind'] = options.length > 0
      ? multiSelect ? 'multi' : 'single'
      : 'text'
    const id = boundedText(raw.id ?? raw.questionId, `question-${index + 1}`)
    if (!id || questionIds.has(id)) return null
    questionIds.add(id)
    questions.push({
      id,
      question,
      kind,
      ...(options.length > 0 ? { options } : {}),
      required: raw.required !== false,
      // Grok 工具会在有选项的问题中提供 Other；Renderer 负责收集 notes。
      allowOther: true,
      ...(boundedText(raw.description) ? { description: boundedText(raw.description) } : {})
    })
  }

  const title = boundedText(params.title, 'Grok Build 需要你的回答')
  const message = boundedText(params.message ?? params.prompt, '请确认下面的问题后继续。')
  return {
    requestId,
    runtimeId: GROK_RUNTIME_ID,
    taskId: activeTurn.taskId,
    turnId: activeTurn.turnId,
    runtimeSessionId: activeTurn.runtimeSessionId,
    title,
    message,
    mode: params.mode === 'plan' ? 'plan' : 'default',
    questions,
    canSkip: params.mode === 'plan'
  }
}

/** 将 Renderer 使用的安全 question id/option value 投影回 Grok 原始键值。 */
function projectGrokQuestionAnswers(
  request: AgentRuntimeQuestionRequest,
  answers: Record<string, unknown>,
  sourceAnnotations?: Record<string, { preview?: string; notes?: string }>
): {
  answers: Record<string, string[]>
  annotations: Record<string, { preview?: string; notes?: string }>
} {
  const projected: Record<string, string[]> = {}
  const annotations: Record<string, { preview?: string; notes?: string }> = {}
  for (const [questionId, rawAnswer] of Object.entries(answers)) {
    const question = request.questions.find((item) => item.id === questionId)
    if (!question) continue
    const values = Array.isArray(rawAnswer) ? rawAnswer : [rawAnswer]
    const labels = values
      .filter((value): value is string | number | boolean =>
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      )
      .map((value) => String(value))
      .map((value) => question.options?.find((option) => option.value === value)?.label ?? value)
    if (labels.length > 0) projected[question.question] = labels
    const annotation = sourceAnnotations?.[questionId]
    if (annotation && (annotation.preview || annotation.notes)) {
      annotations[question.question] = annotation
    }
  }
  // Grok Accepted 变体固定 answers + annotations 两个字段；缺 annotations 会被当成非法回包并继续等待。
  return { answers: projected, annotations }
}

/**
 * Grok 1.0.13 AskUserQuestionExtResponse 只有 Accepted / SkipInterview / ChatAboutThis。
 * 没有 cancelled；取消或无法处理时必须回 skip_interview，否则反序列化失败、Ask 一直 Waiting。
 */
function grokAskSkipInterviewResponse(
  request: AgentRuntimeQuestionRequest | null,
  partialAnswers?: Record<string, string>
): Record<string, unknown> {
  return {
    outcome: 'skip_interview',
    partial_answers: request
      ? projectGrokPartialAnswers(request, partialAnswers)
      : {}
  }
}

function grokAskChatAboutThisResponse(
  request: AgentRuntimeQuestionRequest,
  partialAnswers?: Record<string, string>
): Record<string, unknown> {
  return {
    outcome: 'chat_about_this',
    partial_answers: projectGrokPartialAnswers(request, partialAnswers)
  }
}

/** 将 Plan 采访的局部回答从安全 question id 映射为 Grok 的问题文本键。 */
function projectGrokPartialAnswers(
  request: AgentRuntimeQuestionRequest,
  partialAnswers: Record<string, string> | undefined
): Record<string, string> {
  if (!partialAnswers) return {}
  const projected: Record<string, string> = {}
  for (const [questionId, answer] of Object.entries(partialAnswers)) {
    const question = request.questions.find((item) => item.id === questionId)
    if (!question) continue
    const values = answer.split(',').map((value) => value.trim()).filter(Boolean)
    projected[question.question] = values
      .map((value) => question.options?.find((option) => option.value === value)?.label ?? value)
      .join(', ')
  }
  return projected
}

/** 将 Grok x.ai/exit_plan_mode 映射为计划审阅卡，避免误走普通权限链而被自动取消。 */
function mapGrokPlanApprovalRequest(
  params: Record<string, unknown>,
  activeTurn: ActiveTurn,
  requestId: string
): AgentRuntimeQuestionRequest | null {
  const planContent = boundedText(params.planContent ?? params.plan_content)
  return {
    requestId,
    runtimeId: GROK_RUNTIME_ID,
    taskId: activeTurn.taskId,
    turnId: activeTurn.turnId,
    runtimeSessionId: activeTurn.runtimeSessionId,
    title: 'Grok Build 提交了计划',
    message: '请审阅计划后决定是否继续执行。',
    kind: 'plan-approval',
    ...(planContent ? { planContent } : {}),
    // 共享 DTO 要求至少有一道问题；计划审阅卡由专用按钮承载实际动作。
    questions: [
      {
        id: 'plan-review',
        question: '是否批准这份计划？',
        kind: 'single',
        options: [
          { value: 'approve', label: '批准并继续' },
          { value: 'abandon', label: '放弃计划' }
        ],
        required: true
      }
    ],
    canSkip: false
  }
}

/** 将标准 ACP form schema 投影成同一张问答卡，避免 Renderer 维护两套表单。 */
function mapElicitationRequest(
  params: acp.CreateElicitationRequest,
  activeTurn: ActiveTurn,
  requestId: string
): AgentRuntimeQuestionRequest | null {
  if (!isRecord(params)) return null
  // Grok 1.0.13 提问可能走自定义 elicitation_dialog，问卷仍是 questions 数组。
  if (params.mode !== 'form') {
    const grokRequest = mapGrokQuestionRequest(
      coerceGrokExtMethodParams(params),
      activeTurn,
      requestId
    )
    return grokRequest
  }
  const schema = isRecord(params.requestedSchema) ? params.requestedSchema : null
  const properties = schema && isRecord(schema.properties) ? schema.properties : null
  if (!properties) return null
  const required = schema?.required
  const questions: AgentQuestionItem[] = []
  const questionIds = new Set<string>()
  for (const [id, rawSchema] of Object.entries(properties)) {
    if (!isRecord(rawSchema)) return null
    const safeId = boundedText(id)
    if (!safeId || questionIds.has(safeId)) return null
    questionIds.add(safeId)
    const type = rawSchema.type
    const options = (() => {
      if (type !== 'string' && type !== 'array') return undefined
      const items = type === 'array' && isRecord(rawSchema.items) ? rawSchema.items : rawSchema
      const enumValues = Array.isArray(items.enum) ? items.enum : []
      const oneOf = Array.isArray(items.oneOf) ? items.oneOf : []
      if (oneOf.length > 0) {
        return oneOf.flatMap((item) => {
          if (!isRecord(item)) return []
          const value = boundedText(item.const)
          const label = boundedText(item.title, value)
          return value && label ? [{ value, label, ...(boundedText(item.description) ? { description: boundedText(item.description) } : {}) }] : []
        })
      }
      return enumValues.flatMap((value) => {
        const text = boundedText(value)
        return text ? [{ value: text, label: text }] : []
      })
    })()
    const kind: AgentQuestionItem['kind'] = type === 'boolean'
      ? 'boolean'
      : type === 'number' || type === 'integer'
        ? 'number'
        : type === 'array'
          ? 'multi'
          : options && options.length > 0 ? 'single' : 'text'
    questions.push({
      id: safeId,
      question: boundedText(rawSchema.title, safeId),
      kind,
      ...(options && options.length > 0 ? { options } : {}),
      required: Array.isArray(required) && required.includes(safeId),
      ...(boundedText(rawSchema.description) ? { description: boundedText(rawSchema.description) } : {})
    })
  }
  if (questions.length === 0 || questions.length > 20) return null
  return {
    requestId,
    runtimeId: GROK_RUNTIME_ID,
    taskId: activeTurn.taskId,
    turnId: activeTurn.turnId,
    runtimeSessionId: activeTurn.runtimeSessionId,
    title: boundedText(schema?.title, 'Grok Build 需要你的回答'),
    message: boundedText(params.message, '请填写下面的信息后继续。'),
    questions,
    canSkip: true
  }
}

export interface GrokAcpAdapterOptions {
  userDataPath: string
  getProviderConfig: () => ProviderRuntimeConfig | null
  /**
   * Main 在 app.whenReady() 后注入的 Client 版本。
   * 打包用 app.getVersion()；开发用 `${app.getVersion()}-dev`；测试注入假版本。
   * 禁止从 Renderer / IPC 传入。
   */
  getClientVersion: () => string
  redactText: (text: string) => string
  /** 仅由 Main 开发态 E2E bootstrap 注入；绝不接受 Renderer、IPC 或普通环境变量。 */
  controlledFixture?: ControlledAcpFixtureLaunch
  /** 仅 GACP-01 真机观察 bootstrap 注入；生产路径必须缺省。 */
  protocolObserver?: GrokAcpProtocolObserver
  /** 已映射的 MCP 描述；Adapter 转成 ACP，不自己 spawn MCP。 */
  getMcpServers?: () => Promise<readonly AgentRuntimeMcpServer[]> | readonly AgentRuntimeMcpServer[]
  /** 缺省视为开启，避免宿主 GROK_MEMORY=0 把桌面记忆关掉。 */
  isMemoryEnabled?: () => Promise<boolean> | boolean
  /**
   * 可选命令证据仓库。缺省时跳过持久化，避免既有测试与无存储组装路径失败。
   * Runtime 命令只记上报事实，不得改走 AppCommandRunner。
   */
  commandEvidenceStore?: CommandEvidenceStore
  /** 由组装层提供 Task environmentId；缺失则不落盘，禁止 Adapter 自造环境身份。 */
  resolveCommandEvidenceContext?: (
    taskId: string,
    turnId: string
  ) => { environmentId: string } | null
  /** Runtime 图片必须先由 Main inbox 持久化，Adapter 只接收可发布的有限引用。 */
  storeRuntimeImage?: (input: {
    taskId: string
    turnId: string
    originalName: string
    mimeType: string
    bytes: Buffer
  }) => Promise<{ attachmentId: string; attachmentKind: 'image'; originalName: string }>
  /** 仅测试注入 Grok session 媒体根；生产固定 /tmp/sessions。 */
  grokSessionMediaRoot?: string
  /** 仅测试注入 signals 根；生产固定为 App 专属 Managed GROK_HOME。 */
  grokSessionSignalsRoot?: string
  /**
   * 仅测试注入生产 spawn；缺省为 node:child_process.spawn。
   * 禁止 Renderer / IPC / 普通环境变量传入。
   */
  spawnProductionProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions
  ) => ChildProcessWithoutNullStreams
  /**
   * 仅测试注入受控 E2E spawn；缺省为 node:child_process.spawn。
   * 禁止 Renderer / IPC / 普通环境变量传入；生产路径不得设置。
   */
  spawnControlledProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions
  ) => ChildProcessWithoutNullStreams
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
  private pendingQuestions = new Map<string, PendingQuestion>()
  private controlledTraceWrite: Promise<void> = Promise.resolve()
  private supportsCloseSession = false
  private capabilitySnapshot: AgentRuntimeCapabilitySnapshot
  private promptMedia = { image: false, embeddedContext: false }
  private status: AgentRuntimeStatus
  private commandEvidenceWrites: Promise<void> = Promise.resolve()
  /**
   * 当前 connect 尝试期间子进程 error 事件缓存。
   * 握手可能先以非 ENOENT 失败；分类时优先认缺 CLI，避免笼统“连接失败”。
   */
  private connectProcessError: unknown | null = null

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
      const resolved = resolveGrokAcpFailure('provider-config-missing')
      const error = this.createError(resolved.adapterErrorCode, resolved.message)
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
        const resolved = resolveGrokAcpFailure('config-write-failed', {
          redactedDetail: this.redactError(error)
        })
        const adapterError = this.createError(resolved.adapterErrorCode, resolved.message)
        this.updateStatus({ state: 'error', message: adapterError.message, workspace })
        throw adapterError
      }

      // 生产默认启动参数必须保持原样，不能经由通用 command/args 抽象。
      const memoryEnabled = (await this.options.isMemoryEnabled?.()) ?? true
      const spawnProduction = this.options.spawnProductionProcess ?? spawn
      // 备注：stdio 全 pipe 时运行时一定是 WithoutNullStreams；测试注入必须返回同类形状。
      child = spawnProduction(this.resolveBinary(), [...GROK_PRODUCTION_AGENT_ARGV], {
        cwd: workspace,
        env: buildGrokRuntimeEnvironment(providerConfig, grokHome, process.env, {
          memoryEnabled
        }),
        stdio: ['pipe', 'pipe', 'pipe']
      }) as ChildProcessWithoutNullStreams
    }
    const connectionGeneration = ++this.connectionGeneration
    this.process = child
    this.connectProcessError = null

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => {
      // Runtime stderr 只在主进程排空并脱敏，不提升为产品事件。
      void this.safeRedact(text)
      if (text.trim()) this.observe({ kind: 'stderr', hasText: true })
    })
    child.once('error', (error) => {
      this.connectProcessError = error
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
        sessionUpdate: (params) => this.handleSessionUpdate(params, connection),
        unstable_createElicitation: (params) => this.requestElicitation(params, connection),
        extMethod: (method, params) => this.handleExtensionMethod(method, params, connection)
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
      if (!this.isCurrentConnection(connection, child, connectionGeneration)) {
        // 进程错误可能已抢先清连接；缺 CLI 仍必须抛出可区分错误给调用方。
        if (isGrokCliMissingSpawnError(this.connectProcessError)) {
          throw this.createCliMissingError(workspace)
        }
        return this.status
      }

      await this.disconnectInternal(false)
      // 握手可能先失败；再等一轮事件循环，让晚到的 ENOENT 有机会落袋。
      if (!isGrokCliMissingSpawnError(this.connectProcessError)) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      // 备注：缺 CLI 优先于笼统流错误；协议不兼容等仍走 resolveConnectFailure。
      const preferredError = isGrokCliMissingSpawnError(this.connectProcessError)
        ? this.connectProcessError
        : error
      const adapterError = this.resolveConnectFailure(preferredError)
      this.updateStatus({
        state: 'error',
        message: adapterError.message,
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
      // 只有 Task 快照接管时才写 `_meta.yoloMode`；这是把审批交给 Grok always-approve，
      // 不是 Permission Broker 沙箱；禁止透传未知 _meta。
      const response = await current.connection.newSession(
        buildGrokNewSessionRequest({
          cwd: context.workspace,
          mcpServers: await this.resolveAcpMcpServers(context.mcpServers),
          takeoverEnabled: context.takeoverEnabled === true
        })
      )
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
      cancelRequested: false,
      sessionUpdateQueue: Promise.resolve(),
      sessionUpdateQueueActive: false,
      runtimeAttachmentErrorReported: false,
      ingestedRuntimeMediaKeys: new Set(),
      commandEvidenceByToolCallId: new Map()
    }
    this.activeTurn = activeTurn
    this.updateStatus({
      state: 'busy',
      message: 'Grok Build 正在处理',
      workspace: context.workspace,
      runtimeSessionId: context.runtimeSessionId
    })

    try {
      // 先显示上一刻已知的窗口用量，让 Composer 在长 Turn 期间也有可见上下文基线。
      await this.publishSessionContextUsage(activeTurn, context.workspace)
      if (!this.isActiveTurnCurrent(activeTurn)) {
        return { outcome: activeTurn.outcome ?? 'cancelled' }
      }
      this.startContextUsagePolling(activeTurn, context.workspace)

      const response = await connection.prompt({
        sessionId: context.runtimeSessionId,
        prompt: buildGrokPromptContentBlocks({
          prompt: context.prompt,
          attachments: context.attachments ?? [],
          promptImage: this.promptMedia.image,
          embeddedContext: this.promptMedia.embeddedContext
        })
      })
      await this.waitForSessionUpdateQueue(activeTurn)
      if (!this.isActiveTurnCurrent(activeTurn)) {
        return { outcome: activeTurn.outcome ?? 'cancelled' }
      }

      // Grok 当前版本不一定发 ACP usage_update；在 Turn 终态前补读同一 session 的内部快照。
      await this.publishSessionContextUsage(activeTurn, context.workspace)
      if (!this.isActiveTurnCurrent(activeTurn)) {
        return { outcome: activeTurn.outcome ?? 'cancelled' }
      }

      this.verifyCapability('session.prompt.text', 'stable', undefined, false)
      if (typeof response.stopReason === 'string') {
        this.observe({ kind: 'prompt-stop', stopReason: response.stopReason })
      }
      // prompt 已返回但 ask 仍挂起时，先等用户作答，避免 turn-complete 触发 pending-clear。
      await this.waitForPendingQuestions(activeTurn)
      if (!this.isActiveTurnCurrent(activeTurn)) {
        return { outcome: activeTurn.outcome ?? 'cancelled' }
      }
      const terminal = mapGrokPromptResponse(response, context.runtimeSessionId)
      this.emitDraft(activeTurn, terminal)
      this.restoreReadyStatus(activeTurn)
      return { outcome: terminal.outcome }
    } catch (error) {
      await this.waitForSessionUpdateQueue(activeTurn)
      if (!this.isActiveTurnCurrent(activeTurn)) {
        return { outcome: activeTurn.outcome ?? 'cancelled' }
      }

      // 失败路径同样可能与 ask 竞态；先等用户作答或 Stop，避免 pending-clear 吞卡。
      await this.waitForPendingQuestions(activeTurn)
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
    } finally {
      this.stopContextUsagePolling(activeTurn)
    }
  }

  /** 取消只能命中完全匹配的当前 Turn，旧 Task/Turn 的晚到操作幂等忽略。 */
  async cancelTurn(turn: AgentRuntimeTurnRef): Promise<void> {
    const activeTurn = this.activeTurn
    if (!activeTurn || !this.matchesTurn(activeTurn, turn) || activeTurn.cancelRequested) return

    activeTurn.cancelRequested = true
    activeTurn.deferredTurnComplete = undefined
    this.stopContextUsagePolling(activeTurn)
    this.cancelPendingPermissions(activeTurn)
    this.cancelPendingQuestions(activeTurn, 'cancel-turn')
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

  /**
   * Renderer 回答后恢复挂起的 Grok 私有问答或 ACP elicitation Promise。
   * sessionGeneration 漂移时：同一 logical Turn（pending.request 的 task/turn/session）仍在、
   * 未 cancelRequested、连接仍是同一对象或选中同 runtimeSessionId，且动作为
   * accept|skip|chat-about-this|approve-plan|abandon-plan 时仍兑现；否则 stale-turn cancel。
   */
  respondQuestion(
    requestId: string,
    response: AgentQuestionResponse,
    options?: { cancelReason?: string }
  ): void {
    const pending = this.pendingQuestions.get(requestId)
    if (!pending) {
      this.traceAskProtocol({ stage: 'respond-miss', requestIdPrefix: requestId.slice(0, 8) })
      return
    }
    this.pendingQuestions.delete(requestId)
    const pendingTurn = pending.activeTurn
    const turnCurrent = this.isActiveTurnCurrent(pendingTurn)
    this.traceAskProtocol({
      stage: 'respond-in',
      requestIdPrefix: requestId.slice(0, 8),
      action: response.action,
      turnCurrent
    })

    if (turnCurrent) {
      // Turn 仍 current 但已请求取消：不能再兑现 accept。
      if (pendingTurn.cancelRequested) {
        this.traceAskProtocol({
          stage: 'ext-out',
          action: 'cancel',
          cancelReason: resolveAskCancelReason(options?.cancelReason, 'stale-turn'),
          sessionGeneration: this.sessionGeneration,
          pendingSessionGeneration: pendingTurn.sessionGeneration,
          activeTurnNull: false
        })
        pending.resolve(
          { action: 'cancel' },
          { cancelReason: resolveAskCancelReason(options?.cancelReason, 'stale-turn') }
        )
        return
      }
      this.traceAskProtocol({ stage: 'ext-out', action: response.action })
      if (response.action === 'cancel') {
        pending.resolve(response, {
          cancelReason: resolveAskCancelReason(options?.cancelReason, 'user-cancel')
        })
        this.flushDeferredTurnComplete(pendingTurn)
        return
      }
      pending.resolve(response)
      this.flushDeferredTurnComplete(pendingTurn)
      return
    }

    const current = this.activeTurn
    const sameLogicalTurn = Boolean(
      current &&
        !current.cancelRequested &&
        current.taskId === pending.request.taskId &&
        current.turnId === pending.request.turnId &&
        current.runtimeSessionId === pending.request.runtimeSessionId &&
        (current.connection === pendingTurn.connection ||
          this.selectedSession?.runtimeSessionId === pending.request.runtimeSessionId)
    )
    const honorable =
      response.action === 'accept' ||
      response.action === 'skip' ||
      response.action === 'chat-about-this' ||
      response.action === 'approve-plan' ||
      response.action === 'abandon-plan'
    if (sameLogicalTurn && honorable) {
      this.traceAskProtocol({
        stage: 'ext-out',
        action: response.action,
        note: 'honored-despite-generation-drift'
      })
      pending.resolve(response, { honoredDespiteStaleGeneration: true })
      this.flushDeferredTurnComplete(pendingTurn)
      return
    }

    const cancelReason = resolveAskCancelReason(options?.cancelReason, 'stale-turn')
    this.traceAskProtocol({
      stage: 'ext-out',
      action: 'cancel',
      cancelReason,
      sessionGeneration: this.sessionGeneration,
      pendingSessionGeneration: pendingTurn.sessionGeneration,
      activeTurnNull: current == null
    })
    pending.resolve({ action: 'cancel' }, { cancelReason })
  }

  /** ACP 标准 elicitation 请求和 Grok 私有问答共用一张阻塞式问答卡。 */
  private requestElicitation(
    params: acp.CreateElicitationRequest,
    sourceConnection: acp.ClientSideConnection
  ): Promise<acp.CreateElicitationResponse> {
    this.traceAskProtocol({
      stage: 'elicit-in',
      mode: params.mode,
      paramKeys: isRecord(params) ? Object.keys(params) : []
    })
    const activeTurn = this.activeTurn
    if (
      !activeTurn ||
      activeTurn.cancelRequested ||
      activeTurn.connection !== sourceConnection ||
      !this.isActiveTurnCurrent(activeTurn) ||
      ('sessionId' in params && params.sessionId !== activeTurn.runtimeSessionId)
    ) {
      return Promise.resolve({ action: 'decline' })
    }
    const requestId = randomUUID()
    const request = mapElicitationRequest(params, activeTurn, requestId)
    if (!request) return Promise.resolve({ action: 'decline' })
    return this.waitForQuestionResponse(request, activeTurn, (response, meta) => {
      const result =
        response.action === 'accept'
          ? { action: 'accept' as const, content: response.answers as Record<string, unknown> }
          : response.action === 'skip'
            ? { action: 'decline' as const }
            : { action: 'cancel' as const }
      this.traceAskProtocol({
        stage: 'elicit-out',
        action: response.action,
        resultAction: result.action,
        ...(meta?.cancelReason ? { cancelReason: meta.cancelReason } : {}),
        ...(meta?.honoredDespiteStaleGeneration
          ? { note: 'honored-despite-generation-drift' }
          : {})
      })
      return result
    })
  }

  /** Grok 私有扩展方法的问答入口；未知扩展保持空响应，不能把原始 payload 泄漏给上层。 */
  private handleExtensionMethod(
    method: string,
    params: unknown,
    sourceConnection: acp.ClientSideConnection
  ): Promise<Record<string, unknown>> {
    const envelopeMethod = method
    const unwrapped = unwrapGrokExtMethodEnvelope(method, params)
    method = unwrapped.method
    this.traceAskProtocol({
      stage: 'ext-in',
      envelopeMethod,
      method,
      paramKeys: Object.keys(unwrapped.params)
    })
    const payload = unwrapped.params
    // 方法名未知但 payload 已是问卷/计划审阅时，绝不能回 {}——Grok 反序列化缺 outcome 会一直 Waiting。
    let isPlanApproval = GROK_PLAN_APPROVAL_METHODS.has(method)
    let isQuestion = GROK_QUESTION_METHODS.has(method)
    if (!isQuestion && !isPlanApproval) {
      if (Array.isArray(payload.questions)) {
        isQuestion = true
      } else if (
        typeof payload.planContent === 'string' ||
        typeof payload.plan_content === 'string'
      ) {
        isPlanApproval = true
      } else {
        return Promise.resolve({})
      }
    }
    const activeTurn = this.activeTurn
    if (
      !activeTurn ||
      activeTurn.cancelRequested ||
      activeTurn.connection !== sourceConnection ||
      !this.isActiveTurnCurrent(activeTurn) ||
      (typeof payload.sessionId === 'string' && payload.sessionId !== activeTurn.runtimeSessionId)
    ) {
      // 计划审阅仍用 cancelled；问卷没有该变体，只能 skip_interview。
      return Promise.resolve(
        isPlanApproval ? { outcome: 'cancelled' } : grokAskSkipInterviewResponse(null)
      )
    }
    const requestId = randomUUID()
    const request = isPlanApproval
      ? mapGrokPlanApprovalRequest(payload, activeTurn, requestId)
      : mapGrokQuestionRequest(payload, activeTurn, requestId)
    if (!request) {
      return Promise.resolve(
        isPlanApproval ? { outcome: 'cancelled' } : grokAskSkipInterviewResponse(null)
      )
    }
    return this.waitForQuestionResponse(request, activeTurn, (response, meta) => {
      const result = this.projectExtensionQuestionResponse(request, isPlanApproval, response)
      this.traceAskProtocol({
        stage: 'ext-out',
        envelopeMethod,
        method,
        action: response.action,
        resultKeys: Object.keys(result),
        ...(meta?.cancelReason ? { cancelReason: meta.cancelReason } : {}),
        ...(meta?.honoredDespiteStaleGeneration
          ? { note: 'honored-despite-generation-drift' }
          : {})
      })
      return result
    })
  }

  /** 把 Renderer 回答投影成 Grok 可反序列化的 AskUserQuestionExtResponse / 计划审阅结果。 */
  private projectExtensionQuestionResponse(
    request: AgentRuntimeQuestionRequest,
    isPlanApproval: boolean,
    response: AgentQuestionResponse
  ): Record<string, unknown> {
    if (isPlanApproval) {
      if (response.action === 'approve-plan') return { outcome: 'approved' }
      if (response.action === 'abandon-plan') {
        return {
          outcome: 'abandoned',
          ...(response.feedback ? { feedback: response.feedback } : {})
        }
      }
      return {
        outcome: 'cancelled',
        ...(response.action === 'cancel' ? {} : { feedback: '用户未批准计划。' })
      }
    }
    if (response.action === 'accept') {
      const projected = projectGrokQuestionAnswers(request, response.answers, response.annotations)
      return {
        outcome: 'accepted',
        answers: projected.answers,
        annotations: projected.annotations
      }
    }
    if (response.action === 'chat-about-this') {
      return grokAskChatAboutThisResponse(request, response.partialAnswers)
    }
    if (response.action === 'skip') {
      return grokAskSkipInterviewResponse(request, response.partialAnswers)
    }
    // cancel / 未知动作：Grok 无 cancelled 变体。
    return grokAskSkipInterviewResponse(request)
  }

  private waitForQuestionResponse<T>(
    request: AgentRuntimeQuestionRequest,
    activeTurn: ActiveTurn,
    projectResponse: (response: AgentQuestionResponse, meta?: QuestionResolveMeta) => T
  ): Promise<T> {
    if (this.pendingQuestions.size >= 20) {
      return Promise.resolve(projectResponse({ action: 'cancel' }, { cancelReason: 'queue-full' }))
    }
    return new Promise<T>((resolve) => {
      this.pendingQuestions.set(request.requestId, {
        request,
        activeTurn,
        resolve: (response, meta) => resolve(projectResponse(response, meta))
      })
      try {
        this.sink.onQuestion?.(request)
      } catch {
        // sink 同步抛错时可能已通过 respondQuestion 收束；仅在仍挂起时强制 cancel。
        if (!this.pendingQuestions.delete(request.requestId)) return
        resolve(projectResponse({ action: 'cancel' }, { cancelReason: 'onQuestion-throw' }))
      }
    })
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
      clientCapabilities: { ...GROK_ACP_CLIENT_CAPABILITIES },
      // 备注：version 由 Main 注入；方言拒绝空值，Adapter 不写死安装包版本。
      clientInfo: buildGrokAcpClientInfo(this.options.getClientVersion())
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
    // 备注：promptMedia 必须走 allow-list 投影，禁止旁路读取 audio 等未声明能力。
    const handshake = projectGrokHandshakeFields(response)
    this.promptMedia = {
      image: handshake.promptImage === true,
      embeddedContext: handshake.promptEmbeddedContext === true
    }
    this.supportsCloseSession = handshake.close === true
    this.verifyCapability('runtime.connect', 'stable', undefined, false)
    this.status = {
      runtimeId: GROK_RUNTIME_ID,
      state: 'connecting',
      message: '正在启动 Grok Build',
      workspace,
      capabilitySnapshot: this.capabilitySnapshot,
      promptMedia: { ...this.promptMedia }
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
      // 只有真正挂起的 ACP 权限请求才关联 approvalId，禁止伪造 Broker 已授权。
      this.queueCommandEvidenceFromTool(activeTurn, params.toolCall, id)
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

    const isRuntimeImage =
      (update.sessionUpdate === 'agent_message_chunk' ||
        update.sessionUpdate === 'agent_thought_chunk') &&
      update.content.type === 'image'
    const isSessionMediaTool =
      (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
      toolCallHasGrokRuntimeMedia(update.content)

    if (!activeTurn.sessionUpdateQueueActive && !isRuntimeImage && !isSessionMediaTool) {
      void this.processSessionUpdate(params, sourceConnection, activeTurn)
      return
    }

    this.enqueueSessionUpdate(activeTurn, params, sourceConnection)
  }

  /** 图片出现后才开启串行尾队列，避免改变既有同步文本与权限事件语义。 */
  private enqueueSessionUpdate(
    activeTurn: ActiveTurn,
    params: acp.SessionNotification,
    sourceConnection: acp.ClientSideConnection
  ): void {
    activeTurn.sessionUpdateQueueActive = true
    const queued = activeTurn.sessionUpdateQueue.then(() =>
      this.processSessionUpdate(params, sourceConnection, activeTurn)
    )
    const settled = queued.catch(() => undefined)
    activeTurn.sessionUpdateQueue = settled
    void settled.finally(() => {
      if (activeTurn.sessionUpdateQueue === settled) {
        activeTurn.sessionUpdateQueueActive = false
      }
    })
  }

  /** 等待动态增长的队列尾，确保等待期间追加的 update 也先于 Turn 终态完成。 */
  private async waitForSessionUpdateQueue(activeTurn: ActiveTurn): Promise<void> {
    while (true) {
      const queue = activeTurn.sessionUpdateQueue
      await queue
      if (queue === activeTurn.sessionUpdateQueue) return
    }
  }

  /** 串行处理单个 update；异步图片完成后会再次校验 Turn 代次，禁止晚到数据串台。 */
  private async processSessionUpdate(
    params: acp.SessionNotification,
    sourceConnection: acp.ClientSideConnection,
    activeTurn: ActiveTurn
  ): Promise<void> {
    if (
      activeTurn.connection !== sourceConnection ||
      !this.isActiveTurnCurrent(activeTurn) ||
      activeTurn.runtimeSessionId !== params.sessionId
    ) {
      return
    }

    const update = params.update
    this.observe(summarizeSessionUpdate(update as unknown as Record<string, unknown>))
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      if (!isSafeGrokToolCallId(update.toolCallId)) {
        this.rejectAllToolPermissions(activeTurn)
      } else if (update.status === 'completed' || update.status === 'failed') {
        this.markToolCallTerminal(activeTurn, update.toolCallId)
        this.queueCommandEvidenceFromTool(activeTurn, update)
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
        this.queueCommandEvidenceFromTool(activeTurn, update)
      } else {
        this.queueCommandEvidenceFromTool(activeTurn, update)
      }
    }

    if (
      (update.sessionUpdate === 'agent_message_chunk' ||
        update.sessionUpdate === 'agent_thought_chunk') &&
      update.content.type === 'image'
    ) {
      const image = mapGrokRuntimeImageContent(update.content)
      if (!image) {
        this.reportRuntimeAttachmentFailure(activeTurn)
        return
      }
      await this.persistRuntimeImage(activeTurn, image)
      return
    }

    for (const draft of mapGrokSessionUpdate(params, (text) => this.safeRedact(text))) {
      if (
        draft.kind === 'usage' &&
        draft.usage.scope === 'context' &&
        activeTurn.lastContextUsageFingerprint === contextUsageFingerprint(draft.usage)
      ) {
        // signals 基线已先到时，丢弃同值 ACP 快照；避免一条事实在 Timeline 出现两次。
        continue
      }
      const event = this.emitDraft(activeTurn, draft)
      if (event?.kind === 'usage' && event.usage.scope === 'context') {
        activeTurn.lastContextUsageFingerprint = contextUsageFingerprint(event.usage)
      }
    }

    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      await this.ingestGrokSessionMedia(activeTurn, update.content)
    }
  }

  /** 测试可替换媒体根；生产同时认 App grok-home/sessions 与 Grok 默认 /tmp/sessions。 */
  private grokSessionMediaRoots(): string[] {
    if (this.options.grokSessionMediaRoot) return [this.options.grokSessionMediaRoot]
    return [
      join(getManagedGrokHome(this.options.userDataPath), 'sessions'),
      DEFAULT_GROK_SESSION_MEDIA_ROOT
    ]
  }

  /**
   * Grok image_gen 只在 tool_call 正文里给 session 相对路径，不发 ACP Image 块。
   * 主进程限定目录读盘后走既有 inbox，绝对路径不得进入事件。
   */
  private async ingestGrokSessionMedia(
    activeTurn: ActiveTurn,
    content: acp.ToolCallContent[] | null | undefined
  ): Promise<void> {
    const candidates = extractGrokRuntimeMediaPaths(content)
    for (const candidate of candidates) {
      if (activeTurn.ingestedRuntimeMediaKeys.has(candidate.absolutePath)) continue
      activeTurn.ingestedRuntimeMediaKeys.add(candidate.absolutePath)
      const image = await readGrokSessionMediaFile(candidate, {
        mediaRoots: this.grokSessionMediaRoots()
      })
      if (!image) {
        this.reportRuntimeAttachmentFailure(activeTurn)
        continue
      }
      await this.persistRuntimeImage(activeTurn, image)
    }
  }

  /** Turn 进行中按固定间隔补读 signals.json；同值快照会在 publish 内去重。 */
  private startContextUsagePolling(activeTurn: ActiveTurn, workspace: string): void {
    this.stopContextUsagePolling(activeTurn)
    activeTurn.contextUsagePollTimer = setInterval(() => {
      void this.publishSessionContextUsage(activeTurn, workspace)
    }, GROK_CONTEXT_USAGE_POLL_MS)
  }

  private stopContextUsagePolling(activeTurn?: ActiveTurn | null): void {
    if (!activeTurn?.contextUsagePollTimer) return
    clearInterval(activeTurn.contextUsagePollTimer)
    activeTurn.contextUsagePollTimer = undefined
  }

  /**
   * 将当前 Task 绑定的 signals.json 快照补进既有 Usage 事件链。
   * 读取失败、session 失效或快照未变化都静默跳过，不阻塞 Turn 终态。
   */
  private async publishSessionContextUsage(
    activeTurn: ActiveTurn,
    workspace: string
  ): Promise<void> {
    if (!this.isActiveTurnCurrent(activeTurn)) return

    const usage = await readGrokSessionContextUsage({
      grokHome:
        this.options.grokSessionSignalsRoot ?? getManagedGrokHome(this.options.userDataPath),
      workspace,
      runtimeSessionId: activeTurn.runtimeSessionId
    })
    if (!usage || !this.isActiveTurnCurrent(activeTurn)) return

    const fingerprint = contextUsageFingerprint(usage)
    if (activeTurn.lastContextUsageFingerprint === fingerprint) return

    const event = this.emitDraft(activeTurn, {
      ...createGrokEventBase(activeTurn.runtimeSessionId, 'experimental'),
      kind: 'usage',
      usage
    })
    if (event?.kind === 'usage' && event.usage.scope === 'context') {
      activeTurn.lastContextUsageFingerprint = contextUsageFingerprint(event.usage)
    }
  }

  /** 图片写入成功后才发布引用事件，避免历史出现无法打开的悬空 attachmentId。 */
  private async persistRuntimeImage(
    activeTurn: ActiveTurn,
    image: { bytes: Buffer; mimeType: string; originalName: string }
  ): Promise<void> {
    const store = this.options.storeRuntimeImage
    if (!store) {
      this.reportRuntimeAttachmentFailure(activeTurn)
      return
    }
    try {
      const attachment = await store({
        taskId: activeTurn.taskId,
        turnId: activeTurn.turnId,
        originalName: image.originalName,
        mimeType: image.mimeType,
        bytes: image.bytes
      })
      if (!this.isActiveTurnCurrent(activeTurn)) return
      this.emitDraft(activeTurn, {
        ...createGrokEventBase(activeTurn.runtimeSessionId, 'native'),
        kind: 'agent-attachment',
        attachmentId: attachment.attachmentId,
        attachmentKind: attachment.attachmentKind,
        originalName: attachment.originalName
      })
    } catch {
      this.reportRuntimeAttachmentFailure(activeTurn)
    }
  }

  /** Runtime 媒体失败只给有限提示，不回显 base64、URI、文件路径或原始异常。 */
  private reportRuntimeAttachmentFailure(activeTurn: ActiveTurn): void {
    if (activeTurn.runtimeAttachmentErrorReported || !this.isActiveTurnCurrent(activeTurn)) return
    activeTurn.runtimeAttachmentErrorReported = true
    this.emitDraft(activeTurn, {
      ...createGrokEventBase(activeTurn.runtimeSessionId, 'native'),
      kind: 'error',
      message: 'Runtime 返回的图片无法安全保存，已跳过该图片。',
      recoverable: true,
      code: 'runtime-attachment-rejected'
    })
  }

  /**
   * Runtime 命令证据只记录已验证上报字段，不走 AppCommandRunner。
   * 未注入 store 或 environmentId 时静默跳过，避免影响既有协议测试。
   */
  private queueCommandEvidenceFromTool(
    activeTurn: ActiveTurn,
    patch: acp.ToolCallUpdate,
    approvalId?: string
  ): void {
    const store = this.options.commandEvidenceStore
    if (!store) return
    const context = this.options.resolveCommandEvidenceContext?.(
      activeTurn.taskId,
      activeTurn.turnId
    )
    if (!context?.environmentId) return

    const accumulators = this.commandEvidenceAccumulators(activeTurn)
    const facts = accumulateGrokCommandToolFacts(accumulators.get(patch.toolCallId), patch, {
      taskId: activeTurn.taskId,
      turnId: activeTurn.turnId,
      environmentId: context.environmentId,
      nowIso: new Date().toISOString(),
      ...(approvalId ? { approvalId } : {})
    })
    // 超过 Turn 内累积上限则丢弃新 toolCall，避免与授权快照一样把内存撑爆。
    if (!rememberGrokCommandToolFacts(accumulators, facts)) return
    if (!isGrokCommandEvidenceCandidate(facts)) return

    const mapping = mapGrokCommandEvidence(facts, (text) => this.safeRedact(text))
    if (!mapping) return
    // 终态写盘失败不得静默丢：留下 Task 级缺口，直播 list 会等这条链。
    const write = store.scheduleWrite(() => this.writeMappedCommandEvidence(store, mapping))
    this.commandEvidenceWrites = write.catch(() => {
      store.markPersistIncomplete(activeTurn.taskId)
    })
  }

  private commandEvidenceAccumulators(activeTurn: ActiveTurn): Map<string, GrokCommandToolFacts> {
    if (!activeTurn.commandEvidenceByToolCallId) {
      activeTurn.commandEvidenceByToolCallId = new Map()
    }
    return activeTurn.commandEvidenceByToolCallId
  }

  private async writeMappedCommandEvidence(
    store: CommandEvidenceStore,
    mapping: GrokCommandEvidenceMapping
  ): Promise<void> {
    const transcriptRef = await store.writeTranscript({
      transcriptId: mapping.evidence.transcriptRef.transcriptId,
      commandId: mapping.evidence.commandId,
      taskId: mapping.evidence.taskId,
      chunks: mapping.chunks,
      totalBytes:
        mapping.evidence.transcriptRef.totalBytes ?? mapping.evidence.transcriptRef.availableBytes,
      truncated: mapping.evidence.truncated
    })
    await store.writeEvidence({
      ...mapping.evidence,
      transcriptRef,
      truncated: mapping.evidence.truncated || transcriptRef.truncated
    })
  }

  /** 等待命令证据落盘。查询与测试都必须等这条链，不能在 write 完成前读列表。 */
  async waitForCommandEvidenceWrites(): Promise<void> {
    await this.commandEvidenceWrites
    await this.options.commandEvidenceStore?.waitForWrites()
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

    // 必须在 normalize 之前 defer：否则 normalizer 会占掉唯一 turn-complete 槽，答完无法补发。
    if (draft.kind === 'turn-complete' && this.countPendingQuestions(activeTurn) > 0) {
      this.cancelPendingPermissions(activeTurn)
      activeTurn.deferredTurnComplete = draft
      this.traceAskProtocol({
        stage: 'turn-complete-deferred',
        pendingCount: this.countPendingQuestions(activeTurn),
        outcome: draft.outcome
      })
      return null
    }

    const event = activeTurn.normalizer.normalize(draft)
    if (!event) return null
    this.verifyEventCapability(event)

    if (event.kind === 'turn-complete') {
      this.cancelPendingPermissions(activeTurn)
      activeTurn.deferredTurnComplete = undefined
      this.cancelPendingQuestions(activeTurn, 'turn-complete')
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

    // 进程崩溃/退出等同 disconnect：必须强制收束，不能把 UI 卡在已死连接的 ask 上。
    activeTurn.deferredTurnComplete = undefined
    this.stopContextUsagePolling(activeTurn)
    this.cancelPendingQuestions(activeTurn, 'disconnect')
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

  /**
   * Grok 可能在 ask 仍挂起时就返回 prompt 终态；此时不能立刻 turn-complete/pending-clear，
   * 否则用户来不及提交，日志只剩 pending-clear，且没有 respond-in。
   */
  private async waitForPendingQuestions(activeTurn: ActiveTurn): Promise<void> {
    const outstanding = (): number => this.countPendingQuestions(activeTurn)
    if (outstanding() === 0) return
    this.traceAskProtocol({
      stage: 'ask-hold-terminal',
      pendingCount: outstanding(),
      outcome: activeTurn.outcome
    })
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (outstanding() === 0 || activeTurn.cancelRequested) {
          clearInterval(timer)
          resolve()
        }
      }, 50)
    })
  }

  private countPendingQuestions(activeTurn: ActiveTurn): number {
    let count = 0
    for (const pending of this.pendingQuestions.values()) {
      if (pending.activeTurn === activeTurn) count += 1
    }
    return count
  }

  /** 用户答完最后一题后，把先前因 ask 挂起而推迟的 turn-complete 补发出去。 */
  private flushDeferredTurnComplete(activeTurn: ActiveTurn): void {
    const draft = activeTurn.deferredTurnComplete
    if (!draft || this.countPendingQuestions(activeTurn) > 0) return
    if (!this.isActiveTurnCurrent(activeTurn) && this.activeTurn !== activeTurn) return
    activeTurn.deferredTurnComplete = undefined
    this.emitDraft(activeTurn, draft)
  }

  /** Turn 终态、取消或 Runtime 断开时收束所有问答 Promise，并撤销 Renderer 卡片。 */
  private cancelPendingQuestions(
    activeTurn?: ActiveTurn,
    source: PendingClearSource = 'turn-complete'
  ): void {
    for (const [requestId, pending] of this.pendingQuestions) {
      if (activeTurn && pending.activeTurn !== activeTurn) continue
      this.cancelPendingQuestion(requestId, pending, source)
    }
  }

  private cancelPendingQuestion(
    requestId: string,
    pending: PendingQuestion,
    source: PendingClearSource = 'turn-complete'
  ): void {
    this.pendingQuestions.delete(requestId)
    const cancelReason: AskCancelReason =
      source === 'cancel-turn'
        ? 'cancel-turn'
        : source === 'disconnect'
          ? 'disconnect'
          : 'pending-clear'
    this.traceAskProtocol({
      stage: 'ext-out',
      action: 'cancel',
      cancelReason,
      clearSource: source,
      ...(pending.activeTurn.outcome ? { outcome: pending.activeTurn.outcome } : {}),
      ...(pending.activeTurn.deferredTurnComplete &&
      pending.activeTurn.deferredTurnComplete.kind === 'turn-complete'
        ? { deferredOutcome: pending.activeTurn.deferredTurnComplete.outcome }
        : {})
    })
    pending.resolve({ action: 'cancel' }, { cancelReason })
    try {
      this.sink.onQuestionCancelled?.(pending.request)
    } catch {
      // Renderer 通知失败不影响协议 Promise 已安全收束。
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

      // 备注：形状守卫归属方言；此处保持 fail-closed，不读 _meta 业务字段。
      if (!isGrokSetModelResponseValid(response)) {
        this.observe({
          kind: 'set-model',
          accepted: false,
          responseShape: response === null ? 'null' : 'missing'
        })
        throw this.createError('operation-failed', GROK_ACP_PRODUCT_MESSAGES.setModelShapeRejected)
      }
      this.observe({ kind: 'set-model', accepted: true, responseShape: 'object' })
    } catch (error) {
      // Runtime 可能已经切换到目标 session；绑定失败时必须废弃整条连接，避免本地仍记录旧 Task。
      this.assertSessionOperationCurrent(current)
      if (!(error instanceof AgentRuntimeAdapterError)) {
        this.observe({ kind: 'set-model', accepted: false, responseShape: 'failed' })
      }
      // 备注：只统一文案分类，不改变 fail-closed 与 disconnect 语义。
      const adapterError =
        error instanceof AgentRuntimeAdapterError
          ? error
          : this.createError(
              'operation-failed',
              resolveGrokAcpFailure('set-model-failed', {
                redactedDetail: this.redactError(error)
              }).message
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
    // 先按 disconnect 收束 ask，再发 turn-complete；避免 emitDraft 因挂起问答而 defer。
    this.stopContextUsagePolling(activeTurn)
    this.cancelPendingPermissions()
    this.cancelPendingQuestions(undefined, 'disconnect')
    if (activeTurn && this.activeTurn === activeTurn) {
      activeTurn.deferredTurnComplete = undefined
      this.emitDraft(activeTurn, {
        ...createGrokEventBase(activeTurn.runtimeSessionId, 'native'),
        kind: 'turn-complete',
        outcome: 'cancelled'
      })
    }
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
    this.connectProcessError = error
    const kind = classifyGrokSpawnProcessError(error)
    // 备注：ENOENT 只展示“未安装 CLI”，禁止把 spawn 路径或 Node 原文送进 UI。
    const message =
      kind === 'cli-missing'
        ? resolveGrokAcpFailure('cli-missing').message
        : `无法启动 Grok Build：${this.redactError(error)}`

    const isCurrent = this.process === child && this.connectionGeneration === connectionGeneration
    if (isCurrent) {
      this.failActiveTurn(message, 'runtime-process-error')
      this.clearFailedConnection()
      this.updateStatus({ state: 'error', message, workspace })
      return
    }

    // 握手已先失败并 disconnect；缺 CLI 仍覆盖笼统连接失败文案。
    if (
      kind === 'cli-missing' &&
      this.status.state === 'error' &&
      this.status.workspace === workspace
    ) {
      this.updateStatus({ state: 'error', message, workspace })
    }
  }

  /** 组装缺 CLI 的有限错误，并同步状态文案。 */
  private createCliMissingError(workspace: string): AgentRuntimeAdapterError {
    const resolved = resolveGrokAcpFailure('cli-missing')
    const adapterError = this.createError(resolved.adapterErrorCode, resolved.message)
    this.updateStatus({ state: 'error', message: adapterError.message, workspace })
    return adapterError
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
    const resolved = resolveGrokAcpFailure('process-exited', { exitCode: code })
    const message =
      code === 0 && !hadActiveTurn
        ? GROK_ACP_PRODUCT_MESSAGES.processDisconnected
        : resolved.message
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

  /**
   * 将 connect 捕获错误映射为可区分的产品失败。
   * 已归一化的 AdapterError 直接透传；协议不兼容不再二次包装成笼统“连接失败”。
   */
  private resolveConnectFailure(error: unknown): AgentRuntimeAdapterError {
    if (error instanceof AgentRuntimeAdapterError) return error
    const kind = classifyGrokConnectError(error)
    const resolved = resolveGrokAcpFailure(kind, {
      redactedDetail: this.redactError(error)
    })
    return this.createError(resolved.adapterErrorCode, resolved.message)
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
      capabilitySnapshot: this.capabilitySnapshot,
      promptMedia: { ...this.promptMedia }
    }
    this.sink.onStatus(this.status)
  }

  /** 新连接、断开与失败均恢复静态基线，避免旧 Runtime 证据泄漏到下一连接。 */
  private resetCapabilitySnapshot(): void {
    this.capabilitySnapshot = createGrokCapabilitySnapshot((text) => this.safeRedact(text))
    this.promptMedia = { image: false, embeddedContext: false }
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
      case 'agent-attachment':
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
    const spawnControlled = this.options.spawnControlledProcess ?? spawn
    // 备注：受控 E2E 必须走独立 argv 与 ELECTRON_RUN_AS_NODE，禁止复用生产 GROK_PRODUCTION_AGENT_ARGV。
    return spawnControlled(
      process.execPath,
      buildGrokControlledE2ESpawnArgs({
        fixturePath: launch.fixturePath,
        scenario: launch.scenario,
        userDataPath: launch.userDataPath
      }),
      {
        cwd: workspace,
        env: buildControlledFixtureEnvironment(launch.runtimeHomeDirectory, launch.userDataPath),
        stdio: ['pipe', 'pipe', 'pipe']
      }
    ) as ChildProcessWithoutNullStreams
  }

  /** 观察记录缺省为空操作，避免生产路径多写协议字段。 */
  private observe(record: GrokAcpObservationRecord): void {
    this.options.protocolObserver?.record(record)
  }

  /**
   * 提问回包诊断只写方法名和字段名，不写答案正文。
   * 用来核对 Grok 实际打来的是 ext_method 还是 elicitation/create。
   */
  private traceAskProtocol(event: Record<string, unknown>): void {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`
    void fs
      .appendFile(join(getManagedGrokHome(this.options.userDataPath), 'ask-debug.jsonl'), line)
      .catch(() => undefined)
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
 * GROK_XAI_API_BASE_URL 与聊天 Base URL 同源，供 Imagine 等媒体接口使用。
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
  // Imagine 跟聊天走同一 Provider URL，不继承宿主 GROK_XAI_API_BASE_URL。
  environment.GROK_XAI_API_BASE_URL = providerConfig.baseUrl
  if (providerConfig.authMode === 'bearer' && providerConfig.apiKey) {
    environment[AGENT_STUDIO_MODEL_API_KEY_ENV] = providerConfig.apiKey
  }
  return environment
}
