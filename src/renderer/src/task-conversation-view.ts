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

export type ConversationScrollInteraction =
  'wheel' | 'touchmove' | 'pointerdown' | 'pointerup' | 'scroll' | 'pending-idle'

export interface ConversationScrollIntent {
  pendingUserScroll: boolean
  pointerTracking: boolean
}

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

/**
 * wheel/touchmove 预告下一次 scroll；pointerdown 只跟踪拖条，避免 click/选中把 pending 卡住。
 * 已预告但没有产生 scroll 时必须走 pending-idle 清掉，否则贴底跟随会提前 return 冻住。
 */
export function nextConversationScrollIntent(
  intent: ConversationScrollIntent,
  interaction: ConversationScrollInteraction
): ConversationScrollIntent {
  switch (interaction) {
    case 'wheel':
    case 'touchmove':
      return { pendingUserScroll: true, pointerTracking: intent.pointerTracking }
    case 'pointerdown':
      return { pendingUserScroll: intent.pendingUserScroll, pointerTracking: true }
    case 'pointerup':
      return { pendingUserScroll: intent.pendingUserScroll, pointerTracking: false }
    case 'scroll':
    case 'pending-idle':
      return { pendingUserScroll: false, pointerTracking: intent.pointerTracking }
  }
}

/** 用户手势尚未落到 scroll，或拖条按住时，禁止程序化贴底抢位置。 */
export function shouldHoldPinnedFollow(intent: ConversationScrollIntent): boolean {
  return intent.pendingUserScroll || intent.pointerTracking
}

/**
 * wheel/touchmove 时 scrollTop 往往还没变，只能把下一次 scroll 标成用户输入。
 * 程序化贴底触发的 scroll 才是 layout；键盘翻页没有前置 pointer，也按用户输入。
 */
export function resolveConversationScrollSource(input: {
  pendingUserScroll: boolean
  programmaticFollow: boolean
}): ConversationPinSource {
  if (input.pendingUserScroll) return 'user-input'
  if (input.programmaticFollow) return 'layout-scroll'
  return 'user-input'
}

/**
 * 贴底写入后是否保持 programmaticFollow。
 * 已在底部或赋值未位移时浏览器不发 scroll，不得把后续键盘翻页当成 layout-scroll。
 */
export function nextProgrammaticFollowFlag(input: {
  previousTop: number
  nextTop: number
  assignedTop: number
}): boolean {
  if (input.previousTop === input.nextTop) return false
  if (input.assignedTop === input.previousTop) return false
  return true
}

function nodeFollowLength(node: TurnTimelineViewModel['nodes'][number]): number {
  if ('text' in node && typeof node.text === 'string') return node.text.length
  if ('message' in node && typeof node.message === 'string') return node.message.length
  if (node.kind === 'plan')
    return node.entries.reduce(
      (total, entry) => total + entry.content.length + entry.status.length,
      0
    )
  if (node.kind === 'tool') return node.title.length + node.status.length
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

/** 空状态只给一句短提示；输入框仍在底，不要插画墙。 */
export const CONVERSATION_EMPTY_COPY = '问一件事'

export function resolveConversationEmptyCopy(hasTurns: boolean): string {
  return hasTurns ? '' : CONVERSATION_EMPTY_COPY
}

export interface ConversationConnectFailure {
  message: string
  canRetry: boolean
  retryLabel: string
}

export interface ConversationConnectFailureInput {
  runtimeState: string
  runtimeMessage?: string
  providerConfigured?: boolean
  hasActiveExecution?: boolean
  localErrors?: readonly string[]
}

/**
 * 连接失败进对话流短错误行，页眉不放「连接 Grok」主按钮。
 * 同一条 Runtime 文案若已在 localErrors，只补重试，避免双行。
 */
export function resolveConversationConnectFailure(
  input: ConversationConnectFailureInput
): ConversationConnectFailure | null {
  if (!input.providerConfigured || input.hasActiveExecution) return null
  if (input.runtimeState !== 'error') return null
  const message = input.runtimeMessage?.trim() || 'Runtime 连接异常'
  const alreadyShown = (input.localErrors ?? []).includes(message)
  return {
    message: alreadyShown ? '' : message,
    canRetry: true,
    retryLabel: '重试'
  }
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
