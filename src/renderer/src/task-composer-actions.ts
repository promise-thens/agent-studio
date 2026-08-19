import type { AgentRuntimeId } from '../../shared/agent'
import type {
  TaskExecutionCancellationRequest,
  TaskExecutionDto
} from '../../shared/task-execution'
import type { ConversationRestoreState, TurnModelSnapshot } from '../../shared/task-history'

const TERMINAL_EXECUTION_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const RESTORE_STATES_THAT_CAN_SEND = new Set<ConversationRestoreState>([
  'connecting',
  'degraded',
  'ready',
  'idle'
])

export interface TaskComposerSendInput {
  prompt: string
  selectedTaskId: string
  activeExecution: Pick<TaskExecutionDto, 'taskId' | 'state'> | null
  restore?: ConversationRestoreState | null
  restoreReason?: string
  providerConfigured: boolean
  projectSelectionPending: boolean
  turnTiming: boolean
  promptSubmissionPending: boolean
  promptCapabilityAvailable: boolean
  promptCapabilityMessage?: string
  runtimeConnected: boolean
  projectExecutable?: boolean
  projectExecutionReason?: string
}

export interface TaskComposerSendDecision {
  canSend: boolean
  reason: string
}

export interface TaskHeaderFactsInput {
  selectedTaskId: string
  selectedTitle?: string
  selectedProjectName?: string
  selectedRuntimeId?: AgentRuntimeId | string
  selectedState?: string
  createdAt?: string
  selectedModel?: TurnModelSnapshot | null
  activeExecution: Pick<TaskExecutionDto, 'taskId' | 'model' | 'state'> | null
  runningTaskTitle?: string | null
  restore?: ConversationRestoreState | null
  restoreReason?: string
  runtimeState?: string
  runtimeMessage?: string
  workbenchLoadMessage?: string
}

export interface TaskHeaderFacts {
  title: string
  projectName: string
  runtimeLabel: string
  modelLabel: string
  environmentLabel: string
  worktreeLabel: string
  stateLabel: string
  createdAtLabel: string
  weakStatusLine: string
  viewingForeignExecution: boolean
  runningTaskId: string | null
  modelReadOnly: boolean
}

/** 模型名称必须来自 Provider 真实字段，禁止拼接 Runtime 前缀。 */
export function resolveProviderModelLabel(
  model: Pick<TurnModelSnapshot, 'modelId' | 'displayName'> | null | undefined
): string {
  if (!model?.modelId) return ''
  return model.displayName?.trim() || model.modelId
}

export function resolveRuntimeIdentityLabel(runtimeId?: string): string {
  if (runtimeId === 'grok') return 'Grok Build'
  if (runtimeId === 'codex') return 'Codex'
  return runtimeId ? 'Agent Runtime' : ''
}

/**
 * 外槽占用唯一执行槽时禁止向当前选中 Task 发送。
 * 终态不算占用；selectedTaskId 与 running taskId 相同则允许续写该 Task。
 */
export function isForeignExecutionBlockingSend(
  activeExecution: Pick<TaskExecutionDto, 'taskId' | 'state'> | null,
  selectedTaskId: string
): boolean {
  if (!activeExecution) return false
  if (TERMINAL_EXECUTION_STATES.has(activeExecution.state)) return false
  return activeExecution.taskId !== selectedTaskId
}

/**
 * 停止身份只取 activeExecution，显式忽略 selectedTaskId，避免停错 Task。
 */
export function resolveCancelTurnRequest(
  activeExecution: Pick<TaskExecutionDto, 'executionId' | 'taskId' | 'turnId'> | null,
  selectedTaskId: string
): TaskExecutionCancellationRequest | null {
  void selectedTaskId
  if (!activeExecution) return null
  return {
    executionId: activeExecution.executionId,
    taskId: activeExecution.taskId,
    turnId: activeExecution.turnId
  }
}

/** 有活动执行就显示停止，空闲才显示发送。 */
export function resolveComposerAction(
  activeExecution: Pick<TaskExecutionDto, 'taskId'> | null
): 'send' | 'stop' {
  return activeExecution ? 'stop' : 'send'
}

export function resolveStopButtonTitle(
  activeExecution: Pick<TaskExecutionDto, 'taskId'> | null,
  runningTaskTitle?: string | null
): string {
  if (!activeExecution) return ''
  const title = runningTaskTitle?.trim()
  return title ? `停止 ${title}` : `停止 Task ${activeExecution.taskId}`
}

/** GACP-02：接回中/降级/就绪/空闲都可以打字发送，unavailable 才锁住。 */
export function canSendWhileConversationRestoring(
  restore: ConversationRestoreState | null | undefined
): boolean {
  return Boolean(restore && RESTORE_STATES_THAT_CAN_SEND.has(restore))
}

export function evaluateTaskComposerSend(input: TaskComposerSendInput): TaskComposerSendDecision {
  return {
    canSend:
      !input.projectSelectionPending &&
      input.restore !== 'unavailable' &&
      Boolean(input.providerConfigured) &&
      !isForeignExecutionBlockingSend(input.activeExecution, input.selectedTaskId) &&
      !input.turnTiming &&
      !input.promptSubmissionPending &&
      Boolean(input.prompt.trim()) &&
      input.promptCapabilityAvailable &&
      (input.runtimeConnected || canSendWhileConversationRestoring(input.restore)),
    reason: resolveComposerDisabledMessage(input)
  }
}

/** UI 提示；connecting 只解释状态，不作为发送门禁。 */
export function resolveComposerDisabledMessage(input: TaskComposerSendInput): string {
  if (input.projectSelectionPending) return '正在切换 Project，请稍候。'
  if (input.restore === 'unavailable') {
    return input.restoreReason || input.projectExecutionReason || '当前只能查看历史。'
  }
  if (isForeignExecutionBlockingSend(input.activeExecution, input.selectedTaskId)) {
    return '先停掉当前任务。'
  }
  if (!input.providerConfigured) return '请先配置 Provider。'
  if (input.projectExecutable === false) return input.projectExecutionReason || ''
  if (input.restore === 'connecting') return '正在接回上次上下文…'
  if (!input.runtimeConnected && input.restore !== 'degraded') {
    return '当前查看的 Project 尚未连接 Runtime。'
  }
  return input.promptCapabilityMessage || ''
}

/** 连接中的弱提示不锁发送；失败后把已清空草稿还原。 */
export function restoreComposerPromptAfterFailure(
  currentPrompt: string,
  submittedPrompt: string
): string {
  return currentPrompt.trim() ? currentPrompt : submittedPrompt
}

export function resolveTaskHeaderFacts(input: TaskHeaderFactsInput): TaskHeaderFacts {
  const selected = Boolean(input.selectedTaskId)
  const viewingForeignExecution = isForeignExecutionBlockingSend(
    input.activeExecution,
    input.selectedTaskId
  )
  const modelReadOnly = Boolean(
    input.activeExecution && input.activeExecution.taskId === input.selectedTaskId
  )
  const model = modelReadOnly ? input.activeExecution?.model : input.selectedModel
  const runningTaskId = input.activeExecution?.taskId ?? null
  const runningLabel = input.runningTaskTitle?.trim() || runningTaskId

  return {
    title: selected ? input.selectedTitle?.trim() || '对话' : '选择一个对话',
    projectName: input.selectedProjectName?.trim() || '未选择项目',
    runtimeLabel: resolveRuntimeIdentityLabel(input.selectedRuntimeId),
    modelLabel: resolveProviderModelLabel(model),
    environmentLabel: 'Local',
    worktreeLabel: 'Worktree 尚未接入',
    stateLabel: selected ? input.selectedState || '' : '',
    createdAtLabel: selected ? formatTaskCreatedAt(input.createdAt) : '',
    weakStatusLine: resolveHeaderWeakStatusLine(input, viewingForeignExecution, runningLabel),
    viewingForeignExecution,
    runningTaskId,
    modelReadOnly
  }
}

function resolveHeaderWeakStatusLine(
  input: TaskHeaderFactsInput,
  viewingForeignExecution: boolean,
  runningLabel: string | null
): string {
  if (input.workbenchLoadMessage?.trim()) return input.workbenchLoadMessage.trim()
  if (input.restore === 'connecting') {
    return input.restoreReason?.trim() || '正在接回上次上下文…'
  }
  if (input.restore === 'unavailable') {
    return input.restoreReason?.trim() || '当前只能查看历史'
  }
  if (input.restore === 'degraded') {
    return input.restoreReason?.trim() || '已用新上下文接着聊'
  }
  if (viewingForeignExecution && runningLabel) {
    return `后台正在运行 ${runningLabel}`
  }
  if (input.runtimeState === 'connecting') return '正在连接 Runtime…'
  if (input.runtimeState === 'error') return input.runtimeMessage?.trim() || 'Runtime 连接异常'
  return ''
}

function formatTaskCreatedAt(iso?: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return iso
  return date.toLocaleString()
}
