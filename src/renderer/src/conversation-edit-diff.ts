import type { PublicAgentEditDiff, PublicAgentEditHunkLine } from '../../shared/agent-event'
import type { AgentToolStatus } from '../../shared/agent'

/** 对话里单次编辑预览：把公开 hunk 收成可渲染行，不含完整文件。 */

export interface ConversationEditLineView {
  kind: PublicAgentEditHunkLine['kind']
  text: string
  lineNumber?: number
}

export interface ConversationEditHunkView {
  lines: ConversationEditLineView[]
  gapBefore?: number
}

export interface ConversationEditFileView {
  path: string
  added: number
  deleted: number
  truncated?: true
  unavailable?: PublicAgentEditDiff['unavailable']
  hunks: ConversationEditHunkView[]
}

export interface ConversationEditCardView {
  header: string
  status: AgentToolStatus | 'unknown'
  added: number
  deleted: number
  files: ConversationEditFileView[]
  warning?: string
}

export function presentConversationEditCard(input: {
  label: string
  status: AgentToolStatus | 'unknown'
  edits: readonly PublicAgentEditDiff[]
  warning?: string
}): ConversationEditCardView {
  const files = input.edits.map(presentConversationEditFile)
  const added = files.reduce((total, file) => total + file.added, 0)
  const deleted = files.reduce((total, file) => total + file.deleted, 0)
  const primaryPath = files[0]?.path ?? ''
  return {
    header: formatConversationEditHeader(input.label, primaryPath, files.length),
    status: input.status,
    added,
    deleted,
    files,
    ...(input.warning ? { warning: input.warning } : {})
  }
}

export function formatConversationEditHeader(
  label: string,
  path: string,
  fileCount: number
): string {
  if (fileCount > 1) return label
  if (!path) return label
  if (label.includes(path)) return label
  const base = path.split(/[\\/]/).pop() ?? path
  if (label.includes(base)) return label
  return `${label} ${path}`
}

export function conversationEditLineNumber(line: PublicAgentEditHunkLine): number | undefined {
  if (line.kind === 'del') return line.oldLine
  return line.newLine ?? line.oldLine
}

export function conversationEditHunkGap(
  previous: readonly PublicAgentEditHunkLine[],
  next: readonly PublicAgentEditHunkLine[]
): number | null {
  const previousLast = [...previous].reverse().find((line) => line.kind !== 'del')?.newLine
  const nextFirst = next.find((line) => line.kind !== 'del')?.newLine
  if (previousLast == null || nextFirst == null) return null
  const gap = nextFirst - previousLast - 1
  return gap > 0 ? gap : null
}

function presentConversationEditFile(edit: PublicAgentEditDiff): ConversationEditFileView {
  const hunks: ConversationEditHunkView[] = []
  for (const [index, hunk] of edit.hunks.entries()) {
    const gapBefore = index > 0 ? conversationEditHunkGap(edit.hunks[index - 1] ?? [], hunk) : null
    hunks.push({
      lines: hunk.map((line) => {
        const lineNumber = conversationEditLineNumber(line)
        return {
          kind: line.kind,
          text: line.text,
          ...(lineNumber != null ? { lineNumber } : {})
        }
      }),
      ...(gapBefore != null ? { gapBefore } : {})
    })
  }
  return {
    path: edit.path,
    added: edit.added,
    deleted: edit.deleted,
    hunks,
    ...(edit.truncated ? { truncated: true as const } : {}),
    ...(edit.unavailable ? { unavailable: edit.unavailable } : {})
  }
}

export function conversationEditUnavailableLabel(
  unavailable: NonNullable<PublicAgentEditDiff['unavailable']>
): string {
  if (unavailable === 'binary') return '二进制文件，不展示文本差异。'
  return '没有可展示的文本差异。'
}
