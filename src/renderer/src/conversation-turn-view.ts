import type {
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentPlanEntry,
  AgentToolStatus
} from '../../shared/agent'
import { isActiveConversationTurn } from './task-conversation-view'
import type {
  TimelineTextNode,
  TimelineToolNode,
  TurnTimelineViewModel
} from './task-timeline-reducer'

export const PERMISSION_ALLOW_TASK_LABEL = '本任务允许'
export const THOUGHT_SUMMARY = '思考过程'

export interface ConversationUserBlock {
  kind: 'user'
  nodeId: string
  text: string
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
  | ConversationErrorBlock
  | ConversationPermissionBlock
  | ConversationUsageBlock
  | ConversationAvailabilityBlock

const READ_TITLE_RE = /^(?:读取|读了|读文件[:：]?\s*|Reading\s+|Read\s+|read\s+)/i

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

/** 连续同类读取才合并；禁止用标题里的 subagent 字符串编造分组。 */
export function isReadToolTitle(title: string): boolean {
  return READ_TITLE_RE.test(title.trim())
}

export function formatToolVerbPhrase(title: string): string {
  const trimmed = title.trim()
  if (!isReadToolTitle(trimmed)) return trimmed
  const target = trimmed.replace(READ_TITLE_RE, '').trim()
  return target ? `读了 ${target}` : '读了文件'
}

export function formatMergedReadLabel(count: number): string {
  return `读了 ${count} 个文件`
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
  if (userText) {
    blocks.push({
      kind: 'user',
      nodeId: userNode?.nodeId ?? `${turn.taskId}:${turn.turnId}:user`,
      text: userText
    })
  }

  const rest = turn.nodes.filter((node) => node.kind !== 'user-prompt')
  let index = 0
  while (index < rest.length) {
    const node = rest[index]
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
    } else if (node.kind === 'message' && node.text.trim()) {
      blocks.push({
        kind: 'message',
        nodeId: node.nodeId,
        text: node.text,
        render: 'markdown'
      })
    } else if (node.kind === 'error' && node.message.trim()) {
      blocks.push({
        kind: 'error',
        nodeId: node.nodeId,
        message: node.message,
        recoverable: node.recoverable
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

  const pending = options?.pendingPermission
  if (pending && pending.taskId === turn.taskId && pending.turnId === turn.turnId) {
    blocks.push({
      kind: 'permission',
      nodeId: `${pending.taskId}:${pending.turnId}:permission:${pending.approvalId}`,
      request: pending,
      primaryLabel: resolvePermissionPrimaryAction(pending).label
    })
  }

  return blocks
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
  return {
    kind: 'tool',
    nodeId: first.nodeId,
    label: formatToolVerbPhrase(first.title),
    status: first.status,
    tools,
    ...(isReadToolTitle(first.title) ? { mergedReadCount: 1 } : {})
  }
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
