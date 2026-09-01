import type { AgentToolStatus } from '../../shared/agent'
import { formatToolVerbPhrase, type ConversationToolBlock } from './conversation-turn-view'

/** 根卡 + 一层 ToolRow；禁止再套第三层 SubagentCard。 */
export const SUBAGENT_CARD_MAX_DEPTH = 2

/** 诚实停止：没有 child cancel，停的是整场 Turn，不是某一张卡。 */
export const SUBAGENT_STOP_COPY = '停止会结束整场 Turn，不能只停这张卡。'

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
    files: filesOfToolBlock(tool),
    ...(tool.detail ? { detail: tool.detail } : {})
  }))
}

export type SubagentCardStatus = 'running' | 'completed' | 'failed'

export interface SubagentCardExpansionController {
  readonly open: boolean
  applyStatus(status: SubagentCardStatus): void
  applyToggle(nativeOpen: boolean): void
}

/**
 * 未手势时跟随 status === 'running'（完成/失败默认折）。
 * 用户点过 summary 后尊重手势；:open 同步触发的 toggle 不记成手势。
 */
export function createSubagentCardExpansion(
  status: SubagentCardStatus
): SubagentCardExpansionController {
  let open = status === 'running'
  let userOverrode = false
  return {
    get open() {
      return open
    },
    applyStatus(nextStatus) {
      if (userOverrode) return
      open = nextStatus === 'running'
    },
    applyToggle(nativeOpen) {
      if (nativeOpen === open) return
      userOverrode = true
      open = nativeOpen
    }
  }
}

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
