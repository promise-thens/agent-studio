import type { AgentContextUsage, AgentRuntimeId, AgentUsage } from '../../shared/agent'
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
  /** 有 draft 附件时允许空正文发送。 */
  hasAttachments?: boolean
  selectedTaskId: string
  activeExecution: Pick<TaskExecutionDto, 'taskId' | 'state'> | null
  restore?: ConversationRestoreState | null
  restoreReason?: string
  providerConfigured: boolean
  projectSelectionPending: boolean
  /** Project 连接与新 Task 创建尚未完成时，按钮必须等真实身份稳定后再发送。 */
  projectConnectionPending?: boolean
  taskCreationPending?: boolean
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
  providerConfigured?: boolean
}

export type HeaderExecutionScope = 'none' | 'selected' | 'foreign'

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
  runtimeState: string
  executionScope: HeaderExecutionScope
  canRetryConnect: boolean
  viewingForeignExecution: boolean
  runningTaskId: string | null
  modelReadOnly: boolean
}

/** 主路径页眉只留标题和弱状态；facts 仍可供测试/后台逻辑读取。 */
export interface TaskHeaderMainPath {
  title: string
  weakStatusLine: string
  runtimeState: string
  executionScope: HeaderExecutionScope
  canRetryConnect: boolean
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

/** 小窗保底宽度：模型、批准模式、Plan 和发送/停止不得 `display:none`。 */
export const COMPOSER_COMPACT_MIN_WIDTH_PX = 980
export const COMPOSER_COMPACT_ALWAYS_VISIBLE = [
  'model',
  'permission-mode',
  'plan',
  'send-or-stop'
] as const

export type ComposerAddMenuNavigationKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'

/** 为添加菜单计算下一个可聚焦项；上下方向循环，Home/End 直达边界。 */
export function resolveComposerAddMenuFocusIndex(
  key: ComposerAddMenuNavigationKey,
  currentIndex: number,
  itemCount: number
): number | null {
  if (!Number.isInteger(itemCount) || itemCount <= 0) return null
  if (key === 'Home') return 0
  if (key === 'End') return itemCount - 1
  if (currentIndex < 0 || currentIndex >= itemCount) {
    return key === 'ArrowUp' ? itemCount - 1 : 0
  }
  return key === 'ArrowDown'
    ? (currentIndex + 1) % itemCount
    : (currentIndex - 1 + itemCount) % itemCount
}

export interface ComposerChrome {
  action: 'send' | 'stop'
  modelBusy: boolean
  textareaVisible: true
  keepVisibleAtCompactWidth: typeof COMPOSER_COMPACT_ALWAYS_VISIBLE
}

/** 有活动执行就显示停止，空闲才显示发送。 */
export function resolveComposerAction(
  activeExecution: Pick<TaskExecutionDto, 'taskId'> | null
): 'send' | 'stop' {
  return activeExecution ? 'stop' : 'send'
}

/**
 * 输入框自包含动作：空闲发送、执行中停止；执行中模型 busy；输入框始终保留。
 */
export function resolveComposerChrome(input: {
  activeExecution: Pick<TaskExecutionDto, 'taskId'> | null
  projectInteractionBlocked?: boolean
}): ComposerChrome {
  return {
    action: resolveComposerAction(input.activeExecution),
    modelBusy: Boolean(input.activeExecution) || Boolean(input.projectInteractionBlocked),
    textareaVisible: true,
    keepVisibleAtCompactWidth: COMPOSER_COMPACT_ALWAYS_VISIBLE
  }
}

/** 极小字只画上下文 used/limit；turn usage 或 NaN 都藏起来。 */
export function resolveComposerContextUsage(
  usage:
    (Pick<AgentUsage, 'scope'> & { usedTokens?: number; limitTokens?: number }) | null | undefined
): string | null {
  if (!usage || usage.scope !== 'context') return null
  if (!Number.isFinite(usage.usedTokens) || !Number.isFinite(usage.limitTokens)) return null
  return `${usage.usedTokens}/${usage.limitTokens}`
}

export interface ComposerContextUsagePresentation {
  /** 原始 used/limit，供 title 与测试对照。 */
  label: string
  /** Composer 常驻展示的紧凑用量，例如 24.3k / 500k。 */
  compactLabel: string
  /** 仅圆环夹紧到 100；null 表示无法确定占比，不是真实零。 */
  percentage: number | null
  percentLabel: string
  title: string
  ariaLabel: string
  usedLabel: string
  limitLabel: string
  sourceLabel: string
  /** 卡片主标题（对齐图3），如「14% 已用（剩余 86%）」或「0.6% 已用（剩余 99.4%）」。 */
  cardHeadline: string
  /** 卡片副明细（对齐图3），如「已用 35k 标记，共 258k」。 */
  cardTokenDetail: string
}

/** 把 token 数收成 Composer 能放下的短标签，不改真实 used/limit。 */
export function formatContextUsageCount(value: number, peerLimit = 0): string {
  if (!Number.isFinite(value) || value < 0) return peerLimit >= 1000 ? '0k' : '0'
  const amount = Math.round(value)
  if (amount === 0 && peerLimit >= 1000) return '0k'
  if (amount < 1000) return String(amount)
  if (amount < 1_000_000) {
    const thousands = amount / 1000
    if (thousands >= 100) return `${Math.round(thousands)}k`
    return `${thousands.toFixed(1).replace(/\.0$/, '')}k`
  }
  const millions = amount / 1_000_000
  if (millions >= 10) return `${Math.round(millions)}M`
  return `${millions.toFixed(1).replace(/\.0$/, '')}M`
}

/** 圆环空间有限；真实正数不足 1% 时显示 `<1`，避免四舍五入冒充 0。 */
export function formatComposerContextUsageRingLabel(percentage: number | null): string {
  if (percentage === null || !Number.isFinite(percentage)) return '?'
  if (percentage > 0 && percentage < 1) return '<1'
  return String(Math.round(percentage))
}

/** 只投影 Runtime 上下文样本；缺失上限不能推导占比，详情保留超限事实。 */
export function resolveComposerContextUsagePresentation(
  usage: AgentContextUsage | null | undefined
): ComposerContextUsagePresentation {
  const used =
    usage?.scope === 'context' && Number.isFinite(usage.usedTokens) && usage.usedTokens >= 0
      ? usage.usedTokens
      : null
  const limit =
    usage?.scope === 'context' && Number.isFinite(usage.limitTokens) && usage.limitTokens > 0
      ? usage.limitTokens
      : null
  const ratio = used !== null && limit !== null ? (used / limit) * 100 : null
  const percent = ratio !== null && Number.isFinite(ratio) ? Math.round(ratio * 10) / 10 : null
  const percentLabel = percent === null ? '未知' : `${percent}%`
  const usedLabel = used === null ? '未提供' : String(used)
  const limitLabel = limit === null ? '未提供有效上限' : String(limit)
  const label = used === null && limit === null ? '未知' : `${usedLabel}/${limitLabel}`

  // 计算卡片主标题与标记明细（对标图3精美卡片视觉）
  let cardHeadline = '用量统计中...'
  let cardTokenDetail = '容量尚未同步'

  if (percent !== null) {
    if (percent > 100) {
      cardHeadline = `${percentLabel} 已用（已超限）`
    } else {
      const remainingPercent = Math.max(0, Math.round((100 - percent) * 10) / 10)
      cardHeadline = `${percentLabel} 已用（剩余 ${remainingPercent}%）`
    }
  }

  if (used !== null && limit !== null) {
    const usedCompact = formatContextUsageCount(used, limit)
    const limitCompact = formatContextUsageCount(limit)
    cardTokenDetail = `已用 ${usedCompact} 标记，共 ${limitCompact}`
  } else if (used !== null) {
    cardTokenDetail = `已用 ${formatContextUsageCount(used)} 标记`
  }

  return {
    label,
    compactLabel:
      used === null || limit === null
        ? '未知'
        : `${formatContextUsageCount(used, limit)} / ${formatContextUsageCount(limit)}`,
    percentage: percent === null ? null : Math.min(100, percent),
    percentLabel,
    title: `上下文用量：${label} tokens（${percentLabel}）`,
    ariaLabel: `上下文已使用 ${usedLabel} / ${limitLabel} tokens，占 ${percentLabel}`,
    usedLabel,
    limitLabel,
    sourceLabel: usage
      ? 'Runtime · usage(scope=context) 最近可信样本，非实时计费统计'
      : 'Runtime 尚未提供上下文用量',
    cardHeadline,
    cardTokenDetail
  }
}

/**
 * 首轮的记忆基线同样占用上下文，不清零、不累计，也不跨 Task 缓存。
 * 较早轮次只提供最近已知值，明确说明并非当前轮实时采样。
 */
export function presentComposerContextUsage(
  timeline:
    | {
        turns: readonly {
          status?: string
          usage: { contextSamples: readonly AgentContextUsage[] }
        }[]
      }
    | null
    | undefined
): ComposerContextUsagePresentation | null {
  if (!timeline?.turns.length) return null
  const usage = pickLatestContextUsage(timeline)
  const presentation = resolveComposerContextUsagePresentation(usage)
  if (usage && !timeline.turns.at(-1)?.usage.contextSamples.includes(usage)) {
    presentation.sourceLabel = 'Runtime · 较早轮次的最近可信样本，当前轮尚未更新'
  }
  return presentation
}

/** 从最近一轮往前找最后一条可展示的上下文用量。 */
export function pickLatestContextUsage(
  timeline:
    | { turns: readonly { usage: { contextSamples: readonly AgentContextUsage[] } }[] }
    | null
    | undefined
): AgentContextUsage | null {
  if (!timeline?.turns.length) return null
  for (let index = timeline.turns.length - 1; index >= 0; index -= 1) {
    const samples = timeline.turns[index]?.usage.contextSamples ?? []
    for (let sampleIndex = samples.length - 1; sampleIndex >= 0; sampleIndex -= 1) {
      const sample = samples[sampleIndex]
      if (
        sample.scope === 'context' &&
        Number.isFinite(sample.usedTokens) &&
        sample.usedTokens >= 0 &&
        Number.isFinite(sample.limitTokens) &&
        sample.limitTokens >= 0
      ) {
        return sample
      }
    }
  }
  return null
}

/** 停止按钮 title 永远带 running taskId，避免停错当前选中而非正在跑的 Task。 */
export function resolveStopButtonTitle(
  activeExecution: Pick<TaskExecutionDto, 'taskId'> | null
): string {
  if (!activeExecution) return ''
  return `停止 Task ${activeExecution.taskId}`
}

/** 可读标题只进 aria-label，不替代 taskId 身份。 */
export function resolveStopButtonAriaLabel(
  activeExecution: Pick<TaskExecutionDto, 'taskId'> | null,
  runningTaskTitle?: string | null
): string {
  if (!activeExecution) return ''
  const title = runningTaskTitle?.trim()
  return title ? `停止 ${title}` : resolveStopButtonTitle(activeExecution)
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
      !input.projectConnectionPending &&
      !input.taskCreationPending &&
      input.restore !== 'unavailable' &&
      Boolean(input.providerConfigured) &&
      !isForeignExecutionBlockingSend(input.activeExecution, input.selectedTaskId) &&
      !input.turnTiming &&
      !input.promptSubmissionPending &&
      (Boolean(input.prompt.trim()) || Boolean(input.hasAttachments)) &&
      input.promptCapabilityAvailable &&
      (input.runtimeConnected || canSendWhileConversationRestoring(input.restore)),
    reason: resolveComposerDisabledMessage(input)
  }
}

/** UI 提示；connecting 只解释状态，不作为发送门禁。 */
export function resolveComposerDisabledMessage(input: TaskComposerSendInput): string {
  if (input.projectSelectionPending) return '正在切换 Project，请稍候。'
  if (input.projectConnectionPending) return '正在准备项目，请稍候。'
  if (input.taskCreationPending) return '正在创建对话，请稍候。'
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
  const executionScope: HeaderExecutionScope = viewingForeignExecution
    ? 'foreign'
    : input.activeExecution
      ? 'selected'
      : 'none'
  const runtimeState = input.runtimeState || 'idle'
  const canRetryConnect = Boolean(
    input.providerConfigured &&
    !input.activeExecution &&
    (runtimeState === 'idle' || runtimeState === 'error')
  )

  return {
    title: selected ? input.selectedTitle?.trim() || '对话' : '选择一个对话',
    projectName: input.selectedProjectName?.trim() || '未选择项目',
    runtimeLabel: resolveRuntimeIdentityLabel(input.selectedRuntimeId),
    modelLabel: resolveProviderModelLabel(model),
    environmentLabel: 'Local',
    worktreeLabel: 'Worktree 尚未接入',
    stateLabel: selected ? input.selectedState || '' : '',
    createdAtLabel: selected ? formatTaskCreatedAt(input.createdAt) : '',
    weakStatusLine: resolveHeaderWeakStatusLine(
      input,
      viewingForeignExecution,
      runningLabel,
      executionScope
    ),
    runtimeState,
    executionScope,
    canRetryConnect,
    viewingForeignExecution,
    runningTaskId,
    modelReadOnly
  }
}

/** Project/Runtime/环境不再作为主路径运维芯片；侧栏已能表达项目身份。 */
export function shouldShowTaskHeaderFacts(): boolean {
  return false
}

/** 从完整 facts 抽出页眉主路径字段，避免模板误把运维丛当必显。 */
export function resolveTaskHeaderMainPath(facts: TaskHeaderFacts): TaskHeaderMainPath {
  return {
    title: facts.title,
    weakStatusLine: facts.weakStatusLine,
    runtimeState: facts.runtimeState,
    executionScope: facts.executionScope,
    canRetryConnect: facts.canRetryConnect
  }
}

function resolveHeaderWeakStatusLine(
  input: TaskHeaderFactsInput,
  viewingForeignExecution: boolean,
  runningLabel: string | null,
  executionScope: HeaderExecutionScope
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
  if (viewingForeignExecution) {
    return runningLabel ? `后台正在运行 ${runningLabel}` : '后台任务执行中'
  }
  if (executionScope === 'selected') return '执行中'
  if (input.runtimeState === 'connecting') return '正在连接 Runtime…'
  if (input.runtimeState === 'error') {
    // 对话流已承载失败全文+重试时，页眉只留软状态，避免第一眼仍是运维错误句。
    if (shouldDeferConnectFailureToConversation(input)) return '连接异常'
    return input.runtimeMessage?.trim() || 'Runtime 连接异常'
  }
  return ''
}

/** 与对话流 connectFailure 同条件：已配置且无活动执行时失败说明进流，不在页眉双显。 */
function shouldDeferConnectFailureToConversation(input: TaskHeaderFactsInput): boolean {
  return Boolean(input.providerConfigured && !input.activeExecution)
}

function formatTaskCreatedAt(iso?: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return iso
  return date.toLocaleString()
}
