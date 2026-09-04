import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  serializeQuestionPartialAnswers,
  shouldAdvanceQuestionOnKeydown
} from './question-prompt-actions'

const questionPromptSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'components/QuestionPrompt.vue'),
  'utf8'
)

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

  it('问答卡出现时滚进可视区，避免停在 Ask 工具行下面', () => {
    expect(questionPromptSource).toContain('scrollIntoView')
    expect(questionPromptSource).toContain("block: 'nearest'")
  })

  it('提交时带上卡片自身的 questionId/taskId/turnId，不依赖队首猜测', () => {
    expect(questionPromptSource).toContain('function emitRespond')
    expect(questionPromptSource).toContain('questionId: props.request.questionId')
    expect(questionPromptSource).toContain('cloneAgentQuestionResponse')
    expect(questionPromptSource).toContain('JSON.parse(JSON.stringify(answers.value))')
  })
})
