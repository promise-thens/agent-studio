import {
  clampTurnRewindSelection,
  resolveTurnRewindConversationPrompt,
  type TurnRewindPreview,
  type TurnRewindSelection
} from './turn-rewind-preview'

/** 与文件确认路径对齐：没有 latest-turn 预览时禁止改盘。 */
const FILES_UNAVAILABLE_ERROR = '当前不能自动恢复上一轮文件。'

export interface ExecuteTurnRewindRestoreResult {
  ok: boolean
  message?: string
  appliedPaths?: string[]
}

export interface ExecuteTurnRewindInput {
  preview: TurnRewindPreview
  selection: TurnRewindSelection
  restoreLatestTurn: () => Promise<ExecuteTurnRewindRestoreResult>
  startTurn: (prompt: string) => Promise<void>
}

export type ExecuteTurnRewindResult =
  | { status: 'noop' }
  | {
      status: 'completed'
      files?: ExecuteTurnRewindRestoreResult
      conversationPrompt?: string
    }
  | {
      status: 'files-failed'
      error: string
      files?: ExecuteTurnRewindRestoreResult
    }
  | {
      status: 'conversation-failed'
      error: string
      files?: ExecuteTurnRewindRestoreResult
      conversationPrompt: string
    }

/**
 * 按勾选执行一轮回退：先文件后对话，失败不回滚另一侧。
 *
 * 边界：必须先 clamp，busy / 未广告的对话勾选不得发送。
 * 文件失败或尚未 latest-turn 预览时默认不再发对话，避免上下文和磁盘各退一步。
 * prompt 只能来自 resolveTurnRewindConversationPrompt，禁止调用方硬编码命令名。
 */
export async function executeTurnRewind(
  input: ExecuteTurnRewindInput
): Promise<ExecuteTurnRewindResult> {
  const { preview, restoreLatestTurn, startTurn } = input
  const clamped = clampTurnRewindSelection(preview, input.selection)
  if (!clamped.conversation && !clamped.files) {
    return { status: 'noop' }
  }

  let files: ExecuteTurnRewindRestoreResult | undefined
  if (clamped.files) {
    if (preview.files.preview?.revertible.kind !== 'latest-turn') {
      return { status: 'files-failed', error: FILES_UNAVAILABLE_ERROR }
    }
    try {
      files = await restoreLatestTurn()
    } catch (error) {
      return { status: 'files-failed', error: readExecuteError(error) }
    }
    if (files.ok !== true) {
      return {
        status: 'files-failed',
        error: files.message?.trim() || FILES_UNAVAILABLE_ERROR,
        files
      }
    }
  }

  if (!clamped.conversation) {
    return files ? { status: 'completed', files } : { status: 'noop' }
  }

  const conversationPrompt = resolveTurnRewindConversationPrompt(preview, clamped)
  if (!conversationPrompt) {
    return files ? { status: 'completed', files } : { status: 'noop' }
  }

  try {
    await startTurn(conversationPrompt)
  } catch (error) {
    return {
      status: 'conversation-failed',
      error: readExecuteError(error),
      ...(files ? { files } : {}),
      conversationPrompt
    }
  }

  return {
    status: 'completed',
    ...(files ? { files } : {}),
    conversationPrompt
  }
}

function readExecuteError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
