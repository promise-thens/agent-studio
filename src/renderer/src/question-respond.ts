import type { AgentRespondQuestionRequest } from '../../shared/agent-ipc'
import type { AgentQuestionRequest } from '../../shared/agent-question'

export type QuestionRespondGateResult =
  | { ok: true; warnQueueMiss: boolean }
  | { ok: false; error: string }

/**
 * 卡片 submit 的闸门：只要 event 自带公开身份就允许打到 Main。
 * 队列 miss 只告警，不能吞掉——否则 sticky/HMR/turn 清理竞态会造成无 ext-out。
 */
export function gateQuestionRespond(input: {
  event: AgentRespondQuestionRequest
  queued: Pick<AgentQuestionRequest, 'questionId' | 'taskId' | 'turnId'> | null
  respondingQuestionId: string | null
}): QuestionRespondGateResult {
  const { event, queued, respondingQuestionId } = input
  if (!event.questionId || !event.taskId || !event.turnId || !event.response) {
    return { ok: false, error: '问答回答不完整，请重试。' }
  }
  if (queued && (queued.taskId !== event.taskId || queued.turnId !== event.turnId)) {
    return { ok: false, error: '问答身份不匹配，请重试。' }
  }
  if (respondingQuestionId) {
    return { ok: false, error: '已有问答提交在途，请稍候。' }
  }
  return { ok: true, warnQueueMiss: queued === null }
}

/** 组装发给 preload/Main 的公开身份载荷；不依赖队首。 */
export function buildQuestionRespondIpcPayload(
  event: AgentRespondQuestionRequest
): AgentRespondQuestionRequest {
  return {
    questionId: event.questionId,
    taskId: event.taskId,
    turnId: event.turnId,
    response: event.response
  }
}
