<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type {
  AgentQuestionAnnotation,
  AgentQuestionItem,
  AgentQuestionRequest,
  AgentQuestionResponse,
  AgentQuestionValue
} from '../../../shared/agent-question'
import {
  serializeQuestionPartialAnswers,
  shouldAdvanceQuestionOnKeydown
} from '../question-prompt-actions'

const props = withDefaults(
  defineProps<{
    request: AgentQuestionRequest
    pending?: boolean
  }>(),
  { pending: false }
)

const emit = defineEmits<{
  respond: [response: AgentQuestionResponse]
}>()

const currentIndex = ref(0)
const answers = ref<Record<string, AgentQuestionValue>>({})
const otherAnswers = ref<Record<string, string>>({})
const noteAnswers = ref<Record<string, string>>({})
const errorMessage = ref('')
const activeField = ref<HTMLElement | null>(null)

const currentQuestion = computed<AgentQuestionItem | null>(
  () => props.request.questions[currentIndex.value] ?? null
)
const isPlanApproval = computed(() => props.request.kind === 'plan-approval')
const isPlanInterview = computed(() => props.request.mode === 'plan')
const progressLabel = computed(() => `${currentIndex.value + 1} / ${props.request.questions.length}`)
const isLastQuestion = computed(() => currentIndex.value === props.request.questions.length - 1)
const currentAnswer = computed(() => {
  const question = currentQuestion.value
  return question ? answers.value[question.id] : undefined
})
const questionId = computed(() => `question-${props.request.questionId}-${currentIndex.value}`)

watch(
  () => props.request.questionId,
  () => {
    currentIndex.value = 0
    answers.value = {}
    otherAnswers.value = {}
    noteAnswers.value = {}
    errorMessage.value = ''
    void focusCurrentField()
  },
  { immediate: true }
)

function setAnswer(value: AgentQuestionValue): void {
  const question = currentQuestion.value
  if (!question) return
  answers.value = { ...answers.value, [question.id]: value }
  errorMessage.value = ''
}

function isAnswered(question: AgentQuestionItem): boolean {
  const value = answers.value[question.id]
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

function validateCurrent(): boolean {
  const question = currentQuestion.value
  if (!question || question.required === false || isAnswered(question)) return true
  errorMessage.value = '请先回答这个问题。'
  return false
}

function toggleMultiOption(value: string): void {
  const current = Array.isArray(currentAnswer.value) ? currentAnswer.value : []
  setAnswer(current.includes(value) ? current.filter((item) => item !== value) : [...current, value])
}

/** Grok 选项题始终允许 Other；Other 文本按答案值回传，避免只能点预设选项。 */
function setOtherAnswer(rawValue: string): void {
  const question = currentQuestion.value
  if (!question) return
  const previousValue = otherAnswers.value[question.id]
  const value = rawValue.slice(0, 4096)
  otherAnswers.value = { ...otherAnswers.value, [question.id]: value }
  if (question.kind === 'multi') {
    const selected = Array.isArray(currentAnswer.value) ? currentAnswer.value : []
    const withoutOther = selected.filter((item) => item !== previousValue)
    setAnswer(value ? [...withoutOther, value] : withoutOther)
  } else if (value) {
    setAnswer(value)
  } else {
    const next = { ...answers.value }
    delete next[question.id]
    answers.value = next
  }
}

function setNoteAnswer(rawValue: string): void {
  const question = currentQuestion.value
  if (!question) return
  noteAnswers.value = { ...noteAnswers.value, [question.id]: rawValue.slice(0, 4096) }
}

function buildAcceptResponse(): AgentQuestionResponse {
  const annotations: Record<string, AgentQuestionAnnotation> = {}
  for (const question of props.request.questions) {
    const answer = answers.value[question.id]
    const selected = Array.isArray(answer) ? answer : answer === undefined ? [] : [answer]
    const preview = selected
      .map((value) => question.options?.find((option) => option.value === String(value))?.preview)
      .find((value): value is string => Boolean(value))
    const notes = noteAnswers.value[question.id]?.trim()
    if (preview || notes) annotations[question.id] = { ...(preview ? { preview } : {}), ...(notes ? { notes } : {}) }
  }
  return {
    action: 'accept',
    answers: { ...answers.value },
    ...(Object.keys(annotations).length > 0 ? { annotations } : {})
  }
}

/** 文本题遵循 Grok 问答卡快捷键，把已填写的答案交给“聊聊/跳过”分支继续使用。 */
function buildPartialAnswers(): Record<string, string> | undefined {
  return serializeQuestionPartialAnswers(answers.value)
}

/** 数字输入清空时删除答案，避免空值被 Number('') 误转为 0。 */
function setNumberAnswer(rawValue: string): void {
  if (!rawValue.trim()) {
    const question = currentQuestion.value
    if (!question) return
    const next = { ...answers.value }
    delete next[question.id]
    answers.value = next
    errorMessage.value = ''
    return
  }
  const value = Number(rawValue)
  if (Number.isFinite(value)) setAnswer(value)
}

function goPrevious(): void {
  if (props.pending || currentIndex.value === 0) return
  currentIndex.value -= 1
  errorMessage.value = ''
  void focusCurrentField()
}

function goNext(): void {
  if (props.pending || !validateCurrent()) return
  if (!isLastQuestion.value) {
    currentIndex.value += 1
    errorMessage.value = ''
    void focusCurrentField()
    return
  }
  emit('respond', buildAcceptResponse())
}

/** 普通 Enter 进入下一题；Shift+Enter、输入法组合和 keyCode=229 继续编辑。 */
function handleQuestionKeydown(event: KeyboardEvent): void {
  if (
    !shouldAdvanceQuestionOnKeydown({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.isComposing,
      keyCode: event.keyCode
    })
  ) {
    return
  }
  event.preventDefault()
  goNext()
}

function respond(action: 'chat-about-this' | 'skip' | 'cancel'): void {
  if (props.pending) return
  if (action === 'cancel') {
    emit('respond', { action })
    return
  }
  const partialAnswers = buildPartialAnswers()
  emit('respond', { action, ...(partialAnswers ? { partialAnswers } : {}) })
}

/** 计划审阅使用 Grok 原生的 approved/abandoned/cancelled 三态，不伪装成权限审批。 */
function respondPlan(action: 'approve-plan' | 'abandon-plan' | 'cancel'): void {
  if (props.pending) return
  emit('respond', { action })
}

async function focusCurrentField(): Promise<void> {
  await nextTick()
  activeField.value?.focus()
}
</script>

<template>
  <section
    class="question-inline-card"
    role="region"
    :aria-labelledby="`${questionId}-title`"
    :aria-busy="pending"
    tabindex="0"
  >
    <header class="question-inline-header">
      <div>
        <p :id="`${questionId}-title`" class="question-inline-title">{{ request.title }}</p>
        <p class="question-inline-message">{{ request.message }}</p>
        <p class="question-inline-source">来自 Task {{ request.taskId }}</p>
      </div>
      <span class="question-inline-progress" aria-label="问题进度">{{ progressLabel }}</span>
    </header>

    <div v-if="isPlanApproval" class="question-inline-body">
      <pre v-if="request.planContent" class="question-inline-plan">{{ request.planContent }}</pre>
      <p v-else class="question-inline-description">Runtime 未附带计划正文，请确认是否继续。</p>
    </div>

    <div v-else-if="currentQuestion" class="question-inline-body">
      <p class="question-inline-label">{{ currentQuestion.question }}</p>
      <p v-if="currentQuestion.description" class="question-inline-description">
        {{ currentQuestion.description }}
      </p>

      <div v-if="currentQuestion.kind === 'single'" class="question-inline-options">
        <label v-for="(option, optionIndex) in currentQuestion.options ?? []" :key="option.value">
          <input
            :ref="optionIndex === 0 ? (element) => (activeField = element as HTMLElement) : undefined"
            type="radio"
            :name="questionId"
            :value="option.value"
            :checked="currentAnswer === option.value"
            :disabled="pending"
            @change="setAnswer(option.value)"
          />
          <span>
            <strong>{{ option.label }}</strong>
        <small v-if="option.description">{{ option.description }}</small>
        <small v-if="option.preview" class="question-inline-preview">{{ option.preview }}</small>
          </span>
        </label>
      </div>

      <div v-else-if="currentQuestion.kind === 'multi'" class="question-inline-options">
        <label v-for="(option, optionIndex) in currentQuestion.options ?? []" :key="option.value">
          <input
            :ref="optionIndex === 0 ? (element) => (activeField = element as HTMLElement) : undefined"
            type="checkbox"
            :checked="Array.isArray(currentAnswer) && currentAnswer.includes(option.value)"
            :disabled="pending"
            @change="toggleMultiOption(option.value)"
          />
          <span>
            <strong>{{ option.label }}</strong>
            <small v-if="option.description">{{ option.description }}</small>
            <small v-if="option.preview" class="question-inline-preview">{{ option.preview }}</small>
          </span>
        </label>
      </div>

      <input
        v-else-if="currentQuestion.kind === 'number'"
        ref="activeField"
        class="question-inline-input"
        type="number"
        :value="typeof currentAnswer === 'number' ? currentAnswer : ''"
        :disabled="pending"
        @input="setNumberAnswer(($event.target as HTMLInputElement).value)"
        @keydown="handleQuestionKeydown"
      />

      <label v-else-if="currentQuestion.kind === 'boolean'" class="question-inline-toggle">
        <input
          ref="activeField"
          type="checkbox"
          :checked="currentAnswer === true"
          :disabled="pending"
          @change="setAnswer(($event.target as HTMLInputElement).checked)"
        />
        <span>是</span>
      </label>

      <textarea
        v-else
        ref="activeField"
        class="question-inline-input question-inline-textarea"
        rows="3"
        :value="typeof currentAnswer === 'string' ? currentAnswer : ''"
        :disabled="pending"
        @input="setAnswer(($event.target as HTMLTextAreaElement).value)"
        @keydown="handleQuestionKeydown"
      />
      <div v-if="currentQuestion.allowOther" class="question-inline-extra">
        <input
          v-if="(currentQuestion.options?.length ?? 0) > 0"
          class="question-inline-input question-inline-other"
          type="text"
          :value="otherAnswers[currentQuestion.id] ?? ''"
          placeholder="其他（可选，直接输入）"
          :disabled="pending"
          @input="setOtherAnswer(($event.target as HTMLInputElement).value)"
        />
        <textarea
          class="question-inline-input question-inline-notes"
          rows="2"
          :value="noteAnswers[currentQuestion.id] ?? ''"
          placeholder="补充说明（可选）"
          :disabled="pending"
          @input="setNoteAnswer(($event.target as HTMLTextAreaElement).value)"
        />
      </div>
      <p v-if="errorMessage" class="question-inline-error" role="alert">{{ errorMessage }}</p>
    </div>

    <footer class="question-inline-actions">
      <template v-if="isPlanApproval">
        <button class="secondary-button" type="button" :disabled="pending" @click="respondPlan('cancel')">
          取消
        </button>
        <button class="secondary-button" type="button" :disabled="pending" @click="respondPlan('abandon-plan')">
          放弃计划
        </button>
      </template>
      <template v-else>
        <button class="secondary-button" type="button" :disabled="pending" @click="respond('cancel')">
          取消
        </button>
        <button
          v-if="isPlanInterview && request.canSkip"
          class="secondary-button"
          type="button"
          :disabled="pending"
          @click="respond('skip')"
        >
          跳过采访
        </button>
        <button
          v-if="isPlanInterview"
          class="secondary-button"
          type="button"
          :disabled="pending"
          @click="respond('chat-about-this')"
        >
          聊聊这个
        </button>
      </template>
      <span class="question-inline-spacer" />
      <template v-if="isPlanApproval">
        <button class="primary-button" type="button" :disabled="pending" @click="respondPlan('approve-plan')">
          {{ pending ? '正在提交…' : '批准并继续' }}
        </button>
      </template>
      <template v-else>
        <button class="secondary-button" type="button" :disabled="pending || currentIndex === 0" @click="goPrevious">
          上一题
        </button>
        <button class="primary-button" type="button" :disabled="pending" @click="goNext">
          {{ pending ? '正在提交…' : isLastQuestion ? '提交回答' : '下一题' }}
        </button>
      </template>
    </footer>
  </section>
</template>

<style scoped>
.question-inline-card {
  margin: 12px 0;
  padding: 16px;
  border: 1px solid var(--border-strong, rgba(255, 255, 255, 0.16));
  border-radius: 14px;
  background: var(--surface-raised, rgba(255, 255, 255, 0.045));
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.16);
}

.question-inline-header,
.question-inline-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.question-inline-actions > button {
  width: auto;
  min-width: 72px;
}

.question-inline-header {
  justify-content: space-between;
  margin-bottom: 14px;
}

.question-inline-title,
.question-inline-message,
.question-inline-label,
.question-inline-description,
.question-inline-source {
  margin: 0;
}

.question-inline-title {
  font-weight: 650;
}

.question-inline-message,
.question-inline-description,
.question-inline-progress {
  color: var(--text-muted, rgba(255, 255, 255, 0.62));
  font-size: 12px;
}

.question-inline-source {
  max-width: 42ch;
  margin-top: 4px;
  overflow: hidden;
  color: var(--text-muted, rgba(255, 255, 255, 0.48));
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.question-inline-label {
  margin-bottom: 6px;
  font-weight: 600;
}

.question-inline-description {
  margin-bottom: 10px;
}

.question-inline-options {
  display: grid;
  gap: 8px;
}

.question-inline-options label,
.question-inline-toggle {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 9px 10px;
  border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
  border-radius: 10px;
  cursor: pointer;
}

.question-inline-options label:has(input:checked),
.question-inline-toggle:has(input:checked) {
  border-color: var(--accent, #d6ff5f);
  background: color-mix(in srgb, var(--accent, #d6ff5f) 10%, transparent);
}

.question-inline-options span {
  display: grid;
  gap: 2px;
}

.question-inline-options small {
  color: var(--text-muted, rgba(255, 255, 255, 0.62));
}

.question-inline-input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 10px;
  border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
  border-radius: 9px;
  color: inherit;
  background: var(--surface-input, rgba(0, 0, 0, 0.2));
}

.question-inline-textarea {
  resize: vertical;
}

.question-inline-plan {
  max-height: 280px;
  margin: 0;
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
  border-radius: 10px;
  color: var(--text-1, rgba(255, 255, 255, 0.9));
  background: var(--surface-input, rgba(0, 0, 0, 0.2));
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
}

.question-inline-error {
  margin: 8px 0 0;
  color: var(--danger, #ff8c8c);
  font-size: 12px;
}

.question-inline-spacer {
  flex: 1;
}

@media (prefers-reduced-motion: reduce) {
  .question-inline-card * {
    transition: none !important;
  }
}
</style>
