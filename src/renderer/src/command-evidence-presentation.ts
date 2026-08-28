import type {
  CommandEvidenceInconsistency,
  CommandExecutionEvidence,
  CommandExecutionSource,
  CommandExecutionStatus,
  CommandTrustLevel
} from '../../shared/command'

/** Timeline/ResultReview 使用的命令证据展示模型，不含 transcript 正文。 */
export interface TimelineCommandEvidenceView {
  commandId: string
  toolCallId?: string
  displayCommand: string
  source: CommandExecutionSource
  sourceLabel: string
  cwd: string
  cwdLabel: string
  exitCode?: number
  durationMs?: number
  timedOut: boolean
  truncated: boolean
  trustLevel: CommandTrustLevel
  trustLabel: string
  status: CommandExecutionStatus
  logIncomplete: boolean
  logIncompleteReason?: string
  outputFileNotIngested?: true
  inconsistency?: CommandEvidenceInconsistency
  /** 仅 Runtime 未上报审批时出现；不得把有 approvalId 的自动过说成 Broker 没拦。 */
  brokerGateLabel?: string
}

/** Runtime 上报不得被说成 App 沙箱或 Broker 强制。 */
export function commandSourceLabel(source: CommandExecutionSource): string {
  if (source === 'app-runner') return 'App 自有命令'
  if (source === 'runtime-tool') return 'Runtime 上报命令'
  return '用户终端命令'
}

export function commandTrustLabel(trustLevel: CommandTrustLevel): string {
  if (trustLevel === 'app-enforced') return 'App 强制边界'
  if (trustLevel === 'runtime-reported') return 'Runtime 上报事实'
  return '未验证'
}

/** 标题/ACP status 与结构化退出事实冲突时的可见警告，不得只藏在折叠详情里。 */
export function commandInconsistencyLabel(inconsistency: CommandEvidenceInconsistency): string {
  if (inconsistency === 'title-success-nonzero-exit') return '标题显示成功，但退出码非 0'
  if (inconsistency === 'title-success-timed-out') return '标题显示成功，但命令已超时'
  return '标题显示失败，但退出码为 0'
}

export function presentCommandEvidenceInconsistency(view: TimelineCommandEvidenceView): string {
  if (!view.inconsistency) return ''
  const label = commandInconsistencyLabel(view.inconsistency)
  if (view.exitCode !== undefined) return `${label}（退出码 ${view.exitCode}）`
  return label
}

/**
 * cwd `.` 对 App 命令表示执行根；对 Runtime 命令只表示未冻结，不得暗示沙箱。
 */
/**
 * 未走 ACP request_permission 的 Runtime 命令不能写成 Broker 已授权或沙箱执行。
 * 自动过仍有 approvalId，只标明「没拦」给完全没上报的私自动作。
 */
export function commandBrokerGateLabel(
  evidence: Pick<CommandExecutionEvidence, 'source' | 'approvalId'>
): string | undefined {
  if (evidence.source !== 'runtime-tool') return undefined
  if (evidence.approvalId) return undefined
  return 'Broker 没拦'
}

export function commandCwdLabel(source: CommandExecutionSource, cwd: string): string {
  if (source === 'runtime-tool' && cwd === '.') {
    return 'Runtime 未冻结工作目录（相对路径 .，并非 App 沙箱）'
  }
  if (cwd === '.') return '执行根目录（相对路径 .）'
  return cwd
}

export function commandDurationMs(startedAt: string, endedAt?: string): number | undefined {
  if (!endedAt) return undefined
  const started = Date.parse(startedAt)
  const ended = Date.parse(endedAt)
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return undefined
  return ended - started
}

export function formatCommandDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`
  const seconds = durationMs / 1000
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`
}

export function commandLogIncompleteReason(
  evidence: Pick<CommandExecutionEvidence, 'truncated' | 'transcriptRef' | 'outputFileNotIngested'>
): string | undefined {
  if (evidence.truncated || evidence.transcriptRef.truncated) return '输出已截断，日志不完整'
  if (evidence.transcriptRef.retentionState === 'expired') return '日志已过期，不完整'
  if (evidence.transcriptRef.retentionState === 'missing') return '日志缺失，不完整'
  if (evidence.outputFileNotIngested) return 'Runtime 声明了输出文件但未摄入，日志不完整'
  return undefined
}

export function toCommandEvidenceView(
  evidence: CommandExecutionEvidence
): TimelineCommandEvidenceView {
  const durationMs = commandDurationMs(evidence.startedAt, evidence.endedAt)
  const logIncompleteReason = commandLogIncompleteReason(evidence)
  const view: TimelineCommandEvidenceView = {
    commandId: evidence.commandId,
    displayCommand: evidence.displayCommand,
    source: evidence.source,
    sourceLabel: commandSourceLabel(evidence.source),
    cwd: evidence.cwd,
    cwdLabel: commandCwdLabel(evidence.source, evidence.cwd),
    timedOut: evidence.timedOut,
    truncated: evidence.truncated || evidence.transcriptRef.truncated,
    trustLevel: evidence.trustLevel,
    trustLabel: commandTrustLabel(evidence.trustLevel),
    status: evidence.status,
    logIncomplete: logIncompleteReason != null
  }
  if (evidence.toolCallId) view.toolCallId = evidence.toolCallId
  if (evidence.exitCode !== undefined) view.exitCode = evidence.exitCode
  if (durationMs !== undefined) view.durationMs = durationMs
  if (logIncompleteReason) view.logIncompleteReason = logIncompleteReason
  if (evidence.outputFileNotIngested) view.outputFileNotIngested = true
  if (evidence.inconsistency) view.inconsistency = evidence.inconsistency
  const brokerGateLabel = commandBrokerGateLabel(evidence)
  if (brokerGateLabel) view.brokerGateLabel = brokerGateLabel
  return view
}

/** 短摘要进折叠详情，禁止把完整 transcript 写进 Markdown。 */
export function presentCommandEvidenceSummary(view: TimelineCommandEvidenceView): string {
  const lines = [
    view.displayCommand,
    `${view.sourceLabel} · ${view.trustLabel}`,
    `工作目录：${view.cwdLabel}`
  ]
  if (view.exitCode !== undefined) lines.push(`退出码 ${view.exitCode}`)
  if (view.durationMs !== undefined) lines.push(`耗时 ${formatCommandDuration(view.durationMs)}`)
  if (view.timedOut) lines.push('已超时')
  if (view.inconsistency) lines.push(presentCommandEvidenceInconsistency(view))
  if (view.logIncompleteReason) lines.push(view.logIncompleteReason)
  if (view.brokerGateLabel) lines.push(view.brokerGateLabel)
  return lines.join('\n')
}
