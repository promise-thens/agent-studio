import { describe, expect, it } from 'vitest'
import {
  serializeQuestionPartialAnswers,
  shouldAdvanceQuestionOnKeydown
} from './question-prompt-actions'

describe('QuestionPrompt 交互动作', () => {
  it('序列化已填写的局部答案并保留 0、false 和多选值', () => {
    expect(
      serializeQuestionPartialAnswers({
        scope: '前端',
        count: 0,
        enabled: false,
        features: ['计划', '问答'],
        empty: '  '
      })
    ).toEqual({
      scope: '前端',
      count: '0',
      enabled: 'false',
      features: '计划, 问答'
    })
    expect(serializeQuestionPartialAnswers({})).toBeUndefined()
  })

  it('普通 Enter 推进，Shift+Enter 和输入法组合不提交', () => {
    expect(shouldAdvanceQuestionOnKeydown({ key: 'Enter' })).toBe(true)
    expect(shouldAdvanceQuestionOnKeydown({ key: 'Enter', shiftKey: true })).toBe(false)
    expect(shouldAdvanceQuestionOnKeydown({ key: 'Enter', isComposing: true })).toBe(false)
    expect(shouldAdvanceQuestionOnKeydown({ key: 'Enter', keyCode: 229 })).toBe(false)
    expect(shouldAdvanceQuestionOnKeydown({ key: 'a' })).toBe(false)
  })
})
