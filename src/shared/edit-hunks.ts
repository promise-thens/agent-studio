import type { AgentDiff } from './agent'
import type { PublicAgentEditDiff, PublicAgentEditHunkLine } from './agent-event'

/** 与 Grok TUI 默认一致：改动两侧各留 3 行未改上下文。 */
export const EDIT_HUNK_CONTEXT_LINES = 3
/** 单侧超过这个行数不再做完整 LCS，避免主进程被大文件拖死。 */
export const MAX_EDIT_DIFF_INPUT_LINES = 2000
const MAX_EDIT_DIFFS = 20
const MAX_EDIT_LINE_BYTES = 4 * 1024

export interface BuildPublicEditDiffsOptions {
  redactText?: (text: string) => string
  contextLines?: number
}

interface TaggedLine {
  kind: PublicAgentEditHunkLine['kind']
  text: string
  oldLine?: number
  newLine?: number
}

/**
 * 把主进程已脱敏的 AgentDiff 收成对话可展示的限长 hunk。
 * 不把完整 before/after 交给 Renderer；无改动的 snapshot 直接丢掉。
 */
export function buildPublicEditDiffs(
  diffs: readonly AgentDiff[],
  options: BuildPublicEditDiffsOptions = {}
): PublicAgentEditDiff[] {
  const redactText = options.redactText ?? ((text: string) => text)
  const contextLines = options.contextLines ?? EDIT_HUNK_CONTEXT_LINES
  const result: PublicAgentEditDiff[] = []

  for (const diff of diffs.slice(0, MAX_EDIT_DIFFS)) {
    const edit =
      diff.format === 'snapshot'
        ? buildSnapshotEdit(diff, redactText, contextLines)
        : buildUnifiedEdit(diff, redactText)
    if (edit) result.push(edit)
  }

  return result
}

function buildSnapshotEdit(
  diff: Extract<AgentDiff, { format: 'snapshot' }>,
  redactText: (text: string) => string,
  contextLines: number
): PublicAgentEditDiff | null {
  const path = redactText(diff.path)
  if (containsNul(diff.before) || containsNul(diff.after)) {
    return { path, added: 0, deleted: 0, unavailable: 'binary', hunks: [] }
  }

  const oldLines = splitLines(diff.before ?? '')
  const newLines = splitLines(diff.after)
  const truncated =
    oldLines.length > MAX_EDIT_DIFF_INPUT_LINES || newLines.length > MAX_EDIT_DIFF_INPUT_LINES
  const tagged = diffTaggedLines(
    oldLines.slice(0, MAX_EDIT_DIFF_INPUT_LINES),
    newLines.slice(0, MAX_EDIT_DIFF_INPUT_LINES)
  )
  const hunks = collectHunks(tagged, contextLines).map((hunk) =>
    hunk.map((line) => presentLine(line, redactText))
  )
  const added = tagged.filter((line) => line.kind === 'add').length
  const deleted = tagged.filter((line) => line.kind === 'del').length
  if (hunks.length === 0 && !truncated) return null

  return {
    path,
    added,
    deleted,
    hunks,
    ...(truncated ? { truncated: true as const } : {})
  }
}

function buildUnifiedEdit(
  diff: Extract<AgentDiff, { format: 'unified' }>,
  redactText: (text: string) => string
): PublicAgentEditDiff | null {
  const path = redactText(diff.paths[0] ?? '')
  if (!path || containsNul(diff.patch)) return null
  const parsed = parseUnifiedHunks(diff.patch)
  if (!parsed) return null
  const hunks = parsed.hunks.map((hunk) => hunk.map((line) => presentLine(line, redactText)))
  if (hunks.length === 0) return null
  return {
    path,
    added: parsed.added,
    deleted: parsed.deleted,
    hunks
  }
}

function presentLine(
  line: TaggedLine,
  redactText: (text: string) => string
): PublicAgentEditHunkLine {
  const presented: PublicAgentEditHunkLine = {
    kind: line.kind,
    text: limitUtf8(redactText(line.text), MAX_EDIT_LINE_BYTES)
  }
  if (line.oldLine != null) presented.oldLine = line.oldLine
  if (line.newLine != null) presented.newLine = line.newLine
  return presented
}

function splitLines(text: string): string[] {
  if (text === '') return []
  const parts = text.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

function containsNul(value: string | null): boolean {
  return value != null && value.includes('\0')
}

function diffTaggedLines(oldLines: string[], newLines: string[]): TaggedLine[] {
  const dp = buildLcsMatrix(oldLines, newLines)
  const tagged: TaggedLine[] = []
  let i = 0
  let j = 0
  while (i < oldLines.length && j < newLines.length) {
    const oldLine = oldLines[i]
    const newLine = newLines[j]
    if (oldLine === newLine) {
      tagged.push({ kind: 'ctx', text: oldLine, oldLine: i + 1, newLine: j + 1 })
      i += 1
      j += 1
      continue
    }
    const down = dp[i + 1]?.[j] ?? 0
    const right = dp[i]?.[j + 1] ?? 0
    if (down >= right) {
      tagged.push({ kind: 'del', text: oldLine, oldLine: i + 1 })
      i += 1
    } else {
      tagged.push({ kind: 'add', text: newLine, newLine: j + 1 })
      j += 1
    }
  }
  while (i < oldLines.length) {
    tagged.push({ kind: 'del', text: oldLines[i] ?? '', oldLine: i + 1 })
    i += 1
  }
  while (j < newLines.length) {
    tagged.push({ kind: 'add', text: newLines[j] ?? '', newLine: j + 1 })
    j += 1
  }
  return tagged
}

function buildLcsMatrix(oldLines: string[], newLines: string[]): number[][] {
  const n = oldLines.length
  const m = newLines.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = dp[i]
    const nextRow = dp[i + 1]
    if (!row || !nextRow) continue
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] =
        oldLines[i] === newLines[j]
          ? (nextRow[j + 1] ?? 0) + 1
          : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  return dp
}

function collectHunks(lines: TaggedLine[], contextLines: number): TaggedLine[][] {
  const changeIndexes: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.kind !== 'ctx') changeIndexes.push(index)
  }
  if (changeIndexes.length === 0) return []

  const ranges: Array<{ start: number; end: number }> = []
  for (const index of changeIndexes) {
    const start = Math.max(0, index - contextLines)
    const end = Math.min(lines.length, index + contextLines + 1)
    const last = ranges[ranges.length - 1]
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end)
    } else {
      ranges.push({ start, end })
    }
  }

  return ranges.map((range) => lines.slice(range.start, range.end))
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function parseUnifiedHunks(
  patch: string
): { hunks: TaggedLine[][]; added: number; deleted: number } | null {
  const rawLines = patch.split('\n')
  if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop()
  const hunks: TaggedLine[][] = []
  let current: TaggedLine[] | null = null
  let oldLine = 0
  let newLine = 0
  let added = 0
  let deleted = 0
  let inHunk = false

  for (const line of rawLines) {
    const header = HUNK_HEADER_RE.exec(line)
    if (header) {
      if (current?.length) hunks.push(current)
      current = []
      inHunk = true
      oldLine = Number(header[1])
      newLine = Number(header[2])
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('+')) {
      current?.push({ kind: 'add', text: line.slice(1), newLine })
      newLine += 1
      added += 1
      continue
    }
    if (line.startsWith('-')) {
      current?.push({ kind: 'del', text: line.slice(1), oldLine })
      oldLine += 1
      deleted += 1
      continue
    }
    if (line.startsWith(' ') || line === '') {
      const text = line.startsWith(' ') ? line.slice(1) : line
      current?.push({ kind: 'ctx', text, oldLine, newLine })
      oldLine += 1
      newLine += 1
    }
  }
  if (current?.length) hunks.push(current)
  if (hunks.length === 0) return null
  return { hunks, added, deleted }
}

function limitUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  if (encoder.encode(value).length <= maxBytes) return value
  const accepted: string[] = []
  let byteLength = 0
  for (const character of value) {
    const characterBytes = encoder.encode(character).length
    if (byteLength + characterBytes > maxBytes) break
    accepted.push(character)
    byteLength += characterBytes
  }
  return accepted.join('')
}
