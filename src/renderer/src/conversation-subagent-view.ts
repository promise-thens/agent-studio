import type { AgentToolStatus } from '../../shared/agent'
import { formatToolVerbPhrase, type ConversationToolBlock } from './conversation-turn-view'

export interface ConversationSubagentMountBlock {
  kind: string
}

export interface SubagentToolRowView {
  key: string
  label: string
  status: AgentToolStatus | 'unknown'
  files: readonly string[]
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
}

export interface SubagentToolOwnership {
  sharedToolNodeIds: string[]
  toolsByCard: Record<string, string[]>
}

/**
 * 主列只在投影真的给出 subagent 块时挂载卡片。
 * GACP-01 未见父子字段，禁止用标题猜树，因此通常不会走到 true。
 */
export function shouldMountSubagentCard(
  block: ConversationSubagentMountBlock | null | undefined
): boolean {
  return block?.kind === 'subagent'
}

export function subagentStatusLabel(status: 'running' | 'completed' | 'failed'): string {
  if (status === 'running') return '进行中'
  if (status === 'failed') return '失败'
  return '完成'
}

/** 折叠态第二行：计数 + 点开提示，不要再写 Tool · in_progress。 */
export function formatSubagentCountLine(toolCount: number): string {
  return `已运行 ${toolCount} 个工具 · 点开查看`
}

export function toSubagentToolRows(tools: readonly ConversationToolBlock[]): SubagentToolRowView[] {
  return tools.map((tool) => ({
    key: tool.nodeId,
    label: tool.label,
    status: tool.status,
    files: filesOfToolBlock(tool)
  }))
}

export function toSubagentCardView(block: {
  name: string
  status: 'running' | 'completed' | 'failed'
  tools: readonly ConversationToolBlock[]
}): SubagentCardView {
  return {
    name: block.name,
    status: block.status,
    statusLabel: subagentStatusLabel(block.status),
    countLine: formatSubagentCountLine(block.tools.length),
    defaultExpanded: block.status === 'running',
    errorInParentMessage: false,
    tools: toSubagentToolRows(block.tools)
  }
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
