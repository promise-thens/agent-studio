/** 问答卡支持的字段值；只允许可序列化的基础类型，避免把 Runtime 原对象带过 IPC。 */
export type AgentQuestionValue = string | number | boolean | string[]

export type AgentQuestionKind = 'single' | 'multi' | 'text' | 'number' | 'boolean'

/** Grok 问答卡的运行语境；只有 plan 才显示采访专属动作。 */
export type AgentQuestionMode = 'default' | 'plan'

/** 问答卡的业务形态；计划审阅与普通采访共用安全的 IPC 外壳。 */
export type AgentQuestionRequestKind = 'questions' | 'plan-approval'

export interface AgentQuestionOption {
  value: string
  label: string
  description?: string
  /** Grok 单选聚焦时展示的预览片段；只允许安全的纯文本。 */
  preview?: string
}

/** 一道需要用户回答的问题，字段结构由 ACP elicitation 或 Grok 私有问答投影而来。 */
export interface AgentQuestionItem {
  id: string
  question: string
  kind: AgentQuestionKind
  options?: AgentQuestionOption[]
  required?: boolean
  description?: string
  defaultValue?: AgentQuestionValue
  /** Grok 工具会为每题提供可填写的 Other 入口。 */
  allowOther?: boolean
}

/** 用户选择 Other 或带预览选项时回传给 Runtime 的附注。 */
export interface AgentQuestionAnnotation {
  preview?: string
  notes?: string
}

/** Renderer 公开的阻塞式问答请求，不包含 Runtime sessionId 或原始协议字段。 */
export interface AgentQuestionRequest {
  /** 主进程生成的公开身份，不是 Runtime 的原始 requestId。 */
  questionId: string
  runtimeId: 'grok' | 'codex'
  taskId: string
  turnId: string
  title: string
  message: string
  kind?: AgentQuestionRequestKind
  /** Grok `ask_user_question` 的 mode；ACP elicitation 缺省时不携带。 */
  mode?: AgentQuestionMode
  /** 计划审阅正文只作为展示文本，不能被 Renderer 当作可执行指令。 */
  planContent?: string
  questions: AgentQuestionItem[]
  canSkip: boolean
}

export type AgentQuestionResponse =
  | {
      action: 'accept'
      answers: Record<string, AgentQuestionValue>
      annotations?: Record<string, AgentQuestionAnnotation>
    }
  | { action: 'chat-about-this'; partialAnswers?: Record<string, string> }
  | { action: 'skip'; partialAnswers?: Record<string, string> }
  | { action: 'cancel' }
  | { action: 'approve-plan'; feedback?: string }
  | { action: 'abandon-plan'; feedback?: string }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** 主进程和 Preload 共用的窄校验，拒绝未知字段和过大的问答载荷。 */
export function parseAgentQuestionRequest(value: unknown): AgentQuestionRequest | null {
  if (!isPlainRecord(value)) return null
  const text = (input: unknown, allowEmpty = false): string | null =>
    typeof input === 'string' && (allowEmpty || input.trim()) && !input.includes('\0') && input.length <= 4096
      ? input
      : null
  const questionId = text(value.questionId)
  const taskId = text(value.taskId)
  const turnId = text(value.turnId)
  const title = text(value.title, true)
  const message = text(value.message, true)
  const kind = value.kind === undefined ? 'questions' : value.kind
  const mode = value.mode === undefined ? undefined : value.mode
  const planContent = text(value.planContent, true)
  if (
    !questionId ||
    !taskId ||
    !turnId ||
    title === null ||
    message === null ||
    (kind !== 'questions' && kind !== 'plan-approval') ||
    (mode !== undefined && mode !== 'default' && mode !== 'plan') ||
    (value.planContent !== undefined && planContent === null) ||
    (value.runtimeId !== 'grok' && value.runtimeId !== 'codex') ||
    value.canSkip !== true && value.canSkip !== false ||
    !Array.isArray(value.questions) ||
    value.questions.length === 0 ||
    value.questions.length > 20
  ) {
    return null
  }

  const questions: AgentQuestionItem[] = []
  for (const raw of value.questions) {
    if (!isPlainRecord(raw)) return null
    const id = text(raw.id)
    const question = text(raw.question)
    const kind = raw.kind
    if (
      !id ||
      !question ||
      !['single', 'multi', 'text', 'number', 'boolean'].includes(kind as string)
    ) {
      return null
    }
    const item: AgentQuestionItem = {
      id,
      question,
      kind: kind as AgentQuestionKind,
      required: raw.required === true,
      ...(text(raw.description, true) !== null ? { description: text(raw.description, true)! } : {}),
      ...(raw.allowOther === true ? { allowOther: true } : {})
    }
    if (Array.isArray(raw.options)) {
      if (raw.options.length > 50) return null
      const options: AgentQuestionOption[] = []
      for (const option of raw.options) {
        if (!isPlainRecord(option)) return null
        const optionValue = text(option.value)
        const label = text(option.label)
        if (!optionValue || !label) return null
        options.push({
          value: optionValue,
          label,
          ...(text(option.description, true) !== null
            ? { description: text(option.description, true)! }
            : {}),
          ...(text(option.preview, true) !== null ? { preview: text(option.preview, true)! } : {})
        })
      }
      item.options = options
    }
    questions.push(item)
  }

  return {
    questionId,
    runtimeId: value.runtimeId,
    taskId,
    turnId,
    title,
    message,
    ...(kind !== 'questions' ? { kind } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(planContent !== null ? { planContent } : {}),
    questions,
    canSkip: value.canSkip
  }
}

/** 回答从 Renderer 回到主进程前只接受公开身份和基础值。 */
export function parseAgentQuestionResponse(value: unknown): AgentQuestionResponse | null {
  if (!isPlainRecord(value)) return null
  if (value.action === 'cancel' || value.action === 'approve-plan' || value.action === 'abandon-plan') {
    const feedback = value.feedback
    if (
      feedback !== undefined &&
      (typeof feedback !== 'string' || feedback.length > 4096 || feedback.includes('\0'))
    ) {
      return null
    }
    return {
      action: value.action,
      ...(typeof feedback === 'string' && feedback.trim() ? { feedback: feedback.trim() } : {})
    }
  }
  if (value.action === 'skip' || value.action === 'chat-about-this') {
    const partialAnswers = value.partialAnswers
    if (partialAnswers === undefined) return { action: value.action }
    if (!isPlainRecord(partialAnswers)) return null
    const projected: Record<string, string> = {}
    for (const [key, answer] of Object.entries(partialAnswers)) {
      if (!key || key.length > 4096 || typeof answer !== 'string' || answer.length > 4096) {
        return null
      }
      projected[key] = answer
    }
    return { action: value.action, partialAnswers: projected }
  }
  if (value.action !== 'accept' || !isPlainRecord(value.answers)) return null
  const answers: Record<string, AgentQuestionValue> = {}
  for (const [key, answer] of Object.entries(value.answers)) {
    if (!key || key.length > 4096) return null
    if (
      typeof answer === 'string' ||
      typeof answer === 'number' ||
      typeof answer === 'boolean' ||
      (Array.isArray(answer) && answer.every((item) => typeof item === 'string'))
    ) {
      answers[key] = answer as AgentQuestionValue
    } else {
      return null
    }
  }
  const rawAnnotations = value.annotations
  if (rawAnnotations !== undefined) {
    if (!isPlainRecord(rawAnnotations)) return null
    const annotations: Record<string, AgentQuestionAnnotation> = {}
    for (const [key, rawAnnotation] of Object.entries(rawAnnotations)) {
      if (!key || key.length > 4096 || !isPlainRecord(rawAnnotation)) return null
      const preview = rawAnnotation.preview
      const notes = rawAnnotation.notes
      if (
        (preview !== undefined &&
          (typeof preview !== 'string' || preview.length > 4096 || preview.includes('\0'))) ||
        (notes !== undefined &&
          (typeof notes !== 'string' || notes.length > 4096 || notes.includes('\0')))
      ) {
        return null
      }
      if (typeof preview !== 'string' && typeof notes !== 'string') return null
      annotations[key] = {
        ...(typeof preview === 'string' && preview.trim() ? { preview: preview.trim() } : {}),
        ...(typeof notes === 'string' && notes.trim() ? { notes: notes.trim() } : {})
      }
    }
    return Object.keys(annotations).length > 0 ? { action: 'accept', answers, annotations } : { action: 'accept', answers }
  }
  return { action: 'accept', answers }
}
