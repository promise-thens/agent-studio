import type {
  AgentContextUsage,
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentPlanEntry,
  AgentToolStatus,
  AgentTurnUsage
} from '../../shared/agent'
import type { CommandExecutionStatus } from '../../shared/command'
import {
  presentCommandEvidenceInconsistency,
  presentCommandEvidenceSummary
} from './command-evidence-presentation'
import { isReadToolTitle, presentToolTitle } from './conversation-tool-presentation'
import { isActiveConversationTurn } from './task-conversation-view'
import type {
  TimelineAttachmentNode,
  TimelineTextNode,
  TimelineToolNode,
  TurnTimelineViewModel
} from './task-timeline-reducer'

export { formatToolVerbPhrase, isReadToolTitle } from './conversation-tool-presentation'

export const PERMISSION_ALLOW_TASK_LABEL = '本任务允许'
export const PERMISSION_INSUFFICIENT_EVIDENCE_NOTICE = '证据不够，不能自动过'
export const THOUGHT_SUMMARY = '思考过程'

export interface ConversationUserBlock {
  kind: 'user'
  nodeId: string
  text: string
  taskId?: string
  attachmentIds?: string[]
}

export interface ConversationThoughtBlock {
  kind: 'thought'
  nodeId: string
  text: string
  defaultCollapsed: true
  summary: typeof THOUGHT_SUMMARY
}

export interface ConversationPlanBlock {
  kind: 'plan'
  nodeId: string
  entries: AgentPlanEntry[]
  defaultExpanded: boolean
  summary: string
  completedCount: number
}

export interface ConversationToolBlock {
  kind: 'tool'
  nodeId: string
  label: string
  status: AgentToolStatus | 'unknown'
  tools: TimelineToolNode[]
  mergedReadCount?: number
  /** 长命令/路径，主列默认折叠，不进 summary。 */
  detail?: string
  /** 标题与退出事实冲突时主列可见，不得只藏在折叠详情里。 */
  warning?: string
}

export interface ConversationSubagentBlock {
  kind: 'subagent'
  nodeId: string
  name: string
  status: 'running' | 'completed' | 'failed'
  tools: ConversationToolBlock[]
}

export interface ConversationMessageBlock {
  kind: 'message'
  nodeId: string
  text: string
  render: 'markdown'
}

export interface ConversationAttachmentBlock {
  kind: 'attachment'
  nodeId: string
  taskId: string
  attachmentIds: string[]
}

export interface ConversationErrorBlock {
  kind: 'error'
  nodeId: string
  message: string
  recoverable: boolean
}

export interface ConversationPermissionBlock {
  kind: 'permission'
  nodeId: string
  request: AgentPermissionRequest
  primaryLabel: string
}

export interface ConversationUsageBlock {
  kind: 'usage'
  nodeId: string
  defaultCollapsed: true
  summary: string
}

export interface PermissionCardPresentation {
  variant: 'inline'
  role: 'region'
  autofocus: false
  density: 'compact'
}

export interface ConversationAvailabilityBlock {
  kind: 'availability'
  nodeId: string
  message: string
}

export type ConversationBlock =
  | ConversationUserBlock
  | ConversationThoughtBlock
  | ConversationPlanBlock
  | ConversationToolBlock
  | ConversationSubagentBlock
  | ConversationMessageBlock
  | ConversationAttachmentBlock
  | ConversationErrorBlock
  | ConversationPermissionBlock
  | ConversationUsageBlock
  | ConversationAvailabilityBlock

/**
 * L1/L2 主按钮是「本任务允许」→ allow-task；L3 没有 task 范围时退回仅本次。
 * 只改展示决策，不改 Broker / IPC。
 */
export function resolvePermissionPrimaryAction(
  request: Pick<AgentPermissionRequest, 'allowedScopes' | 'risk'>
): { decision: AgentPermissionDecision; label: string } {
  if (request.risk !== 'L3' && request.allowedScopes.includes('task')) {
    return { decision: 'allow-task', label: PERMISSION_ALLOW_TASK_LABEL }
  }
  return { decision: 'allow-once', label: '仅允许这一次' }
}

/**
 * 审批卡在自身焦点内：Enter 走主按钮，Esc 拒绝。
 * 输入法确认、Shift+Enter、焦点在非主按钮上时不抢原生按钮行为。
 */
export function resolvePermissionCardKeyDecision(
  event: { key: string; isComposing?: boolean; shiftKey?: boolean; keyCode?: number },
  primaryDecision: AgentPermissionDecision,
  options?: { targetIsNonPrimaryButton?: boolean }
): AgentPermissionDecision | null {
  if (event.isComposing || event.keyCode === 229) return null
  if (event.key === 'Escape') return 'deny'
  if (event.key === 'Enter' && !event.shiftKey && !options?.targetIsNonPrimaryButton) {
    return primaryDecision
  }
  return null
}

/**
 * 有可信 path/command/origin 就让卡自己展示；没有则明确告诉用户不能自动过。
 * 占位「未提供可信…」不能当成真实命令或 origin。
 */
export function resolvePermissionEvidenceNotice(
  request: Pick<AgentPermissionRequest, 'targets'>
): string | null {
  if (request.targets.some((target) => hasTrustedPermissionEvidence(target))) return null
  return PERMISSION_INSUFFICIENT_EVIDENCE_NOTICE
}

function hasTrustedPermissionEvidence(target: string): boolean {
  if (
    target.startsWith('path: ') ||
    target.startsWith('origin: ') ||
    target.startsWith('git: ') ||
    target.startsWith('project: ') ||
    target.startsWith('worktree: ')
  ) {
    return target.trim().length > 8
  }
  if (target.startsWith('command: ')) {
    return !target.includes('未提供可信')
  }
  return false
}

/**
 * 流内权限必须是阅读列小卡：非 dialog、不挂载抢焦点，避免把计划和对话顶走。
 */
export function resolvePermissionCardPresentation(): PermissionCardPresentation {
  return {
    variant: 'inline',
    role: 'region',
    autofocus: false,
    density: 'compact'
  }
}

/**
 * 错位审批卡必须露出任务名；贴在当前 Turn 上时保持紧凑，避免重复身份。
 * 空白标题不画「来自「」」，否则错位卡仍然没有可辨认来源。
 */
export function resolvePermissionOriginLabel(input: {
  taskTitle?: string | null
  attachedToViewedTurn: boolean
}): string | null {
  if (input.attachedToViewedTurn) return null
  const title = input.taskTitle?.trim() ?? ''
  if (!title) return null
  return `来自「${title}」`
}

/** 有可展示的 token 数字才算有数据；NaN / 缺字段不画空壳。 */
export function hasConversationUsageData(usage: AgentContextUsage | AgentTurnUsage): boolean {
  if (usage.scope === 'context') {
    return Number.isFinite(usage.usedTokens) && Number.isFinite(usage.limitTokens)
  }
  return Number.isFinite(usage.totalTokens)
}

export function formatUsageSummary(usage: AgentContextUsage | AgentTurnUsage): string {
  if (usage.scope === 'context') return `用量 · 上下文 ${usage.usedTokens}/${usage.limitTokens}`
  return `用量 · ${usage.totalTokens} tokens`
}

export function formatMergedReadLabel(count: number): string {
  return `读了 ${count} 个文件`
}

const SESSION_MEDIA_PATH_LINE = /^(?:images|videos)\/\d+\.(?:jpe?g|png|webp|gif|mp4)$/i

function isSessionMediaPathLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  const candidates = [trimmed, trimmed.replace(/^`+|`+$/g, '')]
  const markdown = /^(?:!)?\[([^\]]*)\]\(([^)]+)\)$/.exec(trimmed)
  if (markdown) {
    candidates.push(markdown[1].trim())
    const href = markdown[2].trim().replace(/^[a-z]+:\/\//i, '')
    candidates.push(href)
    candidates.push(href.split('/').slice(-2).join('/'))
  }
  return candidates.some((value) => SESSION_MEDIA_PATH_LINE.test(value))
}

/** 去掉 Grok 生图写在正文里的独立路径行，图已经由附件块展示。 */
export function stripDisplayedSessionMediaPaths(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !isSessionMediaPathLine(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 把说明和后续句子拆开，方便把图片插到路径原来的位置。 */
export function splitAssistantMessageAroundMedia(text: string): { before: string; after: string } {
  const stripped = stripDisplayedSessionMediaPaths(text)
  const match = stripped.match(/^(.*?)\n\s*\n([\s\S]*)$/)
  if (!match) return { before: stripped, after: '' }
  return { before: match[1].trim(), after: match[2].trim() }
}

function collectRuntimeMediaBlocks(
  nodes: TurnTimelineViewModel['nodes']
): ConversationAttachmentBlock[] {
  const blocks: ConversationAttachmentBlock[] = []
  let index = 0
  while (index < nodes.length) {
    const node = nodes[index]
    if (node.kind !== 'attachment') {
      index += 1
      continue
    }
    const run: TimelineAttachmentNode[] = [node]
    while (index + 1 < nodes.length && nodes[index + 1]?.kind === 'attachment') {
      index += 1
      run.push(nodes[index] as TimelineAttachmentNode)
    }
    blocks.push({
      kind: 'attachment',
      nodeId: node.nodeId,
      taskId: node.taskId,
      attachmentIds: run.map((item) => item.attachmentId)
    })
    index += 1
  }
  return blocks
}

/**
 * 把 P0-09 Turn 节点收成主列对话块。
 * 用户句只保留一处；无父子字段时不产出 subagent 组，工具保持扁平。
 */
export function projectConversationTurn(
  turn: TurnTimelineViewModel,
  options?: { pendingPermission?: AgentPermissionRequest | null }
): ConversationBlock[] {
  const blocks: ConversationBlock[] = []
  const userNode = turn.nodes.find((node): node is TimelineTextNode => node.kind === 'user-prompt')
  const userText = userNode?.text.trim() || turn.prompt.trim()
  if (userText || userNode?.attachmentIds?.length) {
    blocks.push({
      kind: 'user',
      nodeId: userNode?.nodeId ?? `${turn.taskId}:${turn.turnId}:user`,
      text: userText,
      taskId: turn.taskId,
      ...(userNode?.attachmentIds?.length ? { attachmentIds: userNode.attachmentIds } : {})
    })
  }

  const rest = turn.nodes.filter((node) => node.kind !== 'user-prompt')
  const mediaBlocks = collectRuntimeMediaBlocks(rest)
  let mediaInserted = false
  const insertRuntimeMedia = (): void => {
    if (mediaInserted || mediaBlocks.length === 0) return
    mediaInserted = true
    blocks.push(...mediaBlocks)
  }
  let index = 0
  while (index < rest.length) {
    const node = rest[index]
    if (node.kind === 'attachment') {
      while (index + 1 < rest.length && rest[index + 1]?.kind === 'attachment') index += 1
      index += 1
      continue
    }
    if (node.kind === 'command-evidence') {
      blocks.push({
        kind: 'tool',
        nodeId: node.nodeId,
        label: node.command.sourceLabel,
        status: commandStatusToToolStatus(node.command.status),
        tools: [],
        detail: presentCommandEvidenceSummary(node.command)
      })
      index += 1
      continue
    }
    if (node.kind === 'tool') {
      const run: TimelineToolNode[] = [node]
      if (isReadToolTitle(node.title)) {
        while (
          index + 1 < rest.length &&
          rest[index + 1]?.kind === 'tool' &&
          isReadToolTitle((rest[index + 1] as TimelineToolNode).title)
        ) {
          index += 1
          run.push(rest[index] as TimelineToolNode)
        }
      }
      blocks.push(toToolBlock(run))
      index += 1
      continue
    }
    if (node.kind === 'thought' && node.text.trim()) {
      blocks.push({
        kind: 'thought',
        nodeId: node.nodeId,
        text: node.text,
        defaultCollapsed: true,
        summary: THOUGHT_SUMMARY
      })
    } else if (node.kind === 'plan') {
      blocks.push(toPlanBlock(turn, node.entries, node.nodeId))
    } else if (node.kind === 'message') {
      if (mediaBlocks.length > 0 && !mediaInserted) {
        const { before, after } = splitAssistantMessageAroundMedia(node.text)
        if (before) {
          blocks.push({
            kind: 'message',
            nodeId: node.nodeId,
            text: before,
            render: 'markdown'
          })
        }
        insertRuntimeMedia()
        if (after) {
          blocks.push({
            kind: 'message',
            nodeId: `${node.nodeId}:after-media`,
            text: after,
            render: 'markdown'
          })
        }
      } else {
        const text = mediaInserted
          ? stripDisplayedSessionMediaPaths(node.text)
          : node.text.trim()
            ? node.text
            : ''
        if (text.trim()) {
          blocks.push({
            kind: 'message',
            nodeId: node.nodeId,
            text,
            render: 'markdown'
          })
        }
      }
    } else if (node.kind === 'error' && node.message.trim()) {
      blocks.push({
        kind: 'error',
        nodeId: node.nodeId,
        message: node.message,
        recoverable: node.recoverable
      })
    } else if (node.kind === 'usage' && hasConversationUsageData(node.usage)) {
      blocks.push({
        kind: 'usage',
        nodeId: node.nodeId,
        defaultCollapsed: true,
        summary: formatUsageSummary(node.usage)
      })
    } else if (node.kind === 'availability') {
      blocks.push({
        kind: 'availability',
        nodeId: node.nodeId,
        message: node.message
      })
    }
    index += 1
  }

  insertRuntimeMedia()

  const pending = options?.pendingPermission
  if (pending && pending.taskId === turn.taskId && pending.turnId === turn.turnId) {
    insertPermissionAfterProcess(blocks, {
      kind: 'permission',
      nodeId: `${pending.taskId}:${pending.turnId}:permission:${pending.approvalId}`,
      request: pending,
      primaryLabel: resolvePermissionPrimaryAction(pending).label
    })
  }

  return blocks
}

/** 审批卡贴在计划/工具后面，不要排到长回复之后把当前步顶出视口。 */
function insertPermissionAfterProcess(
  blocks: ConversationBlock[],
  permission: ConversationPermissionBlock
): void {
  const fromEnd = [...blocks]
    .reverse()
    .findIndex(
      (block) =>
        block.kind === 'plan' ||
        block.kind === 'tool' ||
        block.kind === 'thought' ||
        block.kind === 'subagent'
    )
  if (fromEnd < 0) {
    blocks.push(permission)
    return
  }
  blocks.splice(blocks.length - fromEnd, 0, permission)
}

function toPlanBlock(
  turn: Pick<TurnTimelineViewModel, 'status'>,
  entries: AgentPlanEntry[],
  nodeId: string
): ConversationPlanBlock {
  const completedCount = entries.filter((entry) => entry.status === 'completed').length
  const defaultExpanded = isActiveConversationTurn(turn)
  return {
    kind: 'plan',
    nodeId,
    entries,
    defaultExpanded,
    summary: defaultExpanded ? '计划' : `计划 · ${completedCount}/${entries.length} 完成`,
    completedCount
  }
}

function toToolBlock(tools: TimelineToolNode[]): ConversationToolBlock {
  const first = tools[0]
  if (tools.length > 1 && tools.every((item) => isReadToolTitle(item.title))) {
    return {
      kind: 'tool',
      nodeId: first.nodeId,
      label: formatMergedReadLabel(tools.length),
      status: groupToolStatus(tools),
      tools,
      mergedReadCount: tools.length
    }
  }
  const presented = presentToolTitle(first.title)
  const evidence = first.command
  const evidenceSummary = evidence ? presentCommandEvidenceSummary(evidence) : undefined
  const detail = [presented.detail, evidenceSummary].filter(Boolean).join('\n')
  const warning = evidence?.inconsistency
    ? presentCommandEvidenceInconsistency(evidence)
    : undefined
  return {
    kind: 'tool',
    nodeId: first.nodeId,
    label: presented.label,
    status: evidence ? commandStatusToToolStatus(evidence.status) : first.status,
    tools,
    ...(detail ? { detail } : {}),
    ...(warning ? { warning } : {}),
    ...(isReadToolTitle(first.title) ? { mergedReadCount: 1 } : {})
  }
}

function commandStatusToToolStatus(status: CommandExecutionStatus): AgentToolStatus | 'unknown' {
  if (status === 'succeeded') return 'completed'
  if (status === 'failed' || status === 'start-failed' || status === 'timed-out') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'running') return 'in_progress'
  return 'unknown'
}

function groupToolStatus(tools: TimelineToolNode[]): AgentToolStatus | 'unknown' {
  if (tools.some((item) => item.status === 'failed')) return 'failed'
  if (tools.some((item) => item.status === 'cancelled')) return 'cancelled'
  if (tools.some((item) => item.status === 'in_progress' || item.status === 'pending'))
    return 'in_progress'
  if (tools.every((item) => item.status === 'completed')) return 'completed'
  return firstStatusOf(tools)
}

function firstStatusOf(tools: TimelineToolNode[]): AgentToolStatus | 'unknown' {
  return tools[0]?.status ?? 'unknown'
}
