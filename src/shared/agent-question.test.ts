import { describe, expect, it } from 'vitest'
import {
  cloneAgentQuestionResponse,
  parseAgentQuestionRequest,
  parseAgentQuestionResponse
} from './agent-question'

describe('Agent 问答 DTO', () => {
  it('接受计划审阅卡的公开字段，并拒绝隐藏 Runtime 身份', () => {
    expect(
      parseAgentQuestionRequest({
        questionId: 'question-1',
        runtimeId: 'grok',
        taskId: 'task-1',
        turnId: 'turn-1',
        title: '提交计划',
        message: '请审阅',
        kind: 'plan-approval',
        planContent: '1. 修改设置页',
        questions: [
          {
            id: 'plan-review',
            question: '是否继续？',
            kind: 'single',
            options: [{ value: 'approve', label: '批准' }],
            required: true
          }
        ],
        canSkip: false,
        runtimeSessionId: 'must-not-cross-ipc'
      })
    ).toMatchObject({ kind: 'plan-approval', planContent: '1. 修改设置页' })
  })

  it('保留 Grok 问答的聊天/跳过分支和计划审阅三态', () => {
    expect(parseAgentQuestionResponse({ action: 'chat-about-this' })).toEqual({
      action: 'chat-about-this'
    })
    expect(parseAgentQuestionResponse({ action: 'skip', partialAnswers: { a: 'b' } })).toEqual({
      action: 'skip',
      partialAnswers: { a: 'b' }
    })
    expect(parseAgentQuestionResponse({ action: 'approve-plan' })).toEqual({
      action: 'approve-plan'
    })
    expect(parseAgentQuestionResponse({ action: 'abandon-plan', feedback: '先讨论' })).toEqual({
      action: 'abandon-plan',
      feedback: '先讨论'
    })
  })

  it('接受 Grok ask_user_question 投影后的默认采访卡', () => {
    expect(
      parseAgentQuestionRequest({
        questionId: '8f1c2d3e-4a5b-6789-abcd-ef0123456789',
        runtimeId: 'grok',
        taskId: 'task-1',
        turnId: 'turn-2',
        title: 'Grok Build 需要你的回答',
        message: '请确认下面的问题后继续。',
        mode: 'default',
        questions: [
          {
            id: 'question-1',
            question: '你现在最想先解决哪一件事?',
            kind: 'single',
            options: [
              { value: '改代码', label: '改代码', description: '修改现有实现' },
              { value: '查 bug', label: '查 bug', description: '定位失败原因' }
            ],
            required: true,
            allowOther: true
          }
        ],
        canSkip: false
      })
    ).toMatchObject({
      mode: 'default',
      questions: [{ id: 'question-1', kind: 'single', allowOther: true }]
    })
  })

  it('拒绝超长或非字符串的 partialAnswers/feedback', () => {
    expect(
      parseAgentQuestionResponse({ action: 'chat-about-this', partialAnswers: { a: 1 } })
    ).toBeNull()
    expect(
      parseAgentQuestionResponse({ action: 'approve-plan', feedback: 'x'.repeat(4097) })
    ).toBeNull()
  })

  it('cloneAgentQuestionResponse 去掉不可克隆结构并保留 accept 答案', () => {
    expect(
      cloneAgentQuestionResponse({
        action: 'accept',
        answers: { 'question-1': '改代码', features: ['计划', '问答'] },
        annotations: { 'question-1': { notes: '先改这里' } }
      })
    ).toEqual({
      action: 'accept',
      answers: { 'question-1': '改代码', features: ['计划', '问答'] },
      annotations: { 'question-1': { notes: '先改这里' } }
    })
    expect(cloneAgentQuestionResponse({ action: 'accept' })).toBeNull()
  })

  it('cloneAgentQuestionResponse 可剥离 Proxy 风格对象，供 IPC 结构化克隆', () => {
    const proxy = new Proxy(
      { action: 'accept' as const, answers: { 'question-1': '前端' } },
      {
        get(target, prop, receiver) {
          return Reflect.get(target, prop, receiver)
        }
      }
    )
    expect(cloneAgentQuestionResponse(proxy)).toEqual({
      action: 'accept',
      answers: { 'question-1': '前端' }
    })
    const circular: Record<string, unknown> = { action: 'accept', answers: {} }
    circular.self = circular
    expect(cloneAgentQuestionResponse(circular)).toBeNull()
    expect(cloneAgentQuestionResponse({ action: 'not-a-real-action' })).toBeNull()
  })

})
