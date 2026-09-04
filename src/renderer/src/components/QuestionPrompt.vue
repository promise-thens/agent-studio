<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type {
  AgentQuestionAnnotation,
  AgentQuestionItem,
  AgentQuestionRequest,
  AgentQuestionResponse,
  AgentQuestionValue
} from '../../../shared/agent-question'
import { cloneAgentQuestionResponse } from '../../../shared/agent-question'
import type { AgentRespondQuestionRequest } from '../../../shared/agent-ipc'
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
  respond: [request: AgentRespondQuestionRequest]
}>()

const currentIndex = ref(0)
const answers = ref<Record<string, AgentQuestionValue>>({})
const otherAnswers = ref<Record<string, string>>({})
const noteAnswers = ref<Record<string, string>>({})
const errorMessage = ref('')
const activeField = ref<HTMLElement | null>(null)
const cardRoot = ref<HTMLElement | null>(null)

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
  // 先拍平成普通对象，避免 ref 深代理数组进入 IPC structured clone。
  const plainAnswers: Record<string, AgentQuestionValue> = JSON.parse(JSON.stringify(answers.value))
  for (const question of props.request.questions) {
    const answer = plainAnswers[question.id]
    const selected = Array.isArray(answer) ? answer : answer === undefined ? [] : [answer]
    const preview = selected
      .map((value) => question.options?.find((option) => option.value === String(value))?.preview)
      .find((value): value is string => Boolean(value))
    const notes = noteAnswers.value[question.id]?.trim()
    if (preview || notes) annotations[question.id] = { ...(preview ? { preview } : {}), ...(notes ? { notes } : {}) }
  }
  return {
    action: 'accept',
    answers: plainAnswers,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {})
  }
}

/** 卡片自己带上公开 questionId；不能依赖 App 队首，避免错卡/旧卡吞掉 accept。 */
function emitRespond(response: AgentQuestionResponse): void {
  const cloned = cloneAgentQuestionResponse(response)
  if (!cloned) {
    console.warn('[ask] cloneAgentQuestionResponse failed; submit blocked', {
      questionId: props.request.questionId,
      action: response?.action
    })
    errorMessage.value = '回答内容无法提交，请重试。'
    return
  }
  emit('respond', {
    questionId: props.request.questionId,
    taskId: props.request.taskId,
    turnId: props.request.turnId,
    response: cloned
  })
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
  emitRespond(buildAcceptResponse())
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
    emitRespond({ action })
    return
  }
  const partialAnswers = buildPartialAnswers()
  emitRespond({ action, ...(partialAnswers ? { partialAnswers } : {}) })
}

/** 计划审阅使用 Grok 原生的 approved/abandoned/cancelled 三态，不伪装成权限审批。 */
function respondPlan(action: 'approve-plan' | 'abandon-plan' | 'cancel'): void {
  if (props.pending) return
  emitRespond({ action })
}

/** 问答卡不是 Timeline 事件；贴底跟随可能停在 Ask 工具行，这里自己滚进可视区。 */
function scrollCardIntoView(): void {
  cardRoot.value?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

async function focusCurrentField(): Promise<void> {
  await nextTick()
  scrollCardIntoView()
  activeField.value?.focus()
}

onMounted(() => {
  void focusCurrentField()
})
</script>

<template>
  <section
    ref="cardRoot"
    class="question-inline-card"
    role="region"
    :aria-labelledby="`${questionId}-title`"
    :aria-busy="pending"
    tabindex="0"
  >
    <header class="question-inline-header">
      <div class="question-inline-heading">
        <p :id="`${questionId}-title`" class="question-inline-title">{{ request.title }}</p>
        <p class="question-inline-message">{{ request.message }}</p>
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
            <small v-if="option.description" class="question-inline-option-description">
              {{ option.description }}
            </small>
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
  /* 问题卡使用现有工作台色板，避免浅色主题下出现白字白底。 */
  display: grid;
  gap: 0;
  margin: 16px 0;
  padding: 18px 20px 16px;
  border: 1px solid color-mix(in srgb, var(--border-strong) 76%, transparent);
  border-radius: var(--radius-panel);
  background: color-mix(in srgb, var(--surface-2) 94%, var(--surface-1));
  box-shadow: 0 18px 44px color-mix(in srgb, var(--surface-0) 42%, transparent);
}

.question-inline-header,
.question-inline-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.question-inline-header {
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.question-inline-heading {
  min-width: 0;
}

.question-inline-actions > button {
  width: auto;
  min-width: 72px;
}

.question-inline-title,
.question-inline-message,
.question-inline-label,
.question-inline-description {
  margin: 0;
}

.question-inline-title {
  color: var(--text-1);
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.35;
}

.question-inline-message {
  margin-top: 5px;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.5;
}

.question-inline-progress {
  flex: 0 0 auto;
  padding: 4px 8px;
  border: 1px solid color-mix(in srgb, var(--border-strong) 70%, transparent);
  border-radius: var(--radius-chip);
  color: var(--text-2);
  background: var(--surface-1);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
}

.question-inline-body {
  display: grid;
  gap: 12px;
  min-width: 0;
}

.question-inline-label {
  color: var(--text-1);
  font-size: 16px;
  font-weight: 700;
  line-height: 1.4;
}

.question-inline-description {
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.5;
}

.question-inline-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 9px;
}

.question-inline-options label,
.question-inline-toggle {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  min-height: 76px;
  padding: 14px 15px;
  border: 1px solid color-mix(in srgb, var(--border) 84%, transparent);
  border-radius: var(--radius-control);
  background: color-mix(in srgb, var(--surface-2) 72%, transparent);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--surface-0) 18%, transparent);
  cursor: pointer;
  transition:
    border-color 140ms ease,
    background-color 140ms ease,
    transform 140ms ease;
}

.question-inline-options label:hover,
.question-inline-toggle:hover {
  border-color: var(--border-strong);
  background: var(--hover-fill);
}

.question-inline-options label:active,
.question-inline-toggle:active {
  transform: translateY(1px);
}

.question-inline-options label:has(input:checked),
.question-inline-toggle:has(input:checked) {
  border-color: color-mix(in srgb, var(--accent) 76%, var(--border-strong));
  background: color-mix(in srgb, var(--accent) 10%, var(--selected-fill));
  box-shadow:
    inset 3px 0 0 var(--accent),
    0 2px 8px color-mix(in srgb, var(--surface-0) 18%, transparent);
}

.question-inline-options input,
.question-inline-toggle input {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin: 2px 0 0;
  accent-color: var(--accent);
}

.question-inline-options span {
  display: grid;
  min-width: 0;
  gap: 5px;
}

.question-inline-options strong {
  color: var(--text-1);
  font-size: 14px;
  line-height: 1.35;
}

.question-inline-options small {
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.question-inline-preview {
  color: var(--text-3) !important;
}

.question-inline-input {
  width: 100%;
  min-height: 40px;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  color: var(--text-1);
  background: var(--surface-1);
  transition:
    border-color 140ms ease,
    background-color 140ms ease,
    box-shadow 140ms ease;
}

.question-inline-input::placeholder {
  color: var(--text-3);
}

.question-inline-input:focus {
  border-color: color-mix(in srgb, var(--accent) 72%, var(--border-strong));
  background: var(--surface-2);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent);
}

.question-inline-textarea {
  resize: vertical;
}

.question-inline-extra {
  display: grid;
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
  gap: 9px;
}

.question-inline-plan {
  max-height: 280px;
  margin: 0;
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text-1);
  background: var(--surface-1);
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

.question-inline-actions {
  flex-wrap: wrap;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
}

.question-inline-actions > button {
  min-height: 34px;
  padding: 0 13px;
}

.question-inline-actions > button:hover:not(:disabled) {
  transform: translateY(-1px);
}

@media (max-width: 640px) {
  .question-inline-card {
    padding: 16px;
  }

  .question-inline-extra {
    grid-template-columns: 1fr;
  }

  .question-inline-spacer {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .question-inline-card * {
    transition: none !important;
  }
}
</style>
