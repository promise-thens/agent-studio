import type {
  PublicAgentEvent,
  PublicAgentMessageEvent,
  PublicAgentThoughtEvent,
  PublicAgentToolEvent
} from '../../shared/agent-event'

interface AgentTurnEventProgress {
  lastSequence: number
  terminal: boolean
}

/**
 * Renderer 按 taskId + turnId 记录已消费的最大 sequence，并在首个终态后锁定当前 Turn。
 * 这里只拒绝重复和晚到事件，不要求 sequence 无缺口，避免 IPC 丢帧后永久阻塞后续输出。
 */
export function createAgentEventGuard(): (event: PublicAgentEvent) => boolean {
  const turnProgress = new Map<string, AgentTurnEventProgress>()

  return (event) => {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) return false

    // 稳定 Task 可以连续执行多个 Turn，终态只能关闭它所属的那一轮。
    const turnKey = `${event.taskId}:${event.turnId}`
    const current = turnProgress.get(turnKey)
    if (current?.terminal || event.sequence <= (current?.lastSequence ?? 0)) return false

    turnProgress.set(turnKey, {
      lastSequence: event.sequence,
      terminal: event.kind === 'turn-complete'
    })
    return true
  }
}

/** 同一 Turn 的消息流保持稳定 key，不同任务、轮次、消息与思考流彼此隔离。 */
export function createAgentMessageKey(
  event: PublicAgentMessageEvent | PublicAgentThoughtEvent
): string {
  const streamId = event.messageId == null ? 'stream' : `id:${event.messageId}`
  return `${event.taskId}:${event.turnId}:${event.kind}:${streamId}`
}

/** tool-call 与 tool-update 使用同一个 Turn 级 key，避免跨轮次复用 toolCallId 时误合并。 */
export function createAgentToolKey(event: PublicAgentToolEvent): string {
  return `${event.taskId}:${event.turnId}:tool:${event.toolCallId}`
}
