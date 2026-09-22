import type { TaskTimelineViewModel } from './task-timeline-reducer'
import { projectInspectorTimelineSummary } from './task-inspector'

export interface InspectorTurnItem {
  turnId: string
  title: string
  statusLabel: string
  active: boolean
  tools: { nodeId: string; title: string; status: string }[]
}

/** 仅投影当前任务的既有时间线，导航引用保持原始 turnId，不维护第二份执行状态。 */
export function projectInspectorTurns(
  timeline: Pick<TaskTimelineViewModel, 'turns'> | null | undefined
): InspectorTurnItem[] {
  return (timeline?.turns ?? []).map((turn, index) => ({
    turnId: turn.turnId,
    title: turn.prompt.trim() || `第 ${index + 1} 轮`,
    statusLabel: projectInspectorTimelineSummary({ turns: [turn] }).statusLabel,
    active: ['pending', 'queued', 'running', 'waiting-permission', 'cancelling'].includes(
      turn.status
    ),
    tools: turn.nodes.flatMap((node) => {
      if (node.kind === 'tool') {
        return [{ nodeId: node.nodeId, title: node.title, status: node.status }]
      }
      if (node.kind === 'agent-group') {
        return [node, ...node.children].map((tool) => ({
          nodeId: tool.nodeId,
          title: tool.title,
          status: tool.status
        }))
      }
      return []
    })
  }))
}
