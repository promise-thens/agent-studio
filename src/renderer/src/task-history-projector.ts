import type { AgentPlanEntry, AgentToolStatus } from '../../shared/agent'
import type { PersistedAgentEvent, TurnHistoryRecord } from '../../shared/task-history'

export interface ProjectedChatMessage {
  id: string
  turnId?: string
  role: 'user' | 'assistant' | 'thought' | 'error'
  text: string
  streaming?: boolean
}

export interface ProjectedToolActivity {
  id: string
  title: string
  status: AgentToolStatus | 'unknown'
}

export interface TaskHistoryProjection {
  messages: ProjectedChatMessage[]
  planEntries: AgentPlanEntry[]
  toolActivities: ProjectedToolActivity[]
}

export function createTaskHistoryProjection(): TaskHistoryProjection {
  return { messages: [], planEntries: [], toolActivities: [] }
}

/** 实时与历史事件共用同一纯投影，避免重启回放出现另一套 UI 语义。 */
export function applyDisplayEvent(
  projection: TaskHistoryProjection,
  event: PersistedAgentEvent
): TaskHistoryProjection {
  if (event.kind === 'agent-message' || event.kind === 'agent-thought') {
    const role = event.kind === 'agent-message' ? 'assistant' : 'thought'
    const id = `${event.taskId}:${event.turnId}:${event.kind}:${event.messageId ?? 'stream'}`
    const current = projection.messages.at(-1)
    if (current?.id === id && current.role === role) current.text += event.text
    else projection.messages.push({ id, turnId: event.turnId, role, text: event.text })
  } else if (event.kind === 'error') {
    projection.messages.push({
      id: `${event.taskId}:${event.turnId}:error:${event.sequence}`,
      turnId: event.turnId,
      role: 'error',
      text: event.message
    })
  } else if (event.kind === 'plan') {
    projection.planEntries = event.entries.map((entry) => ({ ...entry }))
  } else if (event.kind === 'tool-call' || event.kind === 'tool-update') {
    const id = `${event.taskId}:${event.turnId}:tool:${event.toolCallId}`
    const existing = projection.toolActivities.find((tool) => tool.id === id)
    if (existing) {
      if (event.title) existing.title = event.title
      if (event.status) existing.status = event.status
    } else {
      projection.toolActivities.push({
        id,
        title: event.title ?? event.toolCallId,
        status: event.status ?? 'unknown'
      })
    }
  }
  return projection
}

/** Turn 按时间升序、事件按 sequence 升序回放，sequence 每个 Turn 从 1 独立开始。 */
export function projectTaskHistory(
  turns: TurnHistoryRecord[],
  eventsByTurn: Record<string, PersistedAgentEvent[]>
): TaskHistoryProjection {
  const projection = createTaskHistoryProjection()
  for (const turn of [...turns].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  )) {
    projection.messages.push({
      id: `${turn.taskId}:${turn.turnId}:user`,
      turnId: turn.turnId,
      role: 'user',
      text: turn.promptDisplayText
    })
    for (const event of [...(eventsByTurn[turn.turnId] ?? [])].sort(
      (left, right) => left.sequence - right.sequence
    )) {
      applyDisplayEvent(projection, event)
    }
  }
  return projection
}
