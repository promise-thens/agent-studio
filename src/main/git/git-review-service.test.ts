import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandExecutionEvidence } from '../../shared/command'
import { deriveValidationResult } from '../../shared/command'
import { resolveProjectRoot, runReadOnlyGit } from '../project/project-root-resolver'
import { captureTaskChangeBaseline, TaskChangeBaselineStore } from './task-change-baseline'
import {
  deriveTaskValidations,
  GitReviewService,
  type GitReviewTaskIdentity
} from './git-review-service'
import { TurnChangeCheckpointStore } from './turn-change-checkpoint'

const execFile = promisify(execFileCallback)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('runReadOnlyGit diff 边界', () => {
  it('允许 git diff，拒绝 add/reset/checkout 和 diff --output', async () => {
    const repo = await createGitRepo()
    const canonical = await realpath(repo)
    const diff = await runReadOnlyGit(
      canonical,
      ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', 'README.md'],
      { allowedRoot: canonical }
    )
    expect(diff.ok).toBe(true)
    expect(
      await runReadOnlyGit(canonical, ['add', 'README.md'], { allowedRoot: canonical })
    ).toEqual(expect.objectContaining({ ok: false }))
    expect(
      await runReadOnlyGit(canonical, ['reset', '--hard', 'HEAD'], { allowedRoot: canonical })
    ).toEqual(expect.objectContaining({ ok: false }))
    expect(
      await runReadOnlyGit(canonical, ['checkout', '--', 'README.md'], { allowedRoot: canonical })
    ).toEqual(expect.objectContaining({ ok: false }))
    expect(
      await runReadOnlyGit(
        canonical,
        ['diff', '--output', join(canonical, 'out.patch'), 'HEAD', '--', 'README.md'],
        { allowedRoot: canonical }
      )
    ).toEqual(expect.objectContaining({ ok: false }))
  })
})

describe('GitReviewService 归因', () => {
  it('干净仓库 Task 改一个已跟踪文件 → task-modified', async () => {
    const repo = await createGitRepo()
    const fixture = await createReviewFixture(repo)
    await writeFile(join(repo, 'README.md'), 'agent-edit\n')

    const result = await fixture.service.getChangeSet('task-1')
    expect(result.paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'README.md', attribution: 'task-modified' })
      ])
    )
    expect(result.taskChangedCount).toBeGreaterThanOrEqual(1)
    expect(result.revertible).toEqual({
      kind: 'none',
      reason: expect.any(String)
    })
    expect(JSON.stringify(result)).not.toContain(await realpath(repo))
  })

  it('基线时已 dirty 的文件再改 → overlap-unknown，不是 task-modified', async () => {
    const repo = await createGitRepo()
    await writeFile(join(repo, 'README.md'), 'user-dirty\n')
    const fixture = await createReviewFixture(repo)
    await writeFile(join(repo, 'README.md'), 'user-dirty-then-agent\n')

    const result = await fixture.service.getChangeSet('task-1')
    const readme = result.paths.find((item) => item.path === 'README.md')
    expect(readme?.attribution).toBe('overlap-unknown')
    expect(readme?.attribution).not.toBe('task-modified')
    expect(result.unknownCount).toBeGreaterThanOrEqual(1)
    expect(result.revertible).toMatchObject({ kind: 'none' })
  })

  it('新增 untracked → task-added；diff status untracked 或有限 diff', async () => {
    const repo = await createGitRepo()
    const fixture = await createReviewFixture(repo)
    await writeFile(join(repo, 'notes.txt'), 'new-notes\n')

    const result = await fixture.service.getChangeSet('task-1')
    expect(result.paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'notes.txt',
          attribution: 'task-added',
          omitted: 'untracked'
        })
      ])
    )
    const diff = await fixture.service.getFileDiff('task-1', 'notes.txt')
    expect(diff.status).toBe('untracked')
    expect(diff.unifiedDiff).toContain('notes.txt')
    expect(diff.unifiedDiff).toContain('new-notes')
    expect(JSON.stringify(diff)).not.toContain(await realpath(repo))
  })

  it('删除基线时干净的 tracked → task-deleted', async () => {
    const repo = await createGitRepo()
    const fixture = await createReviewFixture(repo)
    await rm(join(repo, 'README.md'))

    const result = await fixture.service.getChangeSet('task-1')
    expect(result.paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'README.md', attribution: 'task-deleted' })
      ])
    )
    const diff = await fixture.service.getFileDiff('task-1', 'README.md')
    expect(diff.status).toBe('ok')
    expect(diff.unifiedDiff).toContain('README.md')
    expect(diff.unifiedDiff).toMatch(/^-hello/m)
  })

  it('二进制 / 超大 → omitted，diff status binary/too-large', async () => {
    const repo = await createGitRepo()
    const fixture = await createReviewFixture(repo)
    const uniqueText = 'UNIQUE_PAYLOAD_DO_NOT_PERSIST'
    await writeFile(
      join(repo, 'blob.bin'),
      Buffer.concat([Buffer.from('BIN'), Buffer.from([0, 1, 2]), Buffer.from('end')])
    )
    await writeFile(join(repo, 'huge.txt'), `${uniqueText}\n${'y'.repeat(300 * 1024)}`)

    const result = await fixture.service.getChangeSet('task-1')
    expect(result.paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'blob.bin', omitted: 'binary', attribution: 'task-added' }),
        expect.objectContaining({
          path: 'huge.txt',
          omitted: 'too-large',
          attribution: 'task-added'
        })
      ])
    )
    expect(JSON.stringify(result)).not.toContain(uniqueText)
    expect((await fixture.service.getFileDiff('task-1', 'blob.bin')).status).toBe('binary')
    expect((await fixture.service.getFileDiff('task-1', 'huge.txt')).status).toBe('too-large')
  })

  it('path ../outside 或符号链接逃逸 → escaped，不读外部文件', async () => {
    const repo = await createGitRepo()
    const outsideDir = await createTemporaryDirectory()
    const secret = 'OUTSIDE_SECRET_SHOULD_NOT_LEAK'
    await writeFile(join(outsideDir, 'secret.txt'), `${secret}\n`)
    await symlink(join(outsideDir, 'secret.txt'), join(repo, 'link.txt'))
    const fixture = await createReviewFixture(repo)

    const escaped = await fixture.service.getFileDiff('task-1', '../outside')
    expect(escaped.status).toBe('escaped')
    expect(JSON.stringify(escaped)).not.toContain(outsideDir)
    expect(JSON.stringify(escaped)).not.toContain(secret)

    const link = await fixture.service.getFileDiff('task-1', 'link.txt')
    expect(link.status).toBe('escaped')
    expect(JSON.stringify(link)).not.toContain(secret)
    expect(link.unifiedDiff).toBeUndefined()
  })

  it('已完成检查点后再改同一文件 → user-changed-after-task', async () => {
    const repo = await createGitRepo()
    const fixture = await createReviewFixture(repo)
    await fixture.service.recordTurnCheckpoint({
      ...fixture.identity,
      turnId: 'turn-1',
      phase: 'before'
    })
    await writeFile(join(repo, 'README.md'), 'agent-edit\n')
    await fixture.service.recordTurnCheckpoint({
      ...fixture.identity,
      turnId: 'turn-1',
      phase: 'after'
    })
    await writeFile(join(repo, 'README.md'), 'user-after-task\n')

    const result = await fixture.service.getChangeSet('task-1')
    expect(result.paths.find((item) => item.path === 'README.md')?.attribution).toBe(
      'user-changed-after-task'
    )
  })
})

describe('TurnChangeCheckpoint', () => {
  it('写入型 Turn before+after；kill after 前 → incomplete', async () => {
    const repo = await createGitRepo()
    const fixture = await createReviewFixture(repo)
    await fixture.service.recordTurnCheckpoint({
      ...fixture.identity,
      turnId: 'turn-1',
      phase: 'before'
    })
    await writeFile(join(repo, 'README.md'), 'in-progress\n')
    const incomplete = await fixture.checkpointStore.get('task-1', 'turn-1')
    expect(incomplete?.status).toBe('incomplete')
    expect(incomplete?.afterPaths).toBeUndefined()

    await fixture.service.recordTurnCheckpoint({
      ...fixture.identity,
      turnId: 'turn-1',
      phase: 'after'
    })
    const complete = await fixture.checkpointStore.get('task-1', 'turn-1')
    expect(complete?.status).toBe('complete')
    expect(complete?.afterPaths).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'README.md' })])
    )
    expect(complete?.affectedPaths).toContain('README.md')
    expect(complete?.previousCheckpointId).toBeUndefined()
  })

  it('无变化 Turn → no-change，并链式 previousCheckpointId', async () => {
    const repo = await createGitRepo()
    const fixture = await createReviewFixture(repo)
    await fixture.service.recordTurnCheckpoint({
      ...fixture.identity,
      turnId: 'turn-1',
      phase: 'before'
    })
    await writeFile(join(repo, 'README.md'), 'agent-edit\n')
    await fixture.service.recordTurnCheckpoint({
      ...fixture.identity,
      turnId: 'turn-1',
      phase: 'after'
    })

    await fixture.service.recordTurnCheckpoint({
      ...fixture.identity,
      turnId: 'turn-2',
      phase: 'before'
    })
    await fixture.service.recordTurnCheckpoint({
      ...fixture.identity,
      turnId: 'turn-2',
      phase: 'after'
    })
    const second = await fixture.checkpointStore.get('task-1', 'turn-2')
    expect(second?.status).toBe('no-change')
    expect(second?.previousCheckpointId).toBe('turn-1')
    expect(second?.affectedPaths).toEqual([])
  })
})

describe('deriveTaskValidations', () => {
  it('deriveValidationResult pass/fail/unknown from real evidence fixtures；incomplete list 不能 pass', () => {
    const passed = sampleEvidence({ commandId: 'cmd-pass', exitCode: 0, status: 'succeeded' })
    const failed = sampleEvidence({
      commandId: 'cmd-fail',
      exitCode: 2,
      status: 'failed',
      startedAt: '2026-08-22T10:00:02.000Z'
    })
    const unknown = sampleEvidence({
      commandId: 'cmd-unknown',
      source: 'runtime-tool',
      trustLevel: 'runtime-reported',
      status: 'unknown-exit',
      exitCode: undefined,
      startedAt: '2026-08-22T10:00:03.000Z'
    })

    expect(deriveValidationResult([passed], 'val_task-1_turn-1')?.outcome).toBe('pass')
    expect(deriveTaskValidations([failed])[0]).toMatchObject({
      outcome: 'fail',
      commandIds: ['cmd-fail']
    })
    expect(deriveTaskValidations([unknown])[0]).toMatchObject({
      outcome: 'unknown',
      commandIds: ['cmd-unknown']
    })
    expect(deriveTaskValidations([passed], { persistIncomplete: true })[0]).toMatchObject({
      outcome: 'unknown',
      reason: 'incomplete-list'
    })
    expect(deriveTaskValidations([passed, failed, unknown])[0]?.commandIds).toEqual([
      'cmd-pass',
      'cmd-fail',
      'cmd-unknown'
    ])
  })

  it('Changes 摘要只引用真实 commandId，不把 runtime-tool 说成 AppCommandRunner', async () => {
    const repo = await createGitRepo()
    const evidence = sampleEvidence({
      source: 'runtime-tool',
      trustLevel: 'runtime-reported',
      status: 'failed',
      exitCode: 1
    })
    const fixture = await createReviewFixture(repo, { evidence: [evidence] })
    const result = await fixture.service.getChangeSet('task-1')
    expect(result.validations).toEqual([
      expect.objectContaining({
        validationId: 'val_task-1_turn-1',
        commandIds: ['cmd-1'],
        outcome: 'fail'
      })
    ])
    expect(JSON.stringify(result.validations)).not.toContain('AppCommandRunner')
    expect(JSON.stringify(result.validations)).not.toContain('app-runner')
  })
})

function sampleEvidence(
  overrides: Partial<CommandExecutionEvidence> = {}
): CommandExecutionEvidence {
  return {
    commandId: 'cmd-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    environmentId: 'env-1',
    source: 'app-runner',
    displayCommand: 'pnpm test',
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

async function createReviewFixture(
  repo: string,
  options: { evidence?: CommandExecutionEvidence[] } = {}
): Promise<{
  service: GitReviewService
  identity: GitReviewTaskIdentity
  checkpointStore: TurnChangeCheckpointStore
}> {
  const canonical = await realpath(repo)
  const identity: GitReviewTaskIdentity = {
    taskId: 'task-1',
    projectId: 'project-1',
    environmentId: 'local:testenv',
    executionRoot: canonical
  }
  const baselineStore = new TaskChangeBaselineStore({ rootDir: await createTemporaryDirectory() })
  const checkpointStore = new TurnChangeCheckpointStore({
    rootDir: await createTemporaryDirectory()
  })
  const resolved = await resolveProjectRoot({ ...identity, environmentKind: 'local' })
  await baselineStore.put(await captureTaskChangeBaseline(resolved))
  const evidence = options.evidence ?? []
  const service = new GitReviewService({
    baselineStore,
    checkpointStore,
    getTaskIdentity: (taskId) => {
      if (taskId !== identity.taskId) throw new Error('未找到指定 Task 历史。')
      return identity
    },
    getProjectAvailability: async () => ({ state: 'available' }),
    listCommandEvidence: async (taskId) => evidence.filter((item) => item.taskId === taskId),
    now: () => '2026-08-22T12:00:00.000Z'
  })
  return { service, identity, checkpointStore }
}

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-studio-review-'))
  temporaryDirectories.push(path)
  return path
}

async function createGitRepo(): Promise<string> {
  const repo = await createTemporaryDirectory()
  await initGitRepo(repo)
  await writeTrackedCommit(repo, 'README.md', 'hello\n')
  return repo
}

async function initGitRepo(dir: string): Promise<void> {
  try {
    await runGit(dir, ['init', '-b', 'main'])
  } catch {
    await runGit(dir, ['init'])
  }
  await runGit(dir, ['config', 'user.email', 'review-test@example.test'])
  await runGit(dir, ['config', 'user.name', 'Review Test'])
  await runGit(dir, ['config', 'commit.gpgsign', 'false'])
}

async function writeTrackedCommit(dir: string, fileName: string, content: string): Promise<string> {
  await writeFile(join(dir, fileName), content)
  await runGit(dir, ['add', fileName])
  await runGit(dir, ['commit', '-m', `add ${fileName}`])
  return fileName
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0'
    }
  })
  return stdout.trim()
}
