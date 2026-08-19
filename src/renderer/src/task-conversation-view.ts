import type {
  TaskTimelineViewModel,
  TimelineErrorNode,
  TimelineTextNode,
  TurnTimelineViewModel
} from './task-timeline-reducer'

const ACTIVE_TURN_STATES = new Set(['queued', 'running', 'waiting-permission', 'cancelling'])
const CONVERSATION_PIN_THRESHOLD_PX = 80

export function isConversationPinnedToBottom(
  element: Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'scrollHeight'>,
  thresholdPx = CONVERSATION_PIN_THRESHOLD_PX
): boolean {
  return element.scrollTop + element.clientHeight >= element.scrollHeight - thresholdPx
}

export function isActiveConversationTurn(turn: Pick<TurnTimelineViewModel, 'status'>): boolean {
  return ACTIVE_TURN_STATES.has(turn.status)
}

/** 历史轮默认收起过程；只有活动 Turn 自动展开，避免长内容淹没对话。 */
export function isTurnProcessExpandedByDefault(
  turn: Pick<TurnTimelineViewModel, 'status'>
): boolean {
  return isActiveConversationTurn(turn)
}

export function turnHasCollapsibleProcess(turn: Pick<TurnTimelineViewModel, 'nodes'>): boolean {
  return turn.nodes.some((node) => node.kind !== 'user-prompt' && node.kind !== 'message')
}

export function collectTurnAssistantTexts(turn: Pick<TurnTimelineViewModel, 'nodes'>): string[] {
  return turn.nodes
    .filter((node): node is TimelineTextNode => node.kind === 'message')
    .map((node) => node.text)
    .filter((text) => text.trim())
}

export function collectTurnErrorMessages(turn: Pick<TurnTimelineViewModel, 'nodes'>): string[] {
  return turn.nodes
    .filter((node): node is TimelineErrorNode => node.kind === 'error')
    .map((node) => node.message)
    .filter((text) => text.trim())
}

/** 对话流按 Turn 切片时间线，历史回放与实时更新共用同一模型。 */
export function timelineModelForTurn(
  model: TaskTimelineViewModel,
  turn: TurnTimelineViewModel
): TaskTimelineViewModel {
  return {
    ...model,
    turns: [turn]
  }
}

export function latestActiveTurnId(turns: readonly TurnTimelineViewModel[]): string | null {
  const active = [...turns].reverse().find((turn) => isActiveConversationTurn(turn))
  return active?.turnId ?? turns.at(-1)?.turnId ?? null
}
