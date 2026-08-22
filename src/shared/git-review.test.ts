import { describe, expect, it } from 'vitest'
import {
  parseFileDiffResult,
  parseLatestTurnRestorePreview,
  parseLatestTurnRestoreResult,
  parseTaskChangeSetQueryResult,
  parseTurnChangeCheckpoint
} from './git-review'

describe('git-review IPC 投影', () => {
  it('丢掉 fingerprint、绝对路径和 porcelain', () => {
    const parsed = parseTaskChangeSetQueryResult({
      taskId: 'task-1',
      environmentId: 'local:testenv',
      baselineStatus: 'captured',
      gitPresence: 'git',
      generatedAt: '2026-08-22T12:00:00.000Z',
      preExistingCount: 0,
      taskChangedCount: 1,
      unknownCount: 0,
      validations: [
        {
          validationId: 'val_task-1_turn-1',
          taskId: 'task-1',
          turnId: 'turn-1',
          commandIds: ['cmd-1'],
          outcome: 'pass',
          chatText: 'all tests passed'
        }
      ],
      paths: [{ path: 'README.md', attribution: 'task-modified' }],
      revertible: { kind: 'none', reason: '当前版本仅提供只读审阅，不支持一键撤销。' },
      executionRoot: '/Users/secret/project',
      fingerprint: 'dev:ino:/Users/secret/project',
      porcelainSummary: 'M README.md'
    })
    expect(parsed).toMatchObject({
      taskId: 'task-1',
      paths: [{ path: 'README.md', attribution: 'task-modified' }],
      validations: [{ commandIds: ['cmd-1'], outcome: 'pass' }]
    })
    expect(JSON.stringify(parsed)).not.toContain('/Users/secret')
    expect(JSON.stringify(parsed)).not.toContain('fingerprint')
    expect(JSON.stringify(parsed)).not.toContain('porcelain')
    expect(JSON.stringify(parsed)).not.toContain('all tests passed')
  })

  it('拒绝绝对路径 Diff，escaped 相对越界可以回显', () => {
    expect(
      parseFileDiffResult({
        taskId: 'task-1',
        path: '/etc/passwd',
        status: 'ok',
        unifiedDiff: 'secret'
      })
    ).toBeNull()
    expect(
      parseFileDiffResult({
        taskId: 'task-1',
        path: '../outside',
        status: 'escaped'
      })
    ).toEqual({
      taskId: 'task-1',
      path: '../outside',
      status: 'escaped'
    })
  })

  it('unifiedDiff 正文可含路径字面量；path 字段仍拒绝绝对路径', () => {
    expect(
      parseFileDiffResult({
        taskId: 'task-1',
        path: 'readme.md',
        status: 'ok',
        unifiedDiff: '--- a/readme.md\n+++ b/readme.md\n@@ -0,0 +1 @@\n+/Users/example/secret\n'
      })
    ).toEqual({
      taskId: 'task-1',
      path: 'readme.md',
      status: 'ok',
      unifiedDiff: '--- a/readme.md\n+++ b/readme.md\n@@ -0,0 +1 @@\n+/Users/example/secret\n'
    })
    expect(
      parseFileDiffResult({
        taskId: 'task-1',
        path: '/tmp/outside',
        status: 'ok',
        unifiedDiff: '--- a/readme.md\n+++ b/readme.md\n'
      })
    ).toBeNull()
  })

  it('检查点只保留相对路径快照', () => {
    const parsed = parseTurnChangeCheckpoint({
      schemaVersion: 1,
      taskId: 'task-1',
      turnId: 'turn-1',
      environmentId: 'local:testenv',
      capturedBeforeAt: '2026-08-22T10:00:00.000Z',
      status: 'incomplete',
      beforePaths: [{ path: 'README.md', kind: 'tracked' }],
      affectedPaths: [],
      executionRoot: '/tmp/project',
      fingerprint: '1:2:/tmp/project'
    })
    expect(parsed).toMatchObject({
      turnId: 'turn-1',
      status: 'incomplete',
      beforePaths: [{ path: 'README.md', kind: 'tracked' }]
    })
    expect(JSON.stringify(parsed)).not.toContain('/tmp/project')
    expect(JSON.stringify(parsed)).not.toContain('fingerprint')
  })

  it('latest-turn 计划只保留相对路径，拒绝绝对路径和文件正文', () => {
    const parsed = parseTaskChangeSetQueryResult({
      taskId: 'task-1',
      environmentId: 'local:testenv',
      baselineStatus: 'captured',
      gitPresence: 'git',
      generatedAt: '2026-08-22T12:00:00.000Z',
      preExistingCount: 0,
      taskChangedCount: 1,
      unknownCount: 0,
      validations: [],
      paths: [{ path: 'README.md', attribution: 'task-modified' }],
      revertible: {
        kind: 'latest-turn',
        turnId: 'turn-1',
        paths: ['README.md'],
        restorePlan: [{ path: 'README.md', action: 'write', from: 'head' }],
        fileBody: 'secret-content',
        absolutePath: '/Users/secret/README.md'
      }
    })
    expect(parsed?.revertible).toEqual({
      kind: 'latest-turn',
      turnId: 'turn-1',
      paths: ['README.md'],
      restorePlan: [{ path: 'README.md', action: 'write', from: 'head' }]
    })
    expect(JSON.stringify(parsed)).not.toContain('/Users/secret')
    expect(JSON.stringify(parsed)).not.toContain('secret-content')
    expect(
      parseLatestTurnRestorePreview({
        taskId: 'task-1',
        revertible: {
          kind: 'latest-turn',
          turnId: 'turn-1',
          paths: ['README.md'],
          restorePlan: [{ path: 'README.md', action: 'write', from: 'head' }]
        },
        willLosePaths: ['README.md'],
        contents: { 'README.md': 'agent-edit' }
      })
    ).toEqual({
      taskId: 'task-1',
      revertible: {
        kind: 'latest-turn',
        turnId: 'turn-1',
        paths: ['README.md'],
        restorePlan: [{ path: 'README.md', action: 'write', from: 'head' }]
      },
      willLosePaths: ['README.md']
    })
    expect(
      parseLatestTurnRestorePreview({
        taskId: 'task-1',
        revertible: { kind: 'none', reason: 'ok' },
        willLosePaths: ['/etc/passwd']
      })
    ).toBeNull()
    expect(
      parseLatestTurnRestoreResult({
        taskId: 'task-1',
        ok: false,
        reason: 'denied',
        message: '/Users/secret/project 无法恢复'
      })?.message
    ).toBe('恢复未完成。')
  })
})
