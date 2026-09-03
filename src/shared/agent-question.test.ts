import { describe, expect, it } from 'vitest'
import { parseAgentQuestionRequest, parseAgentQuestionResponse } from './agent-question'

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

  it('拒绝超长或非字符串的 partialAnswers/feedback', () => {
    expect(
      parseAgentQuestionResponse({ action: 'chat-about-this', partialAnswers: { a: 1 } })
    ).toBeNull()
    expect(
      parseAgentQuestionResponse({ action: 'approve-plan', feedback: 'x'.repeat(4097) })
    ).toBeNull()
  })
})
