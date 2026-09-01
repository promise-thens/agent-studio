import type { AgentToolStatus } from '../../shared/agent'
import type { SubagentActivityToolRow } from '../../shared/task-ipc'
import { presentToolTitle } from './conversation-tool-presentation'
import { formatToolVerbPhrase, type ConversationToolBlock } from './conversation-turn-view'

/** 根卡 + 一层 ToolRow；禁止再套第三层 SubagentCard。 */
export const SUBAGENT_CARD_MAX_DEPTH = 2

/** 诚实停止：没有 child cancel，停的是整场 Turn，不是某一张卡。 */
export const SUBAGENT_STOP_COPY = '停止会结束整场 Turn，不能只停这张卡。'

export { SUBAGENT_AMBIGUOUS_COPY, formatSubagentDuration } from './subagent-spawn-title'

export interface ConversationSubagentMountBlock {
  kind: string
}

export interface SubagentToolRowView {
  key: string
  label: string
  status: AgentToolStatus | 'unknown'
  files: readonly string[]
  detail?: string
}

export interface SubagentStopPolicy {
  hasChildCancel: false
  scope: 'turn'
  copy: typeof SUBAGENT_STOP_COPY
}

/** 卡片内部若再遇到 group/subagent，摊成 ToolRow，不再递归套卡。 */
export type SubagentFlattenInput =
  | ConversationToolBlock
  | {
      kind: 'subagent' | 'agent-group'
      nodeId: string
      tools: readonly SubagentFlattenInput[]
    }

export interface SubagentCardView {
  name: string
  status: 'running' | 'completed' | 'failed'
  statusLabel: string
  countLine: string
  defaultExpanded: boolean
  /** 失败只标在这张卡上，不并进父助手消息。 */
  errorInParentMessage: false
  tools: SubagentToolRowView[]
  maxDepth: typeof SUBAGENT_CARD_MAX_DEPTH
  nestedCardCount: 0
  stop: SubagentStopPolicy
  rowKeys: string[]
}

export interface SubagentToolOwnership {
  sharedToolNodeIds: string[]
  toolsByCard: Record<string, string[]>
}

/**
 * 主列只在投影真的给出 subagent 块时挂载卡片。
 * 结构化 `[subagent:` 或 parentId 才会成组；禁止用中文标题猜树。
 */
export function shouldMountSubagentCard(
  block: ConversationSubagentMountBlock | null | undefined
): boolean {
  return block?.kind === 'subagent'
}

export function subagentStatusLabel(status: 'running' | 'completed' | 'failed'): string {
  if (status === 'running') return '进行中'
  if (status === 'failed') return '失败'
  return '已完成'
}

/** 折叠态第二行：计数 + 点开提示，不暴露 Runtime 工具术语。 */
export function formatSubagentCountLine(toolCount: number): string {
  return toolCount > 0 ? `${toolCount} 个动作 · 点开查看` : '点开查看活动'
}

/** 父 ACP 时间线没有孩子工具时，检查器说明为什么是空的。 */
export function subagentEmptyActivityCopy(
  source: 'pending' | 'grok-session' | 'missing' | undefined
): string {
  if (source === 'pending') return '正在读取这个子代理的工具记录…'
  if (source === 'missing') {
    return '子代理在独立会话里工作。父对话只有 spawn 行，还没读到它的工具记录。'
  }
  return '还没有可展示的工具活动。'
}

/** 把 Grok 子 session 工具行收成检查器 ToolRow 能吃的对话块。 */
export function subagentToolsFromActivity(
  tools: readonly SubagentActivityToolRow[]
): ConversationToolBlock[] {
  return tools.map((row) => {
    const presented = presentToolTitle(row.title)
    return {
      kind: 'tool',
      nodeId: row.toolCallId,
      label: presented.label,
      status: row.status,
      tools: [],
      ...(presented.detail ? { detail: presented.detail } : {})
    }
  })
}

/** 子 session 连续读取合成一行，完成态不再用重复状态淹没真正异常。 */
export function subagentActivityRows(
  tools: readonly SubagentActivityToolRow[]
): SubagentToolRowView[] {
  const rows: SubagentToolRowView[] = []
  let index = 0
  while (index < tools.length) {
    const first = tools[index]
    if (!first) break
    const presented = presentToolTitle(first.title)
    if (presented.label.startsWith('读了 ')) {
      const run: SubagentActivityToolRow[] = [first]
      while (index + 1 < tools.length) {
        const next = tools[index + 1]
        if (!next || !presentToolTitle(next.title).label.startsWith('读了 ')) break
        run.push(next)
        index += 1
      }
      const files = [
        ...new Set(
          run
            .map((item) => presentToolTitle(item.title).label.replace(/^读了\s+/, ''))
            .filter(Boolean)
        )
      ]
      if (run.length > 1) {
        rows.push({
          key: run[0]!.toolCallId,
          label: `读取 ${files.length || run.length} 个文件`,
          status: groupedActivityStatus(run),
          files
        })
        index += 1
        continue
      }
    }
    rows.push({
      key: first.toolCallId,
      label: presented.label,
      status: first.status,
      files: [],
      ...(presented.detail ? { detail: presented.detail } : {})
    })
    index += 1
  }
  return rows
}

/** 折叠态显示真实动作数量；合并读取行仍按底层工具数量计数。 */
export function countSubagentTools(tools: readonly ConversationToolBlock[]): number {
  return tools.reduce((count, tool) => count + Math.max(1, tool.tools.length), 0)
}

export function toSubagentToolRows(tools: readonly ConversationToolBlock[]): SubagentToolRowView[] {
  return tools.map((tool) => ({
    key: tool.nodeId,
    label: tool.label,
    status: tool.status,
    files: filesOfToolBlock(tool),
    ...(tool.detail ? { detail: tool.detail } : {})
  }))
}

export type SubagentCardStatus = 'running' | 'completed' | 'failed'

/** 没有 child cancel 协议，只提供停整场 Turn。 */
export function subagentStopPolicy(): SubagentStopPolicy {
  return {
    hasChildCancel: false,
    scope: 'turn',
    copy: SUBAGENT_STOP_COPY
  }
}

function isNestedSubagentGroup(
  item: SubagentFlattenInput
): item is Extract<SubagentFlattenInput, { kind: 'subagent' | 'agent-group' }> {
  return item.kind === 'subagent' || item.kind === 'agent-group'
}

/**
 * 深度限制 2：卡片内部只出 ToolRow。
 * 孩子自己又是 group 时摊平，避免第三层 SubagentCard。
 */
export function flattenSubagentToolsToRows(
  tools: readonly SubagentFlattenInput[]
): SubagentToolRowView[] {
  const rows: SubagentToolRowView[] = []
  for (const item of tools) {
    if (isNestedSubagentGroup(item)) {
      rows.push(...flattenSubagentToolsToRows(item.tools))
      continue
    }
    rows.push(...toSubagentToolRows([item]))
  }
  return rows
}

export function toSubagentCardView(block: {
  name: string
  status: 'running' | 'completed' | 'failed'
  tools: readonly SubagentFlattenInput[]
}): SubagentCardView {
  const tools = flattenSubagentToolsToRows(block.tools)
  return {
    name: block.name,
    status: block.status,
    statusLabel: subagentStatusLabel(block.status),
    countLine: formatSubagentCountLine(tools.length),
    defaultExpanded: block.status === 'running',
    errorInParentMessage: false,
    tools,
    maxDepth: SUBAGENT_CARD_MAX_DEPTH,
    nestedCardCount: 0,
    stop: subagentStopPolicy(),
    rowKeys: tools.map((row) => row.key)
  }
}

function groupedActivityStatus(
  tools: readonly SubagentActivityToolRow[]
): AgentToolStatus | 'unknown' {
  const statuses = new Set(tools.map((tool) => tool.status))
  if (statuses.has('failed')) return 'failed'
  if (statuses.has('in_progress')) return 'in_progress'
  if (statuses.has('pending')) return 'pending'
  if (statuses.has('cancelled')) return 'cancelled'
  if (statuses.size === 1 && statuses.has('completed')) return 'completed'
  return 'unknown'
}

/** 每个孩子只认自己的 tool nodeId，两个并行子 Agent 不得共用同一行。 */
export function isolateSubagentToolOwnership(
  cards: readonly { nodeId: string; tools: readonly { nodeId: string }[] }[]
): SubagentToolOwnership {
  const toolsByCard: Record<string, string[]> = {}
  const owners = new Map<string, string>()
  const shared = new Set<string>()
  for (const card of cards) {
    const ids = card.tools.map((tool) => tool.nodeId)
    toolsByCard[card.nodeId] = ids
    for (const id of ids) {
      const owner = owners.get(id)
      if (owner && owner !== card.nodeId) shared.add(id)
      else owners.set(id, card.nodeId)
    }
  }
  return { sharedToolNodeIds: [...shared], toolsByCard }
}

function filesOfToolBlock(tool: ConversationToolBlock): readonly string[] {
  if (!tool.mergedReadCount || tool.mergedReadCount < 2) return []
  return tool.tools.map((item) => formatToolVerbPhrase(item.title).replace(/^读了\s+/, ''))
}
