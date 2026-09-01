import type { AgentPlanEntry } from '../../shared/agent'
import type { ComposerPlanMode } from '../../shared/session-plan-mode'
import type { TaskTimelineViewModel, TimelinePlanNode } from './task-timeline-reducer'

/** 主列 / 清单共用空态；禁止改写成 Timeline 事件或编造 ACP 条目。 */
export const PLAN_EMPTY_COPY = 'Grok 还没给出计划'

function planNodesOf(
  model: Pick<TaskTimelineViewModel, 'turns'> | null | undefined
): TimelinePlanNode[] {
  if (!model) return []
  const nodes: TimelinePlanNode[] = []
  for (const turn of model.turns) {
    for (const node of turn.nodes) {
      if (node.kind === 'plan') nodes.push(node)
    }
  }
  return nodes
}

/**
 * Plan 模式且对话里还没有 plan 节点时，主列给空态。
 * 已有 plan 节点（含空表）交给清单，避免和 Timeline 快照叠两句。
 * 首屏加载中不抢「正在加载对话…」。
 */
export function resolveConversationPlanEmptyCopy(input: {
  planMode: ComposerPlanMode
  model: Pick<TaskTimelineViewModel, 'turns'> | null | undefined
  loading?: boolean
}): string {
  if (input.loading && !input.model?.turns.length) return ''
  if (input.planMode !== 'plan') return ''
  if (planNodesOf(input.model).length > 0) return ''
  return PLAN_EMPTY_COPY
}

/**
 * Timeline 推来空 entries 时用同一句空态，避免空白 ol。
 * 不编造 content / status；有条目则交回 PlanChecklist。
 */
export function resolvePlanChecklistEmptyCopy(entries: readonly AgentPlanEntry[]): string {
  return entries.length === 0 ? PLAN_EMPTY_COPY : ''
}
