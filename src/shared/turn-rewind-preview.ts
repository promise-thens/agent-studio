import type { LatestTurnRestorePreview, TaskChangeSet } from './git-review'

/**
 * Grok 广告的对话回退斜杠命令 name（无前导 /）。
 * 匹配必须精确 `name === 'rewind'`；`view-rewind`、`/rewind`、子串都不算。
 */
export const GROK_REWIND_SLASH_COMMAND = 'rewind'

/**
 * 仅当快照精确广告 `name === 'undo'` 时才允许作为对话回退命令。
 * rewind 优先；未广告时禁止拼 `/undo`。
 */
export const GROK_UNDO_SLASH_COMMAND = 'undo'

/** 与 git-review 拒绝文案对齐，预览缺失时不新编一套。 */
const FILES_UNAVAILABLE_REASON = '当前版本不提供一键恢复上一轮文件。'

export const TURN_REWIND_CARD_LABEL = '回退上一轮'
export const TURN_REWIND_CONVERSATION_LABEL = '对话回退'
export const TURN_REWIND_FILES_LABEL = '文件恢复'
export const TURN_REWIND_CONVERSATION_DESCRIPTION = '只影响 Grok 上下文，不改磁盘'
export const TURN_REWIND_COMMAND_MISSING_COPY = '当前会话未提供 rewind'
export const TURN_REWIND_BUSY_COPY = '任务执行中，暂时不能回退'
export const TURN_REWIND_CONFIRM_BOTH = '确认回退'
export const TURN_REWIND_CONFIRM_FILES = '确认恢复文件'
export const TURN_REWIND_CONFIRM_CONVERSATION = '确认对话回退'
export const TURN_REWIND_PREVIEW_FILES_ACTION = '恢复上一轮文件'

export type TurnRewindConversationStatus = 'available' | 'command-missing' | 'busy'
export type TurnRewindConversationCommandName = 'rewind' | 'undo'

export interface TurnRewindFilesPreview {
  blocked: boolean
  reason?: string
  preview: LatestTurnRestorePreview | null
}

export interface TurnRewindPreview {
  conversation: TurnRewindConversationStatus
  /** 仅 conversation==='available' 时出现，且必须是快照里的真 name */
  conversationCommandName?: TurnRewindConversationCommandName
  files: TurnRewindFilesPreview
}

export interface TurnRewindSelection {
  conversation: boolean
  files: boolean
}

export interface BuildTurnRewindPreviewInput {
  advertisedCommands: readonly { name: string }[]
  busy: boolean
  restorePreview: LatestTurnRestorePreview | null
  /** 尚未拉 IPC 预览时，用变更集上的 revertible 判断文件行是否可执行。 */
  changeSetRevertible?: TaskChangeSet['revertible'] | null
}

export interface TurnRewindCardPresentation {
  conversationCheckboxDisabled: boolean
  conversationChecked: boolean
  conversationTitle: string
  conversationDescription: string
  conversationStatusCopy: string | null
  filesCheckboxDisabled: boolean
  filesChecked: boolean
  filesButtonDisabled: boolean
  filesReason: string | null
  conversationPrompt: string | null
  confirmDisabled: boolean
  confirmLabel: string
  needsFilePreview: boolean
}

/**
 * 广告匹配必须精确 `name === 'rewind'`。
 * 当前 Grok 1.0.13 未广告该命令，调用方必须把结果当成对话行禁用条件。
 */
export function isRewindCommandAdvertised(
  advertisedCommands: readonly { name: string }[]
): boolean {
  return advertisedCommands.some((cmd) => cmd.name === GROK_REWIND_SLASH_COMMAND)
}

/**
 * 广告匹配必须精确 `name === 'undo'`；不得把 rewind 的别名想象成 undo。
 */
export function isUndoCommandAdvertised(advertisedCommands: readonly { name: string }[]): boolean {
  return advertisedCommands.some((cmd) => cmd.name === GROK_UNDO_SLASH_COMMAND)
}

/**
 * 空闲时才能发送的对话命令真名。rewind 优先于 undo；未广告返回 null。
 */
export function resolveTurnRewindConversationCommandName(
  advertisedCommands: readonly { name: string }[]
): TurnRewindConversationCommandName | null {
  if (isRewindCommandAdvertised(advertisedCommands)) return 'rewind'
  if (isUndoCommandAdvertised(advertisedCommands)) return 'undo'
  return null
}

/**
 * 与 Composer Plan 开关同一套忙碌判定：活动 Turn、停止中、modelBusy。
 * permissionModeBusy 由调用方折进 modelBusy，避免再开 IPC。
 */
export function isTurnRewindBusy(input: {
  modelBusy: boolean
  composerAction: 'send' | 'stop'
  hasActiveExecution: boolean
}): boolean {
  return input.modelBusy || input.composerAction === 'stop' || input.hasActiveExecution
}

/**
 * 组合对话广告与文件检查点预览。Renderer 只渲染该模型，不自己猜命令名。
 *
 * 边界：busy 即使有广告也不可勾选对话；无广告永不带 conversationCommandName。
 * 文件 blocked 当预览缺失或 kind 不是 latest-turn；原因沿用已有拒绝文案。
 */
export function buildTurnRewindPreview(input: BuildTurnRewindPreviewInput): TurnRewindPreview {
  const commandName = resolveTurnRewindConversationCommandName(input.advertisedCommands)
  const conversation: TurnRewindConversationStatus = input.busy
    ? 'busy'
    : commandName
      ? 'available'
      : 'command-missing'
  const preview: TurnRewindPreview = {
    conversation,
    files: resolveTurnRewindFiles(input.restorePreview, input.changeSetRevertible)
  }
  if (conversation === 'available' && commandName) {
    preview.conversationCommandName = commandName
  }
  return preview
}

/**
 * 仅 available 且（未传 selection 或 clamp 后仍勾选对话）时返回 `/` + 快照真名。
 * command-missing / busy / 用户取消对话必须是 null，禁止伪造 `/rewind`。
 */
export function resolveTurnRewindConversationPrompt(
  preview: TurnRewindPreview,
  selection?: TurnRewindSelection
): string | null {
  if (selection && !clampTurnRewindSelection(preview, selection).conversation) return null
  if (preview.conversation !== 'available') return null
  if (preview.conversationCommandName !== 'rewind' && preview.conversationCommandName !== 'undo') {
    return null
  }
  return `/${preview.conversationCommandName}`
}

/**
 * 能用的行默认勾；busy / command-missing / files.blocked 不得勾成将要执行。
 */
export function defaultTurnRewindSelection(preview: TurnRewindPreview): TurnRewindSelection {
  return {
    conversation: canSelectTurnRewindConversation(preview),
    files: canSelectTurnRewindFiles(preview)
  }
}

/**
 * 把用户勾选夹回可执行范围，避免 disabled 行仍被当成确认目标。
 */
export function clampTurnRewindSelection(
  preview: TurnRewindPreview,
  selection: TurnRewindSelection
): TurnRewindSelection {
  return {
    conversation: canSelectTurnRewindConversation(preview) && selection.conversation,
    files: canSelectTurnRewindFiles(preview) && selection.files
  }
}

/**
 * 预览对象换新但 conversation/blocked 没变时，只 clamp 保留用户勾选。
 * 状态真变了才回到默认勾选，避免点「恢复上一轮文件」把已取消的对话重新勾上。
 */
export function nextTurnRewindSelection(input: {
  previousConversation: TurnRewindConversationStatus
  previousFilesBlocked: boolean
  next: TurnRewindPreview
  selection: TurnRewindSelection
}): TurnRewindSelection {
  if (
    input.previousConversation === input.next.conversation &&
    input.previousFilesBlocked === input.next.files.blocked
  ) {
    return clampTurnRewindSelection(input.next, input.selection)
  }
  return defaultTurnRewindSelection(input.next)
}

/**
 * 把预览模型投影成 checkbox / 按钮禁用态。不在这里发 prompt 或调 restore。
 */
export function presentTurnRewindCard(
  preview: TurnRewindPreview,
  selection: TurnRewindSelection = defaultTurnRewindSelection(preview)
): TurnRewindCardPresentation {
  const clamped = clampTurnRewindSelection(preview, selection)
  const filesLocked = preview.files.blocked || preview.conversation === 'busy'
  const needsFilePreview = clamped.files && preview.files.preview?.revertible.kind !== 'latest-turn'
  return {
    conversationCheckboxDisabled: preview.conversation !== 'available',
    conversationChecked: clamped.conversation,
    conversationTitle: TURN_REWIND_CONVERSATION_LABEL,
    conversationDescription: TURN_REWIND_CONVERSATION_DESCRIPTION,
    conversationStatusCopy:
      preview.conversation === 'command-missing'
        ? TURN_REWIND_COMMAND_MISSING_COPY
        : preview.conversation === 'busy'
          ? TURN_REWIND_BUSY_COPY
          : null,
    filesCheckboxDisabled: filesLocked,
    filesChecked: clamped.files,
    filesButtonDisabled: filesLocked || !clamped.files,
    filesReason: preview.files.blocked
      ? (preview.files.reason ?? FILES_UNAVAILABLE_REASON)
      : preview.conversation === 'busy'
        ? TURN_REWIND_BUSY_COPY
        : null,
    conversationPrompt: resolveTurnRewindConversationPrompt(preview, clamped),
    confirmDisabled: !clamped.conversation && !clamped.files,
    confirmLabel: resolveTurnRewindConfirmLabel(clamped, needsFilePreview),
    needsFilePreview
  }
}

/**
 * 确认文案按勾选分行，不得把对话和文件合成一个笼统动词。
 * 文件还没 latest-turn 预览时先走预览动作，不能假装已经可以 restore。
 */
function resolveTurnRewindConfirmLabel(
  clamped: TurnRewindSelection,
  needsFilePreview: boolean
): string {
  if (needsFilePreview) return TURN_REWIND_PREVIEW_FILES_ACTION
  if (clamped.conversation && clamped.files) return TURN_REWIND_CONFIRM_BOTH
  if (clamped.files) return TURN_REWIND_CONFIRM_FILES
  if (clamped.conversation) return TURN_REWIND_CONFIRM_CONVERSATION
  return TURN_REWIND_CONFIRM_BOTH
}

function canSelectTurnRewindConversation(preview: TurnRewindPreview): boolean {
  return preview.conversation === 'available'
}

function canSelectTurnRewindFiles(preview: TurnRewindPreview): boolean {
  return !preview.files.blocked && preview.conversation !== 'busy'
}

function resolveTurnRewindFiles(
  restorePreview: LatestTurnRestorePreview | null,
  changeSetRevertible: TaskChangeSet['revertible'] | null | undefined
): TurnRewindFilesPreview {
  const revertible = restorePreview?.revertible ?? changeSetRevertible ?? null
  if (revertible == null || revertible === false) {
    return {
      blocked: true,
      reason: FILES_UNAVAILABLE_REASON,
      preview: restorePreview
    }
  }
  if (revertible.kind !== 'latest-turn') {
    return {
      blocked: true,
      reason: revertible.reason,
      preview: restorePreview
    }
  }
  return {
    blocked: false,
    preview: restorePreview
  }
}
