import type {
  AgentContextUsage,
  AgentDiff,
  AgentEvent,
  AgentEventBase,
  AgentToolStatus,
  AgentTurnUsage,
  AgentUsage
} from '../../shared/agent'

type AgentEventEnvelopeKey = 'taskId' | 'turnId' | 'sequence' | 'observedAt' | 'truncated'

type StripAgentEventEnvelope<Event extends AgentEvent> = Event extends AgentEvent
  ? Omit<Event, AgentEventEnvelopeKey>
  : never

/** Runtime Adapter 只产出已脱敏草稿，统一封套由主进程归一器附加。 */
export type AgentEventDraft = StripAgentEventEnvelope<AgentEvent>

/** Adapter 映射事件时可复用的最小中性基座。 */
export type AgentEventDraftBase = Omit<AgentEventBase, AgentEventEnvelopeKey>

interface AgentEventNormalizerOptions {
  taskId: string
  turnId: string
  now?: () => string
}

interface LimitedDraft {
  event: AgentEventDraft
  truncated: boolean
}

interface ToolState {
  title?: string
  status?: AgentToolStatus
}

interface TextLimitResult {
  value: string
  truncated: boolean
}

const MAX_EVENT_BYTES = 256 * 1024
const MAX_STREAM_TEXT_BYTES = 64 * 1024
const MAX_SHORT_TEXT_BYTES = 4 * 1024
const MAX_ERROR_CODE_BYTES = 128
const MAX_PLAN_ENTRIES = 100
const MAX_PLAN_ENTRY_BYTES = 2 * 1024
const MAX_DIFFS = 20
const MAX_DIFF_PATHS = 100
const MAX_DIFF_BODY_BYTES = 192 * 1024

const TERMINAL_TOOL_STATES = new Set<AgentToolStatus>(['completed', 'failed', 'cancelled'])

/**
 * 为单次任务建立有界、有序的 AgentEvent 流。
 * 输入必须已由 Adapter 脱敏；本类负责白名单复制、限长、状态保护和统一封套。
 */
export class AgentEventNormalizer {
  private readonly taskId: string
  private readonly turnId: string
  private readonly now: () => string
  private readonly toolStates = new Map<string, ToolState>()
  private readonly singletonErrorCodes = new Set<string>()
  private nextSequence = 1
  private turnCompleted = false

  constructor(options: AgentEventNormalizerOptions) {
    this.taskId = options.taskId
    this.turnId = options.turnId
    this.now = options.now ?? (() => new Date().toISOString())
  }

  /** 接受一个已脱敏草稿；被拒绝的事件不占用 sequence。 */
  normalize(event: AgentEventDraft): AgentEvent | null {
    if (this.turnCompleted) return null

    let limited = limitDraft(event)
    const observedAt = this.now()
    let normalized = this.attachEnvelope(limited, observedAt)

    if (serializedByteLength(normalized) > MAX_EVENT_BYTES) {
      limited = {
        event: createPayloadTooLargeError(event),
        truncated: true
      }
      normalized = this.attachEnvelope(limited, observedAt)
    }

    if (limited.event.kind === 'error' && limited.event.code === 'unsupported-runtime-event') {
      if (this.singletonErrorCodes.has(limited.event.code)) return null
      this.singletonErrorCodes.add(limited.event.code)
    }
    if (!this.acceptToolTransition(limited.event)) return null

    this.nextSequence += 1
    if (normalized.kind === 'turn-complete') this.turnCompleted = true
    return normalized
  }

  private attachEnvelope(limited: LimitedDraft, observedAt: string): AgentEvent {
    return {
      ...limited.event,
      taskId: this.taskId,
      turnId: this.turnId,
      sequence: this.nextSequence,
      observedAt,
      ...(limited.truncated ? { truncated: true as const } : {})
    } as AgentEvent
  }

  private acceptToolTransition(event: AgentEventDraft): boolean {
    if (event.kind !== 'tool-call' && event.kind !== 'tool-update') return true

    const current = this.toolStates.get(event.toolCallId)
    const nextStatus =
      event.status ?? current?.status ?? (event.kind === 'tool-call' ? 'pending' : undefined)
    const nextTitle = event.title ?? current?.title

    if (current?.status === 'in_progress' && nextStatus === 'pending') return false
    if (
      current?.status &&
      TERMINAL_TOOL_STATES.has(current.status) &&
      nextStatus &&
      nextStatus !== current.status
    ) {
      return false
    }

    if (current && current.status === nextStatus && current.title === nextTitle) return false
    if (!current && nextStatus == null && nextTitle == null) return false

    this.toolStates.set(event.toolCallId, {
      ...(nextTitle != null ? { title: nextTitle } : {}),
      ...(nextStatus != null ? { status: nextStatus } : {})
    })
    return true
  }
}

/** 按事件种类逐字段复制，避免未知属性借助对象展开穿过主进程边界。 */
function limitDraft(event: AgentEventDraft): LimitedDraft {
  const baseResult = limitBase(event)
  const base = baseResult.base
  let truncated = baseResult.truncated

  switch (event.kind) {
    case 'agent-message': {
      const text = limitText(event.text, MAX_STREAM_TEXT_BYTES)
      const messageId = limitOptionalText(event.messageId, MAX_SHORT_TEXT_BYTES)
      truncated ||= text.truncated || messageId.truncated
      return {
        event: {
          ...base,
          kind: 'agent-message',
          text: text.value,
          ...(messageId.value != null ? { messageId: messageId.value } : {})
        },
        truncated
      }
    }
    case 'agent-thought': {
      const text = limitText(event.text, MAX_STREAM_TEXT_BYTES)
      const messageId = limitOptionalText(event.messageId, MAX_SHORT_TEXT_BYTES)
      truncated ||= text.truncated || messageId.truncated
      return {
        event: {
          ...base,
          kind: 'agent-thought',
          text: text.value,
          ...(messageId.value != null ? { messageId: messageId.value } : {})
        },
        truncated
      }
    }
    case 'tool-call': {
      const toolCallId = limitText(event.toolCallId, MAX_SHORT_TEXT_BYTES)
      const title = limitText(event.title, MAX_SHORT_TEXT_BYTES)
      truncated ||= toolCallId.truncated || title.truncated
      return {
        event: {
          ...base,
          kind: 'tool-call',
          toolCallId: toolCallId.value,
          title: title.value,
          ...(event.status != null ? { status: event.status } : {})
        },
        truncated
      }
    }
    case 'tool-update': {
      const toolCallId = limitText(event.toolCallId, MAX_SHORT_TEXT_BYTES)
      const title = limitOptionalText(event.title, MAX_SHORT_TEXT_BYTES)
      truncated ||= toolCallId.truncated || title.truncated
      return {
        event: {
          ...base,
          kind: 'tool-update',
          toolCallId: toolCallId.value,
          ...(title.value != null ? { title: title.value } : {}),
          ...(event.status != null ? { status: event.status } : {})
        },
        truncated
      }
    }
    case 'plan': {
      const entries = event.entries.slice(0, MAX_PLAN_ENTRIES).map((entry) => {
        const content = limitText(entry.content, MAX_PLAN_ENTRY_BYTES)
        truncated ||= content.truncated
        return {
          content: content.value,
          priority: entry.priority,
          status: entry.status
        }
      })
      truncated ||= event.entries.length > MAX_PLAN_ENTRIES
      return { event: { ...base, kind: 'plan', entries }, truncated }
    }
    case 'diff': {
      const toolCallId = limitOptionalText(event.toolCallId, MAX_SHORT_TEXT_BYTES)
      const diffResult = limitDiffs(event.diffs)
      truncated ||= toolCallId.truncated || diffResult.truncated
      return {
        event: {
          ...base,
          kind: 'diff',
          diffs: diffResult.diffs,
          ...(toolCallId.value != null ? { toolCallId: toolCallId.value } : {})
        },
        truncated
      }
    }
    case 'usage':
      return { event: { ...base, kind: 'usage', usage: copyUsage(event.usage) }, truncated }
    case 'turn-complete':
      return {
        event: {
          ...base,
          kind: 'turn-complete',
          outcome: event.outcome,
          ...(event.usage ? { usage: copyTurnUsage(event.usage) } : {})
        },
        truncated
      }
    case 'error': {
      const message = limitText(event.message, MAX_SHORT_TEXT_BYTES)
      const code = limitOptionalText(event.code, MAX_ERROR_CODE_BYTES)
      truncated ||= message.truncated || code.truncated
      return {
        event: {
          ...base,
          kind: 'error',
          message: message.value,
          recoverable: event.recoverable,
          ...(code.value != null ? { code: code.value } : {})
        },
        truncated
      }
    }
  }
}

function limitBase(event: AgentEventDraft): {
  base: AgentEventDraftBase
  truncated: boolean
} {
  const runtimeSessionId = limitOptionalText(event.runtimeSessionId, MAX_SHORT_TEXT_BYTES)
  return {
    base: {
      runtimeId: event.runtimeId,
      capabilityState: event.capabilityState,
      ...(runtimeSessionId.value != null ? { runtimeSessionId: runtimeSessionId.value } : {})
    },
    truncated: runtimeSessionId.truncated
  }
}

function limitDiffs(diffs: AgentDiff[]): { diffs: AgentDiff[]; truncated: boolean } {
  const result: AgentDiff[] = []
  let truncated = diffs.length > MAX_DIFFS
  let remainingBodyBytes = MAX_DIFF_BODY_BYTES
  let remainingPathCount = MAX_DIFF_PATHS

  for (const diff of diffs.slice(0, MAX_DIFFS)) {
    if (diff.format === 'snapshot') {
      const path = limitText(diff.path, MAX_SHORT_TEXT_BYTES)
      const before =
        diff.before == null
          ? { value: null, truncated: false }
          : limitText(diff.before, remainingBodyBytes)
      remainingBodyBytes -= before.value == null ? 0 : Buffer.byteLength(before.value, 'utf8')
      const after = limitText(diff.after, remainingBodyBytes)
      remainingBodyBytes -= Buffer.byteLength(after.value, 'utf8')
      truncated ||= path.truncated || before.truncated || after.truncated
      result.push({
        format: 'snapshot',
        path: path.value,
        before: before.value,
        after: after.value
      })
      continue
    }

    const acceptedPaths = diff.paths.slice(0, remainingPathCount)
    remainingPathCount -= acceptedPaths.length
    const paths = acceptedPaths.map((pathValue) => {
      const path = limitText(pathValue, MAX_SHORT_TEXT_BYTES)
      truncated ||= path.truncated
      return path.value
    })
    const patch = limitText(diff.patch, remainingBodyBytes)
    remainingBodyBytes -= Buffer.byteLength(patch.value, 'utf8')
    truncated ||= diff.paths.length > acceptedPaths.length || patch.truncated
    result.push({ format: 'unified', paths, patch: patch.value })
  }

  return { diffs: result, truncated }
}

function copyUsage(usage: AgentUsage): AgentUsage {
  return usage.scope === 'context' ? copyContextUsage(usage) : copyTurnUsage(usage)
}

function copyContextUsage(usage: AgentContextUsage): AgentContextUsage {
  return {
    scope: 'context',
    usedTokens: usage.usedTokens,
    limitTokens: usage.limitTokens,
    ...(usage.cost ? { cost: { amount: usage.cost.amount, currency: usage.cost.currency } } : {})
  }
}

function copyTurnUsage(usage: AgentTurnUsage): AgentTurnUsage {
  return {
    scope: 'turn',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.thoughtTokens != null ? { thoughtTokens: usage.thoughtTokens } : {}),
    ...(usage.cachedReadTokens != null ? { cachedReadTokens: usage.cachedReadTokens } : {}),
    ...(usage.cachedWriteTokens != null ? { cachedWriteTokens: usage.cachedWriteTokens } : {}),
    ...(usage.cost ? { cost: { amount: usage.cost.amount, currency: usage.cost.currency } } : {})
  }
}

function createPayloadTooLargeError(event: AgentEventDraft): AgentEventDraft {
  const { base } = limitBase(event)
  return {
    ...base,
    kind: 'error',
    message: '事件内容过大，已安全省略。',
    recoverable: true,
    code: 'event-payload-too-large'
  }
}

function limitOptionalText(
  value: string | null | undefined,
  maxBytes: number
): { value?: string; truncated: boolean } {
  if (value == null) return { truncated: false }
  return limitText(value, maxBytes)
}

/** 按 Unicode code point 截断，避免在中文或 emoji 的 UTF-8 字节中间切开。 */
function limitText(value: string, maxBytes: number): TextLimitResult {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { value, truncated: false }

  const characters: string[] = []
  let acceptedBytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (acceptedBytes + characterBytes > maxBytes) break
    characters.push(character)
    acceptedBytes += characterBytes
  }
  return { value: characters.join(''), truncated: true }
}

function serializedByteLength(value: AgentEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}
