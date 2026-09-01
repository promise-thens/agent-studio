import type {
  AgentContextUsage,
  AgentDiff,
  AgentEvent,
  AgentTurnUsage,
  AgentUsage
} from '../../shared/agent'
import type { PublicAgentDiffReviewReference, PublicAgentEvent } from '../../shared/agent-event'

const MAX_PUBLIC_DIFF_PATHS = 20
const MAX_PUBLIC_DIFF_PATH_BYTES = 4 * 1024
const MAX_PUBLIC_SHORT_TEXT_BYTES = 4 * 1024

/**
 * 把 Main 内部事件投影为 Renderer 公开 DTO。
 * 这里逐字段构造，禁止 runtimeSessionId、Diff 正文和未来未知字段穿透 IPC。
 */
export function projectPublicAgentEvent(
  event: AgentEvent,
  redactText: (text: string) => string
): PublicAgentEvent {
  const base = {
    runtimeId: event.runtimeId,
    capabilityState: event.capabilityState,
    taskId: event.taskId,
    turnId: event.turnId,
    sequence: event.sequence,
    observedAt: event.observedAt,
    ...(event.truncated ? { truncated: true as const } : {})
  }

  switch (event.kind) {
    case 'agent-message':
    case 'agent-thought':
      return {
        ...base,
        kind: event.kind,
        text: redactText(event.text),
        ...(event.messageId ? { messageId: redactText(event.messageId) } : {})
      }
    case 'agent-attachment':
      return {
        ...base,
        kind: 'agent-attachment',
        attachmentId: event.attachmentId,
        attachmentKind: 'image',
        originalName: redactText(event.originalName)
      }
    case 'tool-call': {
      const parentId = copyPublicParentId(event.parentId, redactText)
      return {
        ...base,
        kind: 'tool-call',
        toolCallId: redactText(event.toolCallId),
        title: redactText(event.title),
        ...(event.status ? { status: event.status } : {}),
        ...(parentId ? { parentId } : {})
      }
    }
    case 'tool-update': {
      const parentId = copyPublicParentId(event.parentId, redactText)
      return {
        ...base,
        kind: 'tool-update',
        toolCallId: redactText(event.toolCallId),
        ...(event.title ? { title: redactText(event.title) } : {}),
        ...(event.status ? { status: event.status } : {}),
        ...(parentId ? { parentId } : {})
      }
    }
    case 'plan':
      return {
        ...base,
        kind: 'plan',
        entries: event.entries.map((entry) => ({
          content: redactText(entry.content),
          priority: entry.priority,
          status: entry.status
        }))
      }
    case 'diff':
      return {
        ...base,
        kind: 'diff',
        references: event.diffs.map((diff) => projectDiffReference(diff, redactText)),
        ...(event.toolCallId ? { toolCallId: redactText(event.toolCallId) } : {})
      }
    case 'usage':
      return { ...base, kind: 'usage', usage: copyUsage(event.usage) }
    case 'turn-complete':
      return {
        ...base,
        kind: 'turn-complete',
        outcome: event.outcome,
        ...(event.usage ? { usage: copyTurnUsage(event.usage) } : {})
      }
    case 'error':
      return {
        ...base,
        kind: 'error',
        message: redactText(event.message),
        recoverable: event.recoverable,
        ...(event.code ? { code: redactText(event.code) } : {})
      }
  }
}

/**
 * 公开 parentId 必须先脱敏再按 toolCallId 同一套短文本上限截断。
 * 空白不当成稳定父身份，避免历史/实时树用空键分组。
 */
function copyPublicParentId(
  parentId: string | undefined,
  redactText: (text: string) => string
): string | undefined {
  if (!parentId?.trim()) return undefined
  const redacted = limitUtf8Text(redactText(parentId), MAX_PUBLIC_SHORT_TEXT_BYTES)
  return redacted.trim() ? redacted : undefined
}

function projectDiffReference(
  diff: AgentDiff,
  redactText: (text: string) => string
): PublicAgentDiffReviewReference {
  const rawPaths = diff.format === 'snapshot' ? [diff.path] : diff.paths
  const pathSummaries = rawPaths
    .slice(0, MAX_PUBLIC_DIFF_PATHS)
    .map((path) => limitUtf8Text(redactText(path), MAX_PUBLIC_DIFF_PATH_BYTES))
  return {
    kind: 'diff-review',
    availability: 'unavailable',
    changedPathCount: rawPaths.length,
    pathSummaries,
    reason: 'git-review-not-implemented'
  }
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

function limitUtf8Text(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const accepted: string[] = []
  let byteLength = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (byteLength + characterBytes > maxBytes) break
    accepted.push(character)
    byteLength += characterBytes
  }
  return accepted.join('')
}
