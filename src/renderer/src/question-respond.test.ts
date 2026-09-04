import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildQuestionRespondIpcPayload,
  gateQuestionRespond
} from './question-respond'

const appSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'App.vue'), 'utf8')
const conversationTurnSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'components/ConversationTurn.vue'),
  'utf8'
)
const taskConversationSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'components/TaskConversation.vue'),
  'utf8'
)

const baseEvent = {
  questionId: 'q-1',
  taskId: 'task-1',
  turnId: 'turn-1',
  response: { action: 'accept' as const, answers: { a: '前端' } }
}

describe('gateQuestionRespond', () => {
  it('队列 miss 时仍放行，并标记 warnQueueMiss', () => {
    expect(
      gateQuestionRespond({
        event: baseEvent,
        queued: null,
        respondingQuestionId: null
      })
    ).toEqual({ ok: true, warnQueueMiss: true })
  })

  it('队列命中且身份一致时放行', () => {
    expect(
      gateQuestionRespond({
        event: baseEvent,
        queued: { questionId: 'q-1', taskId: 'task-1', turnId: 'turn-1' },
        respondingQuestionId: null
      })
    ).toEqual({ ok: true, warnQueueMiss: false })
  })

  it('队列命中但 task/turn 不一致时拒绝', () => {
    expect(
      gateQuestionRespond({
        event: baseEvent,
        queued: { questionId: 'q-1', taskId: 'task-other', turnId: 'turn-1' },
        respondingQuestionId: null
      })
    ).toEqual({ ok: false, error: '问答身份不匹配，请重试。' })
  })

  it('缺少公开身份或 response 时拒绝', () => {
    expect(
      gateQuestionRespond({
        event: { ...baseEvent, questionId: '' },
        queued: null,
        respondingQuestionId: null
      })
    ).toEqual({ ok: false, error: '问答回答不完整，请重试。' })
  })

  it('已有提交在途时拒绝，不再静默吞掉', () => {
    expect(
      gateQuestionRespond({
        event: baseEvent,
        queued: { questionId: 'q-1', taskId: 'task-1', turnId: 'turn-1' },
        respondingQuestionId: 'q-other'
      })
    ).toEqual({ ok: false, error: '已有问答提交在途，请稍候。' })
  })

  it('IPC 载荷始终取自 event，不依赖队首', () => {
    expect(buildQuestionRespondIpcPayload(baseEvent)).toEqual(baseEvent)
  })
})

describe('App/Conversation 问答提交契约', () => {
  it('App 用 gateQuestionRespond，队列 miss 也转发 event 身份', () => {
    expect(appSource).toContain('gateQuestionRespond')
    expect(appSource).toContain('buildQuestionRespondIpcPayload')
    expect(appSource).toContain('warnQueueMiss')
    expect(appSource).not.toContain("appendMessage('error', '问答请求已失效。')")
    expect(appSource).toContain('await window.agent.respondQuestion(')
  })

  it('ConversationTurn 与 TaskConversation 转发 AgentRespondQuestionRequest', () => {
    expect(conversationTurnSource).toContain('AgentRespondQuestionRequest')
    expect(conversationTurnSource).toContain(
      'respondQuestion: [request: AgentRespondQuestionRequest]'
    )
    expect(conversationTurnSource).toContain("@respond=\"$emit('respondQuestion', $event)\"")
    expect(taskConversationSource).toContain('AgentRespondQuestionRequest')
    expect(taskConversationSource).toContain(
      'respondQuestion: [request: AgentRespondQuestionRequest]'
    )
    expect(taskConversationSource).toContain("@respond=\"$emit('respondQuestion', $event)\"")
    expect(taskConversationSource).toContain(
      "@respond-question=\"$emit('respondQuestion', $event)\""
    )
  })
})
