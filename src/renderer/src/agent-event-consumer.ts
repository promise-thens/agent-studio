import type {
  AgentEvent,
  AgentMessageEvent,
  AgentThoughtEvent,
  AgentToolEvent
} from '../../shared/agent'

interface AgentTaskEventProgress {
  lastSequence: number
  terminal: boolean
}

/**
 * Renderer 按 taskId 记录已消费的最大 sequence，并在首个终态后锁定该任务。
 * 这里只拒绝重复和晚到事件，不要求 sequence 无缺口，避免 IPC 丢帧后永久阻塞后续输出。
 */
export function createAgentEventGuard(): (event: AgentEvent) => boolean {
  const taskProgress = new Map<string, AgentTaskEventProgress>()

  return (event) => {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) return false

    const current = taskProgress.get(event.taskId)
    if (current?.terminal || event.sequence <= (current?.lastSequence ?? 0)) return false

    taskProgress.set(event.taskId, {
      lastSequence: event.sequence,
      terminal: event.kind === 'turn-complete'
    })
    return true
  }
}

/** 同一任务的消息流保持稳定 key，不同任务、消息与思考流彼此隔离。 */
export function createAgentMessageKey(event: AgentMessageEvent | AgentThoughtEvent): string {
  const streamId = event.messageId == null ? 'stream' : `id:${event.messageId}`
  return `${event.taskId}:${event.kind}:${streamId}`
}

/** tool-call 与 tool-update 使用同一个任务级 key，确保更新落到同一条工具活动。 */
export function createAgentToolKey(event: AgentToolEvent): string {
  return `${event.taskId}:tool:${event.toolCallId}`
}
