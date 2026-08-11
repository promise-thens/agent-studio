import {
  AGENT_CAPABILITY_IDS,
  type AgentCapability,
  type AgentCapabilityEvidenceSource,
  type AgentCapabilityId,
  type AgentCapabilityMaturity,
  type AgentCapabilitySupport,
  type AgentCapabilityVerification,
  type AgentRuntimeCapabilitySnapshot,
  type AgentRuntimeId
} from '../../shared/agent'
import { redactSensitiveText } from '../security/sensitive-redaction'

const MAX_CAPABILITY_REASON_BYTES = 512
const UNKNOWN_CAPABILITY_REASON = '当前 Runtime 尚未验证此能力。'
const INVALID_CAPABILITY_REASON = '能力声明不完整或证据不一致，已按尚未验证处理。'
const UNSUPPORTED_CAPABILITY_REASON = '当前 Runtime 明确不支持此能力。'

type TextRedactor = (text: string) => string

/** 归一化前的能力声明；字段保持可选，以便安全收敛不完整或非法的 Runtime 输入。 */
export interface AgentCapabilityInput {
  capabilityId: AgentCapabilityId
  support?: AgentCapabilitySupport
  maturity?: AgentCapabilityMaturity
  verification?: AgentCapabilityVerification
  source?: AgentCapabilityEvidenceSource
  reason?: string
}

export interface CreateAgentRuntimeCapabilitySnapshotOptions {
  runtimeId: AgentRuntimeId
  runtimeVersion?: string
  protocolVersion?: string
  observedAt?: string
  capabilities?: Iterable<AgentCapabilityInput>
  redactText?: TextRedactor
}

export interface UpdateAgentRuntimeCapabilitySnapshotOptions {
  observedAt?: string
  redactText?: TextRedactor
}

/**
 * 构造覆盖全部固定 ID 的能力快照。输入中的未知字段不会被复制，缺失项统一保守降级，
 * 避免 Runtime 原始协议对象或扩展字段越过主进程边界。
 */
export function createAgentRuntimeCapabilitySnapshot(
  options: CreateAgentRuntimeCapabilitySnapshotOptions
): AgentRuntimeCapabilitySnapshot {
  const declaredCapabilities = new Map<AgentCapabilityId, AgentCapabilityInput>()

  for (const capability of options.capabilities ?? []) {
    if (isAgentCapabilityId(capability.capabilityId)) {
      declaredCapabilities.set(capability.capabilityId, capability)
    }
  }

  const capabilities = Object.fromEntries(
    AGENT_CAPABILITY_IDS.map((capabilityId) => {
      const input = declaredCapabilities.get(capabilityId) ?? { capabilityId }
      return [capabilityId, normalizeAgentCapability(input, options.redactText)]
    })
  ) as Record<AgentCapabilityId, AgentCapability>

  return {
    runtimeId: options.runtimeId,
    ...(options.runtimeVersion != null ? { runtimeVersion: options.runtimeVersion } : {}),
    ...(options.protocolVersion != null ? { protocolVersion: options.protocolVersion } : {}),
    observedAt: options.observedAt ?? new Date().toISOString(),
    capabilities
  }
}

/**
 * 在保留完整矩阵和 Runtime 版本摘要的前提下更新单项能力，用于握手声明和真实运行验证提升。
 */
export function updateAgentRuntimeCapabilitySnapshot(
  snapshot: AgentRuntimeCapabilitySnapshot,
  capability: AgentCapabilityInput,
  options: UpdateAgentRuntimeCapabilitySnapshotOptions = {}
): AgentRuntimeCapabilitySnapshot {
  return createAgentRuntimeCapabilitySnapshot({
    runtimeId: snapshot.runtimeId,
    ...(snapshot.runtimeVersion != null ? { runtimeVersion: snapshot.runtimeVersion } : {}),
    ...(snapshot.protocolVersion != null ? { protocolVersion: snapshot.protocolVersion } : {}),
    ...(options.observedAt != null ? { observedAt: options.observedAt } : {}),
    capabilities: [...Object.values(snapshot.capabilities), capability],
    ...(options.redactText != null ? { redactText: options.redactText } : {})
  })
}

/**
 * 将单项能力收敛为合法的支持程度、成熟度、验证程度和证据来源组合。
 * 任一关键字段缺失或互相矛盾时均回退为 unknown，不能把猜测包装成可用能力。
 */
export function normalizeAgentCapability(
  input: AgentCapabilityInput,
  redactText?: TextRedactor
): AgentCapability {
  const reason = sanitizeCapabilityReason(input.reason, redactText)

  if (input.support === 'unknown' || input.support == null) {
    return createUnknownCapability(input.capabilityId, reason, redactText)
  }

  if (input.support === 'unsupported') {
    if (input.source !== 'static' && input.source !== 'protocol') {
      return createUnknownCapability(
        input.capabilityId,
        reason ?? INVALID_CAPABILITY_REASON,
        redactText
      )
    }

    return {
      capabilityId: input.capabilityId,
      support: 'unsupported',
      verification: 'declared',
      source: input.source,
      reason: reason ?? UNSUPPORTED_CAPABILITY_REASON
    }
  }

  if (input.support !== 'native' && input.support !== 'simulated') {
    return createUnknownCapability(
      input.capabilityId,
      reason ?? INVALID_CAPABILITY_REASON,
      redactText
    )
  }

  const evidence = normalizeSupportedEvidence(input.verification, input.source)
  if ((input.maturity !== 'stable' && input.maturity !== 'experimental') || evidence == null) {
    return createUnknownCapability(
      input.capabilityId,
      reason ?? INVALID_CAPABILITY_REASON,
      redactText
    )
  }

  if ((input.support === 'simulated' || input.maturity === 'experimental') && reason == null) {
    return createUnknownCapability(input.capabilityId, INVALID_CAPABILITY_REASON, redactText)
  }

  return {
    capabilityId: input.capabilityId,
    support: input.support,
    maturity: input.maturity,
    verification: evidence.verification,
    source: evidence.source,
    ...(reason != null ? { reason } : {})
  }
}

function normalizeSupportedEvidence(
  verification: AgentCapabilityVerification | undefined,
  source: AgentCapabilityEvidenceSource | undefined
):
  | { verification: 'declared'; source: 'static' | 'protocol' }
  | { verification: 'verified'; source: 'runtime' }
  | undefined {
  if (verification === 'declared' && (source === 'static' || source === 'protocol')) {
    return { verification, source }
  }
  if (verification === 'verified' && source === 'runtime') {
    return { verification, source }
  }
  return undefined
}

function createUnknownCapability(
  capabilityId: AgentCapabilityId,
  reason: string | undefined,
  redactText?: TextRedactor
): AgentCapability {
  const safeReason =
    sanitizeCapabilityReason(reason ?? UNKNOWN_CAPABILITY_REASON, redactText) ??
    UNKNOWN_CAPABILITY_REASON

  return {
    capabilityId,
    support: 'unknown',
    verification: 'unverified',
    source: 'fallback',
    reason: safeReason
  }
}

/** 原因文本先执行调用方脱敏和通用脱敏，再按 Unicode code point 安全限制 UTF-8 字节数。 */
function sanitizeCapabilityReason(
  reason: string | undefined,
  redactText?: TextRedactor
): string | undefined {
  if (reason == null) return undefined

  const callerRedacted = redactText ? redactText(reason) : reason
  const redacted = redactSensitiveText(callerRedacted).trim()
  if (!redacted) return undefined

  return limitUtf8Text(redacted, MAX_CAPABILITY_REASON_BYTES)
}

function limitUtf8Text(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value

  const characters: string[] = []
  let acceptedBytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (acceptedBytes + characterBytes > maxBytes) break
    characters.push(character)
    acceptedBytes += characterBytes
  }
  return characters.join('')
}

function isAgentCapabilityId(value: string): value is AgentCapabilityId {
  return (AGENT_CAPABILITY_IDS as readonly string[]).includes(value)
}
