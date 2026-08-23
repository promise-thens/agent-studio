import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { FileDiffResult } from '../../shared/git-review'
import type { TaskChangePath, TaskChangeSetQueryResult } from '../../shared/git-review'
import {
  baselineWarning,
  changeSetReadiness,
  changeSetTruncationBanner,
  fileDiffBanner,
  filterChangeFileTree,
  formatBaseCommit,
  formatChangeLineDelta,
  gitPresenceLabel,
  gitPresenceNotice,
  gitPresenceWarning,
  groupChangePaths,
  omittedLabel,
  parseUnifiedDiff,
  presentChangeCard,
  presentChangeFileTree,
  presentChangeSetSummary,
  presentFileDiffRows,
  canRestoreLatestTurn,
  revertibleNotice,
  restoreActionLabel,
  restoreAppliedNotice,
  restorePreviewSummary,
  shouldRenderUnifiedDiff,
  unverifiedTaskPaths,
  validationOutcomeLabel,
  validationReasonLabel
} from './task-changes-presentation'

const rendererDir = dirname(fileURLToPath(import.meta.url))

function changeSet(overrides: Partial<TaskChangeSetQueryResult> = {}): TaskChangeSetQueryResult {
  return {
    taskId: 'task-1',
    environmentId: 'env-1',
    baselineStatus: 'captured',
    gitPresence: 'git',
    generatedAt: '2026-08-22T12:00:00.000Z',
    preExistingCount: 0,
    taskChangedCount: 1,
    unknownCount: 0,
    validations: [],
    paths: [{ path: 'README.md', attribution: 'task-modified' }],
    revertible: { kind: 'none', reason: '当前版本仅提供只读审阅，不支持一键撤销。' },
    baseCommit: 'abcdef1234567890',
    ...overrides
  }
}

describe('变更分组与计数文案', () => {
  it('按新增/修改/删除/未知/任务开始前已存在分组，且不把 pre-existing 混进 Task 修改', () => {
    const paths: TaskChangePath[] = [
      { path: 'src/old.ts', attribution: 'pre-existing' },
      { path: 'src/new.ts', attribution: 'task-added' },
      { path: 'src/edit.ts', attribution: 'task-modified' },
      { path: 'src/gone.ts', attribution: 'task-deleted' },
      { path: 'src/overlap.ts', attribution: 'overlap-unknown' },
      { path: 'src/after.ts', attribution: 'user-changed-after-task' }
    ]
    const groups = groupChangePaths(paths)
    expect(groups.map((group) => group.id)).toEqual([
      'task-added',
      'task-modified',
      'task-deleted',
      'unknown',
      'pre-existing'
    ])
    expect(
      groups.find((group) => group.id === 'task-added')?.paths.map((item) => item.path)
    ).toEqual(['src/new.ts'])
    expect(groups.find((group) => group.id === 'pre-existing')?.title).toBe('任务开始前已存在')
    expect(groups.find((group) => group.id === 'unknown')?.paths.map((item) => item.path)).toEqual([
      'src/after.ts',
      'src/overlap.ts'
    ])
    expect(groups.find((group) => group.id === 'task-modified')?.paths).toEqual([
      { path: 'src/edit.ts', attribution: 'task-modified' }
    ])
  })

  it('摘要同时展示 Git/非 Git、短 commit、三类计数，不把重叠算进 Task 修改', () => {
    const summary = presentChangeSetSummary(
      changeSet({
        gitPresence: 'git',
        preExistingCount: 2,
        taskChangedCount: 3,
        unknownCount: 1,
        baseCommit: 'abcdef1234567890'
      })
    )
    expect(summary.gitLine).toBe('Git 仓库 · abcdef1')
    expect(summary.countLine).toBe('用户已有修改 2 · 本 Task 修改 3 · 未知或重叠 1')
    expect(gitPresenceLabel('non-git')).toBe('非 Git 项目')
    expect(gitPresenceNotice('non-git')).toMatch(/有限/)
    expect(gitPresenceWarning('non-git')).toBeNull()
    expect(gitPresenceWarning('invalid')).toMatch(/无效/)
    expect(formatBaseCommit(undefined)).toBe('无 base commit')
  })
})

describe('截断与空变更语义', () => {
  it('empty+truncated 是读取失败，不得写成没有改动', () => {
    const incomplete = changeSetReadiness(
      changeSet({ paths: [], truncated: true, taskChangedCount: 0, preExistingCount: 0 })
    )
    expect(incomplete.kind).toBe('incomplete')
    expect(incomplete.heading).toMatch(/变更读取失败|不完整/)
    expect(incomplete.heading).not.toBe('当前没有可展示的文件变化')
    expect(incomplete.kind).not.toBe('empty')
    expect(changeSetTruncationBanner(changeSet({ truncated: true, paths: [] }))).toMatch(
      /截断|不完整|失败/
    )
  })

  it('未截断且无路径才是真正没有可展示变化', () => {
    const empty = changeSetReadiness(changeSet({ paths: [], taskChangedCount: 0 }))
    expect(empty.kind).toBe('empty')
    expect(empty.heading).toMatch(/没有可展示/)
  })

  it('截断但已有路径仍可审阅，并保留截断横幅', () => {
    const ready = changeSetReadiness(changeSet({ truncated: true }))
    expect(ready.kind).toBe('ready')
    expect(changeSetTruncationBanner(changeSet({ truncated: true }))).toMatch(/截断/)
  })
})

describe('基线失效与不可撤销', () => {
  it('基线失效给出原因，且只展示不可一键撤销说明', () => {
    expect(
      baselineWarning(changeSet({ baselineStatus: 'invalid', invalidReason: 'head-changed' }))
    ).toMatch(/基线已失效/)
    expect(
      baselineWarning(changeSet({ baselineStatus: 'invalid', invalidReason: 'head-changed' }))
    ).toMatch(/HEAD/)
    expect(
      revertibleNotice({ kind: 'none', reason: '当前版本仅提供只读审阅，不支持一键撤销。' })
    ).toBe('不可一键撤销 · 当前版本仅提供只读审阅，不支持一键撤销。')
    expect(revertibleNotice(false)).toMatch(/不可一键撤销/)
    expect(
      revertibleNotice({
        kind: 'latest-turn',
        turnId: 'turn-1',
        paths: ['README.md'],
        restorePlan: [{ path: 'README.md', action: 'write', from: 'head' }]
      })
    ).toMatch(/可撤销最新一轮/)
    expect(
      canRestoreLatestTurn({
        kind: 'latest-turn',
        turnId: 'turn-1',
        paths: ['README.md'],
        restorePlan: [{ path: 'README.md', action: 'write', from: 'head' }]
      })
    ).toBe(true)
    expect(canRestoreLatestTurn({ kind: 'none', reason: '不可撤销' })).toBe(false)
    expect(restoreActionLabel({ path: 'README.md', action: 'write', from: 'head' })).toMatch(/HEAD/)
    expect(
      restorePreviewSummary({
        taskId: 'task-1',
        revertible: {
          kind: 'latest-turn',
          turnId: 'turn-1',
          paths: ['README.md'],
          restorePlan: [{ path: 'README.md', action: 'write', from: 'head' }]
        },
        willLosePaths: ['README.md']
      })
    ).toMatch(/将丢失|丢弃/)
    expect(
      restoreAppliedNotice({
        message: '待删除路径在写回后已漂移，已停止删除。',
        appliedPaths: ['README.md', 'notes.txt']
      })
    ).toMatch(/README\.md.*notes\.txt/)
    expect(restoreAppliedNotice({ message: '已拒绝。' })).toBe('已拒绝。')
  })
})

describe('Diff 行解析与状态横幅', () => {
  it('解析 hunk 行号，长行保持原样，不截断正文', () => {
    const long = 'x'.repeat(240)
    const lines = parseUnifiedDiff(
      [
        'diff --git a/README.md b/README.md',
        '--- a/README.md',
        '+++ b/README.md',
        '@@ -1,2 +1,3 @@',
        ' hello',
        '-old',
        `+${long}`,
        '\\ No newline at end of file'
      ].join('\n')
    )
    expect(lines[0]).toMatchObject({ kind: 'meta', text: 'diff --git a/README.md b/README.md' })
    expect(lines.find((line) => line.kind === 'hunk')?.text).toContain('@@ -1,2 +1,3 @@')
    expect(lines.find((line) => line.kind === 'ctx')).toMatchObject({
      text: 'hello',
      oldLine: 1,
      newLine: 1
    })
    expect(lines.find((line) => line.kind === 'del')).toMatchObject({
      text: 'old',
      oldLine: 2
    })
    const added = lines.find((line) => line.kind === 'add')
    expect(added?.text).toBe(long)
    expect(added?.newLine).toBe(2)
    expect(lines.some((line) => line.kind === 'no-newline')).toBe(true)
  })

  it('+++ / --- 元数据不得被当成增删行', () => {
    const lines = parseUnifiedDiff('--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+ok\n')
    expect(lines.filter((line) => line.kind === 'add')).toEqual([
      expect.objectContaining({ kind: 'add', text: 'ok', newLine: 1 })
    ])
    expect(lines.filter((line) => line.kind === 'meta').map((line) => line.text)).toEqual([
      '--- a/a.ts',
      '+++ b/a.ts'
    ])
  })

  it('truncated 必须有横幅；binary/too-large 不渲染假 Diff', () => {
    const truncated: FileDiffResult = {
      taskId: 'task-1',
      path: 'a.ts',
      status: 'truncated',
      truncated: true,
      unifiedDiff: '@@ -1 +1 @@\n+partial'
    }
    expect(fileDiffBanner(truncated)).toMatch(/截断/)
    expect(shouldRenderUnifiedDiff(truncated)).toBe(true)
    expect(shouldRenderUnifiedDiff({ taskId: 'task-1', path: 'a.bin', status: 'binary' })).toBe(
      false
    )
    expect(
      shouldRenderUnifiedDiff({ taskId: 'task-1', path: 'huge.ts', status: 'too-large' })
    ).toBe(false)
    expect(fileDiffBanner({ taskId: 'task-1', path: 'a.bin', status: 'binary' })).toMatch(/二进制/)
    expect(fileDiffBanner({ taskId: 'task-1', path: 'huge.ts', status: 'too-large' })).toMatch(
      /过大/
    )
    expect(omittedLabel('untracked')).toMatch(/未跟踪/)
  })
})

describe('对话变更卡', () => {
  it('只收本 Task 与未知路径，合计 +/-，pre-existing 不进卡片', () => {
    const card = presentChangeCard(
      changeSet({
        taskChangedCount: 2,
        unknownCount: 1,
        preExistingCount: 1,
        paths: [
          { path: 'src/old.ts', attribution: 'pre-existing', added: 3, deleted: 1 },
          { path: 'src/new.ts', attribution: 'task-added', added: 10, deleted: 0 },
          { path: 'src/edit.ts', attribution: 'task-modified', added: 57, deleted: 48 },
          { path: 'src/overlap.ts', attribution: 'overlap-unknown', added: 2, deleted: 2 }
        ],
        revertible: {
          kind: 'latest-turn',
          turnId: 'turn-1',
          paths: ['src/new.ts', 'src/edit.ts'],
          restorePlan: [
            { path: 'src/new.ts', action: 'delete', from: 'absent' },
            { path: 'src/edit.ts', action: 'write', from: 'head' }
          ]
        }
      })
    )
    expect(card.visible).toBe(true)
    expect(card.heading).toBe('已编辑 3 个文件')
    expect(card.added).toBe(69)
    expect(card.deleted).toBe(50)
    expect(card.files.map((item) => item.path)).toEqual([
      'src/edit.ts',
      'src/new.ts',
      'src/overlap.ts'
    ])
    expect(card.files[0]).toMatchObject({ fileName: 'edit.ts', added: 57, deleted: 48 })
    expect(card.canRestore).toBe(true)
    expect(formatChangeLineDelta(57, 48)).toBe('+57 −48')
  })

  it('只有任务开始前已有改动时不展示卡片', () => {
    const card = presentChangeCard(
      changeSet({
        taskChangedCount: 0,
        preExistingCount: 1,
        paths: [{ path: 'README.md', attribution: 'pre-existing', added: 1, deleted: 0 }]
      })
    )
    expect(card.visible).toBe(false)
    expect(presentChangeCard(null).visible).toBe(false)
  })
})

describe('审阅文件树与未修改行摘要', () => {
  it('按目录成树，筛选只留下匹配文件及其父目录', () => {
    const tree = presentChangeFileTree([
      { path: 'src/views/chat-input.vue', attribution: 'task-modified', added: 57, deleted: 48 },
      { path: 'src/views/chat-window.vue', attribution: 'task-modified', added: 34, deleted: 28 },
      { path: 'src/index.vue', attribution: 'task-modified', added: 11, deleted: 9 }
    ])
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ kind: 'folder', name: 'src' })
    const src = tree[0]
    if (src.kind !== 'folder') throw new Error('expected folder')
    expect(src.children.map((item) => item.name)).toEqual(['index.vue', 'views'])
    const filtered = filterChangeFileTree(tree, 'chat-input')
    expect(JSON.stringify(filtered)).toContain('chat-input.vue')
    expect(JSON.stringify(filtered)).not.toContain('chat-window.vue')
    expect(JSON.stringify(filtered)).not.toContain('index.vue')
  })

  it('hunk 缺口插入只读未修改行摘要，不把元数据算进缺口', () => {
    const lines = parseUnifiedDiff(
      [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -123,2 +123,2 @@',
        ' keep',
        '-old',
        '+new',
        '@@ -128,1 +128,1 @@',
        '-x',
        '+y'
      ].join('\n')
    )
    const rows = presentFileDiffRows(lines)
    const gaps = rows.filter((row) => row.kind === 'unmodified')
    expect(gaps[0]).toEqual({ kind: 'unmodified', count: 122 })
    expect(gaps[1]).toEqual({ kind: 'unmodified', count: 3 })
    expect(rows.some((row) => row.kind === 'unmodified' && 'expandable' in row)).toBe(false)
  })
})

describe('验证与未验证文件', () => {
  it('验证结论与原因用中文，且无通过结论时列出 Task 修改路径', () => {
    expect(validationOutcomeLabel('pass')).toBe('通过')
    expect(validationOutcomeLabel('fail')).toBe('未通过')
    expect(validationOutcomeLabel('unknown')).toBe('未知')
    expect(validationReasonLabel('non-zero-exit')).toMatch(/退出码/)
    expect(validationReasonLabel('incomplete-list')).toMatch(/不完整/)
    expect(
      unverifiedTaskPaths(
        changeSet({
          paths: [
            { path: 'src/new.ts', attribution: 'task-added' },
            { path: 'src/old.ts', attribution: 'pre-existing' }
          ],
          validations: []
        })
      )
    ).toEqual(['src/new.ts'])
    expect(
      unverifiedTaskPaths(
        changeSet({
          paths: [{ path: 'src/new.ts', attribution: 'task-added' }],
          validations: [
            {
              validationId: 'val_task-1_turn-1',
              taskId: 'task-1',
              turnId: 'turn-1',
              commandIds: ['cmd-1'],
              outcome: 'pass'
            }
          ]
        })
      )
    ).toEqual([])
  })
})

describe('Changes 面板源码约束', () => {
  it('只在 latest-turn 显示撤销按钮，没有继续任务', () => {
    const panel = readFileSync(join(rendererDir, 'components/TaskChangesPanel.vue'), 'utf8')
    const viewer = readFileSync(join(rendererDir, 'components/FileDiffViewer.vue'), 'utf8')
    const inspector = readFileSync(join(rendererDir, 'components/TaskInspector.vue'), 'utf8')
    const app = readFileSync(join(rendererDir, 'App.vue'), 'utf8')
    expect(panel).toContain('commandSourceLabel')
    expect(panel).toContain('commandTrustLabel')
    expect(panel).toContain('formatCommandDuration')
    expect(panel).toContain('撤销最新一轮')
    expect(panel).toContain('canRestoreLatestTurn')
    expect(panel).toContain('restoreMessage')
    expect(panel).toContain('changes-review-split')
    expect(panel).toContain('filterChangeFileTree')
    expect(panel).not.toContain('继续任务')
    expect(panel).not.toMatch(/emit\('revert/)
    expect(viewer).toContain('fileDiffBanner')
    expect(viewer).toContain('presentFileDiffRows')
    expect(viewer).toContain('行未修改')
    expect(viewer).not.toContain('没有改动')
    expect(inspector).toContain('TaskChangesPanel')
    expect(inspector).toContain('reviewWorkspaceClass')
    expect(inspector).toContain('changesController')
    expect(readFileSync(join(rendererDir, 'task-inspector.ts'), 'utf8')).toContain(
      'is-review-workspace'
    )
    expect(app).toContain('openChangeReview')
    expect(app).toContain('useTaskChanges')
    const card = readFileSync(join(rendererDir, 'components/TaskChangeCard.vue'), 'utf8')
    const presentation = readFileSync(join(rendererDir, 'task-changes-presentation.ts'), 'utf8')
    expect(presentation).toContain('已编辑')
    expect(card).toContain('审核')
    expect(card).toContain('撤销')
    expect(card).not.toContain('继续任务')
  })
})
