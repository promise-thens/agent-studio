import { describe, expect, it, vi } from 'vitest'
import {
  MAX_COMMAND_EVIDENCE_LIST_ITEMS,
  type CommandExecutionEvidence
} from '../../shared/command'
import { TASK_INVOKE_CHANNELS } from '../../shared/task-ipc'
import type { DesktopIpcResult } from '../../shared/ipc-result'
import type { CommandEvidenceStore } from '../command/command-evidence-store'
import type { DesktopIpcHandler } from '../ipc-types'
import { DesktopIpcFailure, type TrustedIpcInvokeEvent } from '../security/ipc-sender-validation'
import type {
  FileDiffResult,
  LatestTurnRestorePreview,
  LatestTurnRestoreResult,
  TaskChangeSetQueryResult,
  TurnChangeCheckpoint
} from '../../shared/git-review'
import { registerTaskIpcHandlers, type TaskHistoryIpcRuntime } from './task-ipc'

const event = {} as TrustedIpcInvokeEvent

function sampleEvidence(
  overrides: Partial<CommandExecutionEvidence> = {}
): CommandExecutionEvidence {
  return {
    commandId: 'cmd-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    environmentId: 'env-1',
    source: 'app-runner',
    displayCommand: 'node -e process.stdout.write("ok")',
    cwd: '.',
    startedAt: '2026-08-22T10:00:00.000Z',
    endedAt: '2026-08-22T10:00:01.000Z',
    exitCode: 0,
    timedOut: false,
    status: 'succeeded',
    transcriptRef: {
      transcriptId: 'transcript-1',
      availableBytes: 2,
      totalBytes: 2,
      truncated: false,
      encoding: 'utf-8',
      retentionPolicy: 'bounded',
      retentionState: 'retained'
    },
    truncated: false,
    trustLevel: 'app-enforced',
    ...overrides
  }
}

function createFixture(
  historyAvailable = true,
  commandStoreAvailable = true
): {
  handlers: Map<string, DesktopIpcHandler>
  history: TaskHistoryIpcRuntime
  commandStore: Pick<
    CommandEvidenceStore,
    'listEvidence' | 'readEvidence' | 'readTranscript' | 'waitForWrites' | 'hasPersistIncomplete'
  >
  gitReview: {
    getChangeSet: ReturnType<typeof vi.fn>
    getFileDiff: ReturnType<typeof vi.fn>
    listTurnCheckpoints: ReturnType<typeof vi.fn>
    previewLatestTurnRestore: ReturnType<typeof vi.fn>
    restoreLatestTurn: ReturnType<typeof vi.fn>
  }
  assertTrustedSender: ReturnType<typeof vi.fn>
  invoke: <T>(channel: string, request: unknown) => Promise<DesktopIpcResult<T>>
} {
  const handlers = new Map<string, DesktopIpcHandler>()
  const history: TaskHistoryIpcRuntime = {
    listTasks: vi.fn(async () => ({ items: [] })),
    getTaskDetail: vi.fn((taskId: string) => {
      if (taskId === 'missing-task') throw new Error('未找到指定 Task 历史。')
      return {
        taskId,
        projectId: 'project-1',
        runtimeId: 'grok' as const,
        title: '测试',
        state: 'completed' as const,
        turnCount: 1,
        resumable: true,
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:00:00.000Z',
        revision: 1,
        environment: { kind: 'local' as const, projectId: 'project-1' },
        permissionPolicy: { kind: 'legacy-runtime' as const }
      }
    }),
    listTurns: vi.fn(async () => ({ items: [] })),
    listEvents: vi.fn(async () => ({ items: [], watermark: 0 })),
    listPermissionAudits: vi.fn(async () => ({ items: [] })),
    resumeTask: vi.fn(async () => ({ resumed: false, message: '不可恢复' })),
    previewTaskDeletion: vi.fn(async () => ({
      targetType: 'task' as const,
      targetId: 'task-1',
      revision: 1,
      fileCount: 1,
      turnCount: 1,
      bytes: 1,
      exclusions: [],
      token: 'token',
      expiresAt: '2026-08-12T00:05:00.000Z'
    })),
    deleteTask: vi.fn(async () => undefined),
    renameTask: vi.fn(async () => ({
      taskId: 'task-1',
      projectId: 'project-1',
      runtimeId: 'grok' as const,
      title: '新标题',
      state: 'completed' as const,
      turnCount: 1,
      resumable: true,
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:01:00.000Z',
      revision: 2,
      environment: { kind: 'local' as const, projectId: 'project-1' },
      permissionPolicy: { kind: 'legacy-runtime' as const }
    })),
    archiveTask: vi.fn(async () => ({
      taskId: 'task-1',
      projectId: 'project-1',
      runtimeId: 'grok' as const,
      title: '测试',
      state: 'completed' as const,
      turnCount: 1,
      resumable: true,
      archived: true as const,
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:01:00.000Z',
      revision: 2,
      environment: { kind: 'local' as const, projectId: 'project-1' },
      permissionPolicy: { kind: 'legacy-runtime' as const }
    }))
  }
  const assertTrustedSender = vi.fn()
  const commandStore: Pick<
    CommandEvidenceStore,
    'listEvidence' | 'readEvidence' | 'readTranscript' | 'waitForWrites' | 'hasPersistIncomplete'
  > = {
    listEvidence: vi.fn(async () => []),
    readEvidence: vi.fn(async () => null),
    readTranscript: vi.fn(async () => null),
    waitForWrites: vi.fn(async () => undefined),
    hasPersistIncomplete: vi.fn(() => false)
  }
  const gitReview = {
    getChangeSet: vi.fn(async (taskId: string): Promise<TaskChangeSetQueryResult> => ({
      taskId,
      environmentId: 'local:testenv',
      baselineStatus: 'captured',
      gitPresence: 'git',
      generatedAt: '2026-08-22T12:00:00.000Z',
      preExistingCount: 0,
      taskChangedCount: 1,
      unknownCount: 0,
      validations: [],
      paths: [{ path: 'README.md', attribution: 'task-modified' }],
      revertible: { kind: 'none', reason: '当前版本仅提供只读审阅，不支持一键撤销。' }
    })),
    getFileDiff: vi.fn(async (taskId: string, path: string): Promise<FileDiffResult> => {
      if (path.includes('..') || path.startsWith('/')) {
        return { taskId, path, status: 'escaped' }
      }
      return { taskId, path, status: 'ok', unifiedDiff: '--- a/README.md\n+++ b/README.md\n' }
    }),
    listTurnCheckpoints: vi.fn(async (): Promise<TurnChangeCheckpoint[]> => []),
    previewLatestTurnRestore: vi.fn(async (taskId: string): Promise<LatestTurnRestorePreview> => ({
      taskId,
      revertible: { kind: 'none', reason: '当前版本仅提供只读审阅，不支持一键撤销。' },
      willLosePaths: []
    })),
    restoreLatestTurn: vi.fn(async (taskId: string): Promise<LatestTurnRestoreResult> => ({
      taskId,
      ok: false,
      reason: 'none',
      message: '当前不能自动撤销。'
    }))
  }
  const artifactRegistry = {
    list: vi.fn(async (taskId: string) => [
      {
        artifactId: 'art-1',
        projectId: 'project-1',
        taskId,
        turnId: 'turn-1',
        kind: 'markdown' as const,
        title: 'README.md',
        mimeType: 'text/markdown',
        source: 'git-review' as const,
        environmentId: 'local:env',
        location: { kind: 'file' as const, relativePath: 'README.md' },
        size: 12,
        contentHash: 'abc',
        createdAt: '2026-08-28T00:00:00.000Z',
        trustLevel: 'verified' as const,
        availability: 'ready' as const,
        revision: 1
      }
    ]),
    syncFromChangeSet: vi.fn(async () => undefined)
  }
  const artifactContent = {
    getContent: vi.fn(async (taskId: string, artifactId: string) => ({
      kind: 'markdown' as const,
      markdown: '# hi',
      descriptor: {
        artifactId,
        projectId: 'project-1',
        taskId,
        turnId: 'turn-1',
        kind: 'markdown' as const,
        title: 'README.md',
        mimeType: 'text/markdown',
        source: 'git-review' as const,
        environmentId: 'local:env',
        location: { kind: 'file' as const, relativePath: 'README.md' },
        size: 12,
        contentHash: 'abc',
        createdAt: '2026-08-28T00:00:00.000Z',
        trustLevel: 'verified' as const,
        availability: 'ready' as const,
        revision: 1
      }
    }))
  }
  registerTaskIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    assertTrustedSender,
    getHistory: () => (historyAvailable ? history : null),
    getCommandEvidenceStore: () => (commandStoreAvailable ? commandStore : null),
    getGitReview: () => gitReview,
    getArtifactRegistry: () => artifactRegistry as never,
    getArtifactContent: () => artifactContent as never,
    sanitizeError: (error) => (error instanceof Error ? error.message : String(error))
  })
  return {
    handlers,
    history,
    commandStore,
    gitReview,
    assertTrustedSender,
    invoke: async <T>(channel: string, request: unknown): Promise<DesktopIpcResult<T>> => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`缺少 Handler: ${channel}`)
      return (await handler(event, request)) as DesktopIpcResult<T>
    }
  }
}

describe('Task 历史 IPC', () => {
  it('只注册固定 Task channel，并先验证 Renderer 来源', async () => {
    const fixture = createFixture()
    expect([...fixture.handlers.keys()]).toEqual(Object.values(TASK_INVOKE_CHANNELS))
    fixture.assertTrustedSender.mockImplementation(() => {
      throw new DesktopIpcFailure('forbidden', '拒绝此 IPC 调用。')
    })
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.get, { taskId: 'task-1', extra: 'bad' })
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(fixture.history.getTaskDetail).not.toHaveBeenCalled()
  })

  it('历史服务未初始化时返回有限 runtime-unavailable', async () => {
    const fixture = createFixture(false)
    expect(await fixture.invoke(TASK_INVOKE_CHANNELS.get, { taskId: 'task-1' })).toEqual({
      ok: false,
      error: { code: 'runtime-unavailable', message: 'Task 历史服务尚未初始化。' }
    })
  })

  it('分页参数必须为安全非负整数，额外字段和 NUL 文本被拒绝', async () => {
    const fixture = createFixture()
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.listEvents, {
        taskId: 'task-1',
        turnId: 'turn-1',
        afterSequence: 1.5
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.list, {
        projectId: 'project\0bad',
        extra: true
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })

  it('事件分页原样转发数值 afterSequence 并保留数值响应字段', async () => {
    const fixture = createFixture()
    vi.mocked(fixture.history.listEvents).mockResolvedValueOnce({
      items: [],
      nextAfterSequence: 42,
      watermark: 100
    })

    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.listEvents, {
        taskId: 'task-1',
        turnId: 'turn-1',
        afterSequence: 42,
        limit: 200
      })
    ).toEqual({
      ok: true,
      value: { items: [], nextAfterSequence: 42, watermark: 100 }
    })
    expect(fixture.history.listEvents).toHaveBeenCalledWith('task-1', 'turn-1', 42, 200)
  })

  it('删除 token 与 Task ID原样绑定到历史服务，不暴露其它能力', async () => {
    const fixture = createFixture()
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.delete, {
        taskId: 'task-1',
        token: 'token-1'
      })
    ).toEqual({ ok: true, value: null })
    expect(fixture.history.deleteTask).toHaveBeenCalledWith('task-1', 'token-1')
  })

  it('重命名只转发 taskId 与 title，空标题在进入历史服务前被拒绝', async () => {
    const fixture = createFixture()
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.rename, {
        taskId: 'task-1',
        title: '登录改邮箱'
      })
    ).toMatchObject({ ok: true, value: { title: '新标题' } })
    expect(fixture.history.renameTask).toHaveBeenCalledWith('task-1', '登录改邮箱')

    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.rename, { taskId: 'task-1', title: '   ' })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.rename, {
        taskId: 'task-1',
        title: 'ok',
        extra: true
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(fixture.history.renameTask).toHaveBeenCalledTimes(1)
  })

  it('子代理活动拒绝路径型 shortId，缺 reader 时诚实 missing', async () => {
    const fixture = createFixture()
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.getSubagentActivity, {
        taskId: 'task-1',
        shortId: '../etc'
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.getSubagentActivity, {
        taskId: 'task-1',
        shortId: '01a05bc9'
      })
    ).toEqual({ ok: true, value: { source: 'missing', tools: [] } })
  })

  it('归档只接受 taskId，并原样交给历史服务', async () => {
    const fixture = createFixture()
    expect(await fixture.invoke(TASK_INVOKE_CHANNELS.archive, { taskId: 'task-1' })).toMatchObject({
      ok: true,
      value: { archived: true }
    })
    expect(fixture.history.archiveTask).toHaveBeenCalledWith('task-1')
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.archive, { taskId: 'task-1', extra: true })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })

  it('权限审计查询只接受 Task ID、cursor 和 limit', async () => {
    const fixture = createFixture()
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.listPermissionAudits, {
        taskId: 'task-1',
        cursor: 'audit-1',
        limit: 20
      })
    ).toEqual({ ok: true, value: { items: [] } })
    expect(fixture.history.listPermissionAudits).toHaveBeenCalledWith('task-1', 'audit-1', 20)
  })
})

describe('Task 命令证据只读 IPC', () => {
  it('不注册 execute/run/spawn channel，并拒绝 Renderer 提交 executable/cwd/env', async () => {
    const fixture = createFixture()
    const channels = Object.values(TASK_INVOKE_CHANNELS)
    expect(channels.every((channel) => !channel.startsWith('grok:'))).toBe(true)
    expect(channels.some((channel) => /execute|run|spawn/i.test(channel))).toBe(false)
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.listCommandEvidence, {
        taskId: 'task-1',
        executable: '/bin/sh',
        cwd: '/tmp',
        env: { XAI_API_KEY: 'planted' }
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(fixture.commandStore.listEvidence).not.toHaveBeenCalled()
  })

  it('列出证据前校验 Task 存在，未知 Task 安全拒绝', async () => {
    const fixture = createFixture()
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.listCommandEvidence, { taskId: 'missing-task' })
    ).toMatchObject({ ok: false, error: { code: 'history-not-found' } })
    expect(fixture.commandStore.listEvidence).not.toHaveBeenCalled()
  })

  it('按 taskId 返回证据摘要且不含路径', async () => {
    const fixture = createFixture()
    const evidence = sampleEvidence()
    vi.mocked(fixture.commandStore.listEvidence).mockResolvedValueOnce([evidence])
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.listCommandEvidence, { taskId: 'task-1' })
    ).toEqual({ ok: true, value: { items: [evidence] } })
    expect(JSON.stringify(evidence)).not.toContain('filePath')
  })

  it('列出证据前等待落盘，并保留最新 N 条而不是最旧 N 条', async () => {
    const fixture = createFixture()
    const order: string[] = []
    const oldest = sampleEvidence({
      commandId: 'cmd-oldest',
      startedAt: '2026-08-22T09:00:00.000Z',
      endedAt: '2026-08-22T09:00:01.000Z'
    })
    const newestFail = sampleEvidence({
      commandId: 'cmd-newest-fail',
      startedAt: '2026-08-22T12:00:00.000Z',
      endedAt: '2026-08-22T12:00:01.000Z',
      status: 'failed',
      exitCode: 2
    })
    const middle = Array.from({ length: MAX_COMMAND_EVIDENCE_LIST_ITEMS - 1 }, (_, index) =>
      sampleEvidence({
        commandId: `cmd-mid-${index + 1}`,
        startedAt: new Date(Date.parse('2026-08-22T10:00:00.000Z') + index * 1000).toISOString()
      })
    )
    vi.mocked(fixture.commandStore.waitForWrites).mockImplementation(async () => {
      order.push('wait')
    })
    vi.mocked(fixture.commandStore.listEvidence).mockImplementation(async () => {
      order.push('list')
      return [oldest, ...middle, newestFail]
    })

    const result = await fixture.invoke(TASK_INVOKE_CHANNELS.listCommandEvidence, {
      taskId: 'task-1'
    })

    expect(order).toEqual(['wait', 'list'])
    expect(result).toMatchObject({
      ok: true,
      value: {
        truncated: true,
        items: expect.any(Array)
      }
    })
    const items =
      result.ok && result.value && typeof result.value === 'object' && 'items' in result.value
        ? (result.value.items as CommandExecutionEvidence[])
        : []
    expect(items).toHaveLength(MAX_COMMAND_EVIDENCE_LIST_ITEMS)
    expect(items[0]?.commandId).not.toBe('cmd-oldest')
    expect(items.at(-1)?.commandId).toBe('cmd-newest-fail')
    expect(items.some((item) => item.status === 'failed' && item.exitCode === 2)).toBe(true)
  })

  it('落盘缺口会随列表一起返回 persistIncomplete', async () => {
    const fixture = createFixture()
    vi.mocked(fixture.commandStore.hasPersistIncomplete).mockReturnValueOnce(true)
    vi.mocked(fixture.commandStore.listEvidence).mockResolvedValueOnce([sampleEvidence()])
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.listCommandEvidence, { taskId: 'task-1' })
    ).toEqual({
      ok: true,
      value: { items: [sampleEvidence()], persistIncomplete: true }
    })
  })

  it('跨 Task 的 evidence.taskId 不得被查询接口返回', async () => {
    const fixture = createFixture()
    vi.mocked(fixture.commandStore.readEvidence).mockResolvedValueOnce(
      sampleEvidence({ taskId: 'task-2' })
    )
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.getCommandEvidence, {
        taskId: 'task-1',
        commandId: 'cmd-1'
      })
    ).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })

  it('拒绝非法身份、路径字段和超限 offset', async () => {
    const fixture = createFixture()
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.getCommandEvidence, {
        taskId: '../escape',
        commandId: 'cmd-1'
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.getCommandTranscript, {
        taskId: 'task-1',
        commandId: 'cmd-1',
        path: '/tmp/out.log'
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    vi.mocked(fixture.commandStore.readEvidence).mockResolvedValue(sampleEvidence())
    vi.mocked(fixture.commandStore.readTranscript).mockResolvedValue({
      transcriptId: 'transcript-1',
      commandId: 'cmd-1',
      taskId: 'task-1',
      encoding: 'utf-8',
      truncated: false,
      totalBytes: 2,
      availableBytes: 2,
      chunks: [{ stream: 'stdout', text: 'ok' }]
    })
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.getCommandTranscript, {
        taskId: 'task-1',
        commandId: 'cmd-1',
        offset: 9
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })

  it('缺失 transcript 返回 missing 而不回传文件路径', async () => {
    const fixture = createFixture()
    vi.mocked(fixture.commandStore.readEvidence).mockResolvedValueOnce(
      sampleEvidence({
        transcriptRef: {
          transcriptId: 'transcript-1',
          availableBytes: 2,
          truncated: true,
          encoding: 'utf-8',
          retentionPolicy: 'bounded',
          retentionState: 'retained'
        }
      })
    )
    vi.mocked(fixture.commandStore.readTranscript).mockResolvedValueOnce(null)
    const result = await fixture.invoke(TASK_INVOKE_CHANNELS.getCommandTranscript, {
      taskId: 'task-1',
      commandId: 'cmd-1'
    })
    expect(result).toEqual({
      ok: true,
      value: {
        taskId: 'task-1',
        commandId: 'cmd-1',
        transcriptId: 'transcript-1',
        offset: 0,
        limit: 32,
        truncated: true,
        retentionState: 'missing',
        chunks: []
      }
    })
    expect(JSON.stringify(result)).not.toContain('path')
  })
})

describe('Task 变更审阅只读 IPC', () => {
  it('change-set / file-diff 不含绝对路径，未知 Task 当 not-found', async () => {
    const fixture = createFixture()
    const listed = await fixture.invoke(TASK_INVOKE_CHANNELS.getChangeSet, { taskId: 'task-1' })
    expect(listed).toMatchObject({
      ok: true,
      value: {
        taskId: 'task-1',
        paths: [{ path: 'README.md', attribution: 'task-modified' }]
      }
    })
    expect(JSON.stringify(listed)).not.toContain('/Users/')
    expect(JSON.stringify(listed)).not.toContain('fingerprint')

    const missing = await fixture.invoke(TASK_INVOKE_CHANNELS.getChangeSet, {
      taskId: 'missing-task'
    })
    expect(missing).toMatchObject({ ok: false, error: { code: 'history-not-found' } })
    expect(fixture.gitReview.getChangeSet).toHaveBeenCalledTimes(1)

    const escaped = await fixture.invoke(TASK_INVOKE_CHANNELS.getFileDiff, {
      taskId: 'task-1',
      path: '../outside'
    })
    expect(escaped).toMatchObject({
      ok: true,
      value: { status: 'escaped', path: '../outside' }
    })
    expect(JSON.stringify(escaped)).not.toContain('/etc/')
  })

  it('Artifact IPC 只接受 taskId/artifactId，列表不含绝对路径', async () => {
    const fixture = createFixture()
    const listed = await fixture.invoke(TASK_INVOKE_CHANNELS.listArtifacts, { taskId: 'task-1' })
    expect(listed).toMatchObject({
      ok: true,
      value: [{ artifactId: 'art-1', location: { relativePath: 'README.md' } }]
    })
    expect(JSON.stringify(listed)).not.toContain('/Users/')
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.listArtifacts, {
        taskId: 'task-1',
        relativePath: 'README.md'
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })

    const content = await fixture.invoke(TASK_INVOKE_CHANNELS.getArtifactContent, {
      taskId: 'task-1',
      artifactId: 'art-1'
    })
    expect(content).toMatchObject({
      ok: true,
      value: { kind: 'markdown', markdown: '# hi' }
    })
  })

  it('跨 Task 的 command/diff 当 not-found，拒绝额外字段', async () => {
    const fixture = createFixture()
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.getFileDiff, {
        taskId: 'missing-task',
        path: 'README.md'
      })
    ).toMatchObject({ ok: false, error: { code: 'history-not-found' } })
    expect(fixture.gitReview.getFileDiff).not.toHaveBeenCalled()

    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.getFileDiff, {
        taskId: 'task-1',
        path: 'README.md',
        commandId: 'cmd-other-task'
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })

  it('恢复预览与执行只接受 taskId，未知 Task 当 not-found', async () => {
    const fixture = createFixture()
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.previewLatestTurnRestore, { taskId: 'task-1' })
    ).toMatchObject({ ok: true, value: { taskId: 'task-1' } })
    expect(fixture.gitReview.previewLatestTurnRestore).toHaveBeenCalledWith('task-1')
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.restoreLatestTurn, { taskId: 'missing-task' })
    ).toMatchObject({ ok: false, error: { code: 'history-not-found' } })
    expect(fixture.gitReview.restoreLatestTurn).not.toHaveBeenCalled()
    expect(
      await fixture.invoke(TASK_INVOKE_CHANNELS.restoreLatestTurn, {
        taskId: 'task-1',
        extra: true
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })
})
