import { nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { CommandExecutionEvidence } from '../../../shared/command'
import type { FileDiffResult, TaskChangeSetQueryResult } from '../../../shared/git-review'
import type { DesktopIpcResult } from '../../../shared/ipc-result'
import { changeSetReadiness } from '../task-changes-presentation'
import { useTaskChanges, type TaskChangesQueryApi } from './useTaskChanges'

function ok<T>(value: T): DesktopIpcResult<T> {
  return { ok: true, value }
}

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
    validations: [
      {
        validationId: 'val_task-1_turn-1',
        taskId: 'task-1',
        turnId: 'turn-1',
        commandIds: ['cmd-1'],
        outcome: 'fail',
        reason: 'non-zero-exit'
      }
    ],
    paths: [{ path: 'README.md', attribution: 'task-modified' }],
    revertible: { kind: 'none', reason: '当前版本仅提供只读审阅，不支持一键撤销。' },
    baseCommit: 'abcdef1234567890',
    ...overrides
  }
}

function evidence(): CommandExecutionEvidence {
  return {
    commandId: 'cmd-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    environmentId: 'env-1',
    source: 'runtime-tool',
    displayCommand: 'pnpm test',
    cwd: '.',
    startedAt: '2026-08-22T10:00:00.000Z',
    endedAt: '2026-08-22T10:00:01.200Z',
    exitCode: 1,
    timedOut: false,
    status: 'failed',
    transcriptRef: {
      transcriptId: 'transcript-1',
      availableBytes: 12,
      truncated: true,
      encoding: 'utf-8',
      retentionPolicy: 'bounded',
      retentionState: 'retained'
    },
    truncated: true,
    trustLevel: 'runtime-reported'
  }
}

function createApi(overrides: Partial<TaskChangesQueryApi> = {}): TaskChangesQueryApi {
  return {
    getChangeSet: vi.fn(async () => ok(changeSet())),
    getFileDiff: vi.fn(async () =>
      ok({
        taskId: 'task-1',
        path: 'README.md',
        status: 'ok',
        unifiedDiff: '@@ -1 +1 @@\n-hello\n+world\n'
      } satisfies FileDiffResult)
    ),
    getCommandEvidence: vi.fn(async () => ok(evidence())),
    ...overrides
  }
}

async function waitUntilIdle(loading: { value: boolean }): Promise<void> {
  await nextTick()
  await vi.waitFor(() => {
    expect(loading.value).toBe(false)
  })
}

describe('useTaskChanges', () => {
  it('选中 Task 后调用 getChangeSet，点文件才 getFileDiff', async () => {
    const api = createApi()
    const taskId = ref('task-1')
    const controller = useTaskChanges(taskId, api)
    await waitUntilIdle(controller.loading)
    expect(api.getChangeSet).toHaveBeenCalledTimes(1)
    expect(api.getChangeSet).toHaveBeenCalledWith('task-1')
    expect(api.getFileDiff).not.toHaveBeenCalled()
    expect(controller.changeSet.value?.taskChangedCount).toBe(1)

    await controller.selectPath('README.md')
    expect(api.getFileDiff).toHaveBeenCalledTimes(1)
    expect(api.getFileDiff).toHaveBeenCalledWith('task-1', 'README.md')
    expect(controller.selectedDiff.value?.status).toBe('ok')

    await controller.selectPath('README.md')
    expect(api.getFileDiff).toHaveBeenCalledTimes(1)
  })

  it('truncated 空 paths 不当作无改动', async () => {
    const api = createApi({
      getChangeSet: vi.fn(async () =>
        ok(
          changeSet({
            paths: [],
            truncated: true,
            preExistingCount: 0,
            taskChangedCount: 0,
            unknownCount: 0,
            validations: []
          })
        )
      )
    })
    const controller = useTaskChanges(ref('task-1'), api)
    await waitUntilIdle(controller.loading)
    const readiness = changeSetReadiness(controller.changeSet.value!)
    expect(readiness.kind).toBe('incomplete')
    expect(readiness.heading).not.toBe('当前没有可展示的文件变化')
    expect(controller.changeSet.value?.paths).toEqual([])
    expect(controller.changeSet.value?.truncated).toBe(true)
  })

  it('失败可重试，且重试不会误用旧 Task 的结果', async () => {
    const getChangeSet = vi
      .fn<TaskChangesQueryApi['getChangeSet']>()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'operation-failed', message: '变更摘要无效。' }
      })
      .mockResolvedValueOnce(ok(changeSet()))
    const api = createApi({ getChangeSet })
    const controller = useTaskChanges(ref('task-1'), api)
    await waitUntilIdle(controller.loading)
    expect(controller.errorMessage.value).toBe('变更摘要无效。')
    expect(controller.changeSet.value).toBeNull()

    await controller.reload()
    expect(controller.errorMessage.value).toBe('')
    expect(controller.changeSet.value?.taskId).toBe('task-1')
    expect(getChangeSet).toHaveBeenCalledTimes(2)
  })

  it('切换 Task 会丢弃进行中的旧请求，且不会预取命令证据', async () => {
    let resolveFirst: ((value: DesktopIpcResult<TaskChangeSetQueryResult>) => void) | undefined
    const getChangeSet = vi
      .fn<TaskChangesQueryApi['getChangeSet']>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValueOnce(ok(changeSet({ taskId: 'task-2', paths: [] })))
    const api = createApi({ getChangeSet })
    const taskId = ref('task-1')
    const controller = useTaskChanges(taskId, api)
    await nextTick()
    taskId.value = 'task-2'
    resolveFirst?.(ok(changeSet({ taskId: 'task-1' })))
    await waitUntilIdle(controller.loading)
    expect(controller.changeSet.value?.taskId).toBe('task-2')
    expect(api.getCommandEvidence).not.toHaveBeenCalled()
    await controller.selectCommand('cmd-1')
    expect(api.getCommandEvidence).toHaveBeenCalledTimes(1)
    expect(api.getCommandEvidence).toHaveBeenCalledWith('task-2', 'cmd-1')
    expect(controller.selectedCommandEvidence.value?.source).toBe('runtime-tool')
  })

  it('撤销预览按需调用，确认后才 restore 并刷新变更', async () => {
    const previewLatestTurnRestore = vi.fn(async () =>
      ok({
        taskId: 'task-1',
        revertible: {
          kind: 'latest-turn' as const,
          turnId: 'turn-1',
          paths: ['README.md'],
          restorePlan: [{ path: 'README.md', action: 'write' as const, from: 'head' as const }]
        },
        willLosePaths: ['README.md']
      })
    )
    const restoreLatestTurn = vi.fn(async () =>
      ok({
        taskId: 'task-1',
        ok: true,
        message: '已撤销最新一轮写入，历史检查点仍保留。',
        recoveryCheckpointId: 'recovery_1',
        restoredPaths: ['README.md']
      })
    )
    const api = createApi({ previewLatestTurnRestore, restoreLatestTurn })
    const controller = useTaskChanges(ref('task-1'), api)
    await waitUntilIdle(controller.loading)
    expect(previewLatestTurnRestore).not.toHaveBeenCalled()
    await controller.openRestorePreview()
    expect(previewLatestTurnRestore).toHaveBeenCalledWith('task-1')
    expect(controller.restorePreview.value?.revertible.kind).toBe('latest-turn')
    await controller.confirmRestore()
    expect(restoreLatestTurn).toHaveBeenCalledWith('task-1')
    expect(api.getChangeSet).toHaveBeenCalledTimes(2)
  })

  it('preview 不是 latest-turn 时确认撤销不得调用 restore', async () => {
    const restoreLatestTurn = vi.fn(async () =>
      ok({
        taskId: 'task-1',
        ok: true,
        message: 'should-not-run'
      })
    )
    const api = createApi({
      previewLatestTurnRestore: vi.fn(async () =>
        ok({
          taskId: 'task-1',
          revertible: { kind: 'none' as const, reason: 'Git 无法读取 HEAD blob。' },
          willLosePaths: []
        })
      ),
      restoreLatestTurn
    })
    const controller = useTaskChanges(ref('task-1'), api)
    await waitUntilIdle(controller.loading)
    await controller.openRestorePreview()
    await controller.confirmRestore()
    expect(restoreLatestTurn).not.toHaveBeenCalled()
    expect(controller.restoreError.value).toMatch(/不能自动撤销/)
  })
})
