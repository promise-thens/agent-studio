import type * as acp from '@agentclientprotocol/sdk'
import type {
  AgentCapabilityId,
  AgentCapabilityState,
  AgentDiff,
  AgentPermissionRequest,
  AgentRuntimeCapabilitySnapshot,
  AgentTurnOutcome,
  AgentTurnUsage
} from '../../../shared/agent'
import type { AgentEventDraft, AgentEventDraftBase } from '../../agent/event-normalizer'
import {
  createAgentRuntimeCapabilitySnapshot,
  updateAgentRuntimeCapabilitySnapshot,
  type AgentCapabilityInput
} from '../../agent/runtime-capabilities'

export const GROK_RUNTIME_ID = 'grok' as const

const MAX_PERMISSION_PAYLOAD_BYTES = 256 * 1024
const MAX_PERMISSION_DISPLAY_TEXT_BYTES = 4 * 1024

type TextRedactor = (text: string) => string

/** Grok 当前由标准 ACP 路径确认的静态能力；恢复能力必须等待握手证据。 */
const GROK_STATIC_CAPABILITIES: readonly AgentCapabilityInput[] = [
  ...[
    'runtime.connect',
    'session.create',
    'session.prompt.text',
    'session.cancel',
    'event.agent-message',
    'event.agent-thought',
    'event.plan',
    'event.tool',
    'event.diff',
    'permission.request'
  ].map((capabilityId): AgentCapabilityInput => ({
    capabilityId: capabilityId as AgentCapabilityId,
    support: 'native',
    maturity: 'stable',
    verification: 'declared',
    source: 'static'
  })),
  {
    capabilityId: 'usage.context',
    support: 'native',
    maturity: 'experimental',
    verification: 'declared',
    source: 'static',
    reason: 'Grok ACP Context Usage 当前按实验性能力接入。'
  },
  {
    capabilityId: 'usage.turn',
    support: 'native',
    maturity: 'experimental',
    verification: 'declared',
    source: 'static',
    reason: 'Grok ACP Turn Usage 当前按实验性能力接入。'
  }
]

/** 创建 Grok 静态能力基线，未经握手证实的 load/resume 保守标记为未验证。 */
export function createGrokCapabilitySnapshot(
  redactText?: TextRedactor
): AgentRuntimeCapabilitySnapshot {
  return createAgentRuntimeCapabilitySnapshot({
    runtimeId: GROK_RUNTIME_ID,
    capabilities: GROK_STATIC_CAPABILITIES,
    ...(redactText ? { redactText } : {})
  })
}

/**
 * 只投影 ACP initialize 标准字段并校验协商版本；_meta、认证方式和扩展字段全部丢弃。
 */
export function mapGrokInitializeCapabilitySnapshot(
  baseline: AgentRuntimeCapabilitySnapshot,
  response: acp.InitializeResponse,
  redactText: TextRedactor,
  protocolVersion: number
): AgentRuntimeCapabilitySnapshot {
  if (response.protocolVersion !== protocolVersion) {
    throw new Error(
      `ACP 协议版本不兼容：Runtime 返回 ${response.protocolVersion}，客户端支持 ${protocolVersion}。`
    )
  }

  const runtimeVersion = response.agentInfo?.version?.trim()
  let snapshot = createAgentRuntimeCapabilitySnapshot({
    runtimeId: GROK_RUNTIME_ID,
    ...(runtimeVersion ? { runtimeVersion: redactText(runtimeVersion) } : {}),
    protocolVersion: String(response.protocolVersion),
    capabilities: Object.values(baseline.capabilities),
    redactText
  })

  snapshot = updateAgentRuntimeCapabilitySnapshot(
    snapshot,
    response.agentCapabilities?.loadSession === true
      ? {
          capabilityId: 'session.load',
          support: 'native',
          maturity: 'stable',
          verification: 'declared',
          source: 'protocol'
        }
      : {
          capabilityId: 'session.load',
          support: 'unsupported',
          verification: 'declared',
          source: 'protocol',
          reason: 'Grok Runtime 未声明 ACP session/load 支持。'
        },
    { redactText }
  )

  return updateAgentRuntimeCapabilitySnapshot(
    snapshot,
    response.agentCapabilities?.sessionCapabilities?.resume != null
      ? {
          capabilityId: 'session.resume',
          support: 'native',
          maturity: 'stable',
          verification: 'declared',
          source: 'protocol'
        }
      : {
          capabilityId: 'session.resume',
          support: 'unsupported',
          verification: 'declared',
          source: 'protocol',
          reason: 'Grok Runtime 未声明 ACP session/resume 支持。'
        },
    { redactText }
  )
}

/**
 * 将 ACP SessionUpdate 显式投影为中性事件；未声明字段和未知事件不得越过 Adapter。
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

/** 将 ACP 权限请求逐字段复制到中性结构，禁止工具原始内容进入 Renderer。 */
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

export function createGrokEventBase(
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

/** 标识符保持原值；若完整权限 DTO 仍超限，则整项拒绝而不破坏 ACP 回传标识。 */
function isPermissionRequestWithinBudget(request: AgentPermissionRequest): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(request), 'utf8') <= MAX_PERMISSION_PAYLOAD_BYTES
  } catch {
    return false
  }
}
