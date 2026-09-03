import type { AgentQuestionValue } from '../../shared/agent-question'

/** 将已填写答案压缩成 Grok 采访可接受的字符串局部答案，保留 0 和 false。 */
export function serializeQuestionPartialAnswers(
  answers: Readonly<Record<string, AgentQuestionValue>>
): Record<string, string> | undefined {
  const partialAnswers: Record<string, string> = {}
  for (const [questionId, value] of Object.entries(answers)) {
    const serialized = Array.isArray(value) ? value.join(', ') : String(value)
    if (serialized.trim()) partialAnswers[questionId] = serialized
  }
  return Object.keys(partialAnswers).length > 0 ? partialAnswers : undefined
}

/** 问答卡按 TUI 约定用普通 Enter 推进；Shift+Enter 和输入法组合仍保留编辑行为。 */
export function shouldAdvanceQuestionOnKeydown(input: {
  key: string
  shiftKey?: boolean
  isComposing?: boolean
  keyCode?: number
}): boolean {
  return (
    input.key === 'Enter' &&
    input.shiftKey !== true &&
    input.isComposing !== true &&
    input.keyCode !== 229
  )
}
