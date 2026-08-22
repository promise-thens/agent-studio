import type { ValidationOutcome, ValidationOutcomeReason } from '../../shared/command'
import type {
  FileDiffResult,
  FileDiffStatus,
  ProjectGitPresence,
  TaskChangeAttribution,
  TaskChangePath,
  TaskChangeSet,
  TaskChangeSetQueryResult
} from '../../shared/git-review'

/** Inspector Changes 文件列表分组；pre-existing 单独成组，避免混进 Task 修改。 */
export type ChangePathGroupId =
  'task-added' | 'task-modified' | 'task-deleted' | 'unknown' | 'pre-existing'

export interface ChangePathGroupView {
  id: ChangePathGroupId
  title: string
  paths: TaskChangePath[]
}

export interface ChangeSetReadiness {
  kind: 'incomplete' | 'empty' | 'ready'
  heading: string
  detail: string
}

export interface ChangeSetSummaryView {
  gitLine: string
  countLine: string
}

export type FileDiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx' | 'no-newline'

export interface FileDiffLineView {
  kind: FileDiffLineKind
  text: string
  oldLine?: number
  newLine?: number
}

const GROUP_ORDER: readonly ChangePathGroupId[] = [
  'task-added',
  'task-modified',
  'task-deleted',
  'unknown',
  'pre-existing'
]

const GROUP_TITLES: Record<ChangePathGroupId, string> = {
  'task-added': '新增',
  'task-modified': '修改',
  'task-deleted': '删除',
  unknown: '未知或重叠',
  'pre-existing': '任务开始前已存在'
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * 把归因路径分成可浏览分组。unknown 含 overlap 与任务后改动，不并入 Task 修改。
 */
export function groupChangePaths(paths: readonly TaskChangePath[]): ChangePathGroupView[] {
  const buckets: Record<ChangePathGroupId, TaskChangePath[]> = {
    'task-added': [],
    'task-modified': [],
    'task-deleted': [],
    unknown: [],
    'pre-existing': []
  }
  for (const path of paths) {
    buckets[groupIdForAttribution(path.attribution)].push(path)
  }
  return GROUP_ORDER.flatMap((id) => {
    const items = [...buckets[id]].sort((left, right) => left.path.localeCompare(right.path))
    return items.length ? [{ id, title: GROUP_TITLES[id], paths: items }] : []
  })
}

export function gitPresenceLabel(kind: ProjectGitPresence['kind']): string {
  if (kind === 'git') return 'Git 仓库'
  if (kind === 'non-git') return '非 Git 项目'
  return '项目根无效'
}

export function formatBaseCommit(oid: string | undefined): string {
  if (!oid?.trim()) return '无 base commit'
  return oid.slice(0, 7)
}

export function presentChangeSetSummary(changeSet: TaskChangeSetQueryResult): ChangeSetSummaryView {
  return {
    gitLine: `${gitPresenceLabel(changeSet.gitPresence)} · ${formatBaseCommit(changeSet.baseCommit)}`,
    countLine: `用户已有修改 ${changeSet.preExistingCount} · 本 Task 修改 ${changeSet.taskChangedCount} · 未知或重叠 ${changeSet.unknownCount}`
  }
}

/**
 * empty+truncated 表示快照失败，禁止显示成「没有改动」。
 */
export function changeSetReadiness(changeSet: TaskChangeSetQueryResult): ChangeSetReadiness {
  if (changeSet.truncated === true && changeSet.paths.length === 0) {
    return {
      kind: 'incomplete',
      heading: '变更读取失败或不完整',
      detail: '当前看不到完整文件列表，不能当成没有改动。请重试；若仍失败，用系统 Git 手工核对。'
    }
  }
  if (changeSet.paths.length === 0) {
    return {
      kind: 'empty',
      heading: '当前没有可展示的文件变化',
      detail: '基线与工作区快照都没有列出路径。'
    }
  }
  return {
    kind: 'ready',
    heading: '',
    detail: ''
  }
}

export function changeSetTruncationBanner(changeSet: TaskChangeSetQueryResult): string | null {
  if (changeSet.truncated !== true) return null
  if (changeSet.paths.length === 0) {
    return '变更列表已截断或不完整，禁止把空列表当成没有改动。'
  }
  return '变更列表已截断，可能还有未列出的文件。'
}

export function baselineWarning(changeSet: TaskChangeSetQueryResult): string | null {
  if (changeSet.baselineStatus === 'invalid') {
    const reason = changeSet.invalidReason ? invalidReasonLabel(changeSet.invalidReason) : ''
    return reason
      ? `基线已失效：${reason}。已停止自动归因，请重新创建 Task 后再审阅。`
      : '基线已失效。已停止自动归因，请重新创建 Task 后再审阅。'
  }
  if (changeSet.baselineStatus === 'unavailable') {
    return '基线不可用，当前变化无法可靠归因到本 Task。'
  }
  return null
}

export function gitPresenceWarning(kind: ProjectGitPresence['kind']): string | null {
  if (kind === 'invalid') return '项目根无效，变更读取可能不完整。'
  return null
}

export function gitPresenceNotice(kind: ProjectGitPresence['kind']): string | null {
  if (kind === 'non-git') return '非 Git 项目只提供有限文件摘要，不伪造 Git Diff 能力。'
  return null
}

export function changeSetWarnings(changeSet: TaskChangeSetQueryResult): string[] {
  return [
    baselineWarning(changeSet),
    gitPresenceWarning(changeSet.gitPresence),
    changeSetTruncationBanner(changeSet)
  ].filter((item): item is string => Boolean(item))
}

export function revertibleNotice(revertible: TaskChangeSet['revertible']): string {
  if (revertible === false) return '不可一键撤销 · 当前版本不提供一键撤销。'
  return `不可一键撤销 · ${revertible.reason}`
}

export function attributionLabel(attribution: TaskChangeAttribution): string {
  if (attribution === 'task-added') return '新增'
  if (attribution === 'task-modified') return '修改'
  if (attribution === 'task-deleted') return '删除'
  if (attribution === 'pre-existing') return '开始前已有'
  if (attribution === 'user-changed-after-task') return '任务结束后被改动'
  return '未知或重叠'
}

export function omittedLabel(omitted: NonNullable<TaskChangePath['omitted']>): string {
  if (omitted === 'binary') return '二进制'
  if (omitted === 'too-large') return '过大'
  if (omitted === 'untracked') return '未跟踪'
  if (omitted === 'truncated') return '已截断'
  return '列表截断'
}

/**
 * 只在确有 unifiedDiff 且状态允许时渲染行。binary/too-large 即使将来夹带正文也不展示假 Diff。
 */
export function shouldRenderUnifiedDiff(diff: FileDiffResult): boolean {
  if (!diff.unifiedDiff?.length) return false
  return diff.status === 'ok' || diff.status === 'truncated' || diff.status === 'untracked'
}

export function fileDiffBanner(diff: FileDiffResult): string | null {
  if (diff.status === 'truncated' || diff.truncated === true) {
    return '差异已截断，当前不是完整 Diff。'
  }
  if (diff.status === 'binary') return '二进制文件，不展示文本差异。'
  if (diff.status === 'too-large') return '文件过大，不展示完整 Diff。'
  if (diff.status === 'untracked') return '未跟踪文件，仅提供有限内容预览。'
  if (diff.status === 'missing') return '文件已缺失，无法展示 Diff。'
  if (diff.status === 'escaped') return '路径越界，已拒绝读取。'
  if (diff.status === 'unavailable') return '当前无法读取差异。'
  return null
}

export function fileDiffFallback(status: FileDiffStatus): string {
  if (status === 'ok') return '没有可展示的文本差异。'
  return fileDiffBanner({ taskId: '', path: '', status }) ?? '无法展示该文件的差异。'
}

/**
 * 解析 unified diff。hunk 外的 +++ / --- 只当元数据，避免被算成增删行。
 */
export function parseUnifiedDiff(unifiedDiff: string): FileDiffLineView[] {
  const rawLines = unifiedDiff.split('\n')
  if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop()
  const lines: FileDiffLineView[] = []
  let inHunk = false
  let oldLine = 0
  let newLine = 0
  for (const line of rawLines) {
    const hunk = line.match(HUNK_HEADER_RE)
    if (hunk) {
      inHunk = true
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      lines.push({ kind: 'hunk', text: line })
      continue
    }
    if (line.startsWith('\\')) {
      lines.push({ kind: 'no-newline', text: line })
      continue
    }
    if (inHunk && line.startsWith('+')) {
      lines.push({ kind: 'add', text: line.slice(1), newLine })
      newLine += 1
      continue
    }
    if (inHunk && line.startsWith('-')) {
      lines.push({ kind: 'del', text: line.slice(1), oldLine })
      oldLine += 1
      continue
    }
    if (inHunk && (line.startsWith(' ') || line === '')) {
      lines.push({
        kind: 'ctx',
        text: line.startsWith(' ') ? line.slice(1) : line,
        oldLine,
        newLine
      })
      oldLine += 1
      newLine += 1
      continue
    }
    inHunk = false
    lines.push({ kind: 'meta', text: line })
  }
  return lines
}

export function validationOutcomeLabel(outcome: ValidationOutcome): string {
  if (outcome === 'pass') return '通过'
  if (outcome === 'fail') return '未通过'
  return '未知'
}

export function validationReasonLabel(reason: ValidationOutcomeReason | undefined): string {
  if (!reason) return ''
  if (reason === 'non-zero-exit') return '退出码非 0'
  if (reason === 'timed-out') return '命令超时'
  if (reason === 'cancelled') return '命令已取消'
  if (reason === 'start-failed') return '命令启动失败'
  if (reason === 'failed-status') return '命令失败'
  if (reason === 'missing-exit-code') return '缺少退出码'
  if (reason === 'unknown-status') return '状态未知'
  return '命令列表不完整'
}

/**
 * 没有通过结论时，Task 修改路径视为未验证。快照失败的空列表由 readiness 处理，不在这里说「没有」。
 */
export function unverifiedTaskPaths(changeSet: TaskChangeSetQueryResult): string[] {
  if (changeSet.validations.some((item) => item.outcome === 'pass')) return []
  return changeSet.paths
    .filter(
      (item) =>
        item.attribution === 'task-added' ||
        item.attribution === 'task-modified' ||
        item.attribution === 'task-deleted'
    )
    .map((item) => item.path)
}

export function incompleteReviewPaths(changeSet: TaskChangeSetQueryResult): string[] {
  return changeSet.paths.filter((item) => item.omitted).map((item) => item.path)
}

function groupIdForAttribution(attribution: TaskChangeAttribution): ChangePathGroupId {
  if (attribution === 'task-added') return 'task-added'
  if (attribution === 'task-modified') return 'task-modified'
  if (attribution === 'task-deleted') return 'task-deleted'
  if (attribution === 'pre-existing') return 'pre-existing'
  return 'unknown'
}

export function invalidReasonLabel(
  reason: NonNullable<TaskChangeSetQueryResult['invalidReason']>
): string {
  if (reason === 'git-root-changed') return 'Git 根目录已变化'
  if (reason === 'head-changed') return 'HEAD 已被外部切换'
  if (reason === 'path-replaced') return '项目路径已被替换'
  if (reason === 'root-missing') return '执行根目录不存在'
  if (reason === 'project-unavailable') return '项目当前不可用'
  return '嵌套仓库状态已变化'
}
