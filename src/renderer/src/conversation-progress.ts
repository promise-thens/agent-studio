import type { TaskTimelineNode, TurnTimelineViewModel } from './task-timeline-reducer'

/** 超过该时间没有新事件时只提示“等待 Runtime”，不擅自判定执行失败。 */
export const CONVERSATION_EVENT_SILENCE_MS = 8_000

function timestampMs(value?: string): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 将毫秒格式化为稳定的时长文案，供运行中和历史 Turn 共用。 */
export function formatConversationDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0)
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** 以 dispatch 为优先起点，历史缺失时回退到 Turn 创建时间。 */
export function turnStartedAtMs(
  turn: Pick<TurnTimelineViewModel, 'createdAt' | 'dispatchedAt'>
): number | undefined {
  return timestampMs(turn.dispatchedAt) ?? timestampMs(turn.createdAt)
}

/** 计算整轮实际耗时；终态冻结，活动态随 clockTick 增长。 */
export function conversationTurnDurationMs(
  turn: Pick<TurnTimelineViewModel, 'createdAt' | 'dispatchedAt' | 'endedAt'>,
  nowMs: number
): number | undefined {
  const started = turnStartedAtMs(turn)
  if (started == null) return undefined
  const ended = timestampMs(turn.endedAt) ?? nowMs
  return Math.max(0, ended - started)
}

/** 返回最近可信活动时间；没有事件时回退到 dispatch/创建时间，不伪造事件类型。 */
export function turnLastActivityAt(
  turn: Pick<TurnTimelineViewModel, 'createdAt' | 'dispatchedAt' | 'lastEventAt'>
): number | undefined {
  return (
    timestampMs(turn.lastEventAt) ?? timestampMs(turn.dispatchedAt) ?? timestampMs(turn.createdAt)
  )
}

/** 将最近活动时间翻译成简洁相对文案，避免用户盯着 ISO 时间戳。 */
export function formatConversationActivityAge(
  lastActivityMs: number | undefined,
  nowMs: number
): string {
  if (lastActivityMs == null) return '最近事件未知'
  const seconds = Math.max(0, Math.floor((nowMs - lastActivityMs) / 1000))
  if (seconds < 2) return '刚刚更新'
  if (seconds < 60) return `${seconds} 秒前更新`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前更新`
  return `${Math.floor(minutes / 60)} 小时前更新`
}

/** 仅对运行中的 Turn 给出中性等待提示，终态永远不显示“可能卡住”。 */
export function isConversationWaitingForEvent(
  turn: Pick<TurnTimelineViewModel, 'status' | 'createdAt' | 'dispatchedAt' | 'lastEventAt'>,
  nowMs: number,
  silenceMs = CONVERSATION_EVENT_SILENCE_MS
): boolean {
  if (turn.status !== 'running') return false
  const lastActivity = turnLastActivityAt(turn)
  return lastActivity != null && nowMs - lastActivity >= silenceMs
}

export function conversationStatusLabel(status: TurnTimelineViewModel['status']): string {
  switch (status) {
    case 'queued':
      return '排队中'
    case 'running':
      return '正在运行'
    case 'waiting-permission':
      return '等待你的确认'
    case 'cancelling':
      return '正在停止'
    case 'completed':
      return '已完成'
    case 'failed':
      return '执行失败'
    case 'cancelled':
      return '已取消'
    case 'interrupted':
      return '已中断'
    default:
      return '等待执行'
  }
}

/** 从已投影节点中找出用户真正关心的“当前在做什么”。 */
export function resolveConversationStep(nodes: readonly TaskTimelineNode[]): string {
  for (const node of [...nodes].reverse()) {
    if (node.kind === 'tool') return node.title || '执行工具'
    if (node.kind === 'agent-group') return node.title || '执行子任务'
    if (node.kind === 'plan') {
      const completed = node.entries.filter((entry) => entry.status === 'completed').length
      return `执行计划 · ${completed}/${node.entries.length}`
    }
    if (node.kind === 'thought' && node.text.trim()) return '思考中'
    if (node.kind === 'permission-audit') return '记录权限决定'
    if (node.kind === 'error') return '处理错误'
    if (node.kind === 'message' && node.text.trim()) return '生成回复'
  }
  return '准备执行'
}
