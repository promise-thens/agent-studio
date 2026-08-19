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

/** 贴底时跟到最新输出底部；用户上翻则返回 null，禁止改 scrollTop。 */
export function nextPinnedConversationScrollTop(
  element: Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'scrollHeight'>,
  pinned: boolean
): number | null {
  if (!pinned) return null
  return Math.max(0, element.scrollHeight - element.clientHeight)
}

export type ConversationPinSource = 'user-input' | 'layout-scroll'

/**
 * 用户滚轮/触控/拖条永远以当前位置为准。
 * 内容增高或程序化贴底触发的 layout scroll 不得把贴底误判成上翻，也不得吞掉下一次用户滚动。
 */
export function nextConversationPinnedState(input: {
  pinned: boolean
  source: ConversationPinSource
  nearBottom: boolean
}): boolean {
  if (input.source === 'user-input') return input.nearBottom
  return input.pinned
}

function nodeFollowLength(node: TurnTimelineViewModel['nodes'][number]): number {
  if ('text' in node && typeof node.text === 'string') return node.text.length
  if ('message' in node && typeof node.message === 'string') return node.message.length
  return 0
}

/** 包含同一节点正文变长，避免流式更新因 nodes.length 不变而不跟随。 */
export function conversationFollowSignature(
  model: TaskTimelineViewModel | null,
  localErrors: readonly string[] = []
): string {
  if (!model?.turns.length) return `empty:${localErrors.join('\0')}`
  const last = model.turns.at(-1)
  const nodeSignature = last
    ? last.nodes.map((node) => `${node.nodeId}:${node.kind}:${nodeFollowLength(node)}`).join('|')
    : ''
  return [
    model.taskId,
    model.turns.length,
    last?.turnId ?? '',
    last?.status ?? '',
    nodeSignature,
    localErrors.join('\0')
  ].join('::')
}

/** 实时 Agent error 已进入 Timeline，不得再镜像到 Composer 本地条。 */
export function shouldMirrorLiveAgentErrorLocally(): boolean {
  return false
}

export function collectLocalComposerErrors(
  messages: readonly { role: string; text: string }[],
  timelineErrorTexts: readonly string[]
): string[] {
  const seen = new Set(timelineErrorTexts.filter((text) => text.trim()))
  return messages
    .filter((item) => item.role === 'error' && item.text.trim() && !seen.has(item.text))
    .map((item) => item.text)
    .slice(-3)
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
