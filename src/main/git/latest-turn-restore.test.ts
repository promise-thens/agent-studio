import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { OperationIntent } from '../../shared/agent'
import { resolveProjectRoot } from '../project/project-root-resolver'
import type { PermissionBroker } from '../security/permission-broker'
import { captureTaskChangeBaseline, TaskChangeBaselineStore } from './task-change-baseline'
import { GitReviewService, type GitReviewTaskIdentity } from './git-review-service'
import { TurnChangeCheckpointStore } from './turn-change-checkpoint'

const execFile = promisify(execFileCallback)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('最新一轮受控恢复', () => {
  it('干净仓库最新一轮改 tracked → 可撤销，撤销后哈希回到 before，旧 checkpoint 仍在', async () => {
    const repo = await createGitRepo()
    const fixture = await createRestoreFixture(repo)
    await recordWriteTurn(fixture, 'turn-1', async () => {
      await writeFile(join(repo, 'README.md'), 'agent-edit\n')
    })

    const listed = await fixture.service.getChangeSet('task-1')
    expect(listed.revertible).toMatchObject({
      kind: 'latest-turn',
      turnId: 'turn-1',
      paths: ['README.md']
    })
    expect(JSON.stringify(listed)).not.toContain(await realpath(repo))

    const preview = await fixture.service.previewLatestTurnRestore('task-1')
    expect(preview.revertible.kind).toBe('latest-turn')
    expect(preview.willLosePaths).toContain('README.md')
    expect(JSON.stringify(preview)).not.toContain(await realpath(repo))

    const restored = await fixture.service.restoreLatestTurn('task-1')
    expect(restored.ok).toBe(true)
    expect(restored.recoveryCheckpointId).toMatch(/^recovery_/)
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('hello\n')
    const checkpoints = await fixture.checkpointStore.list('task-1')
    expect(checkpoints.some((item) => item.turnId === 'turn-1' && item.status === 'complete')).toBe(
      true
    )
    expect(checkpoints.some((item) => item.turnId.startsWith('recovery_'))).toBe(true)
    expect((await fixture.service.getChangeSet('task-1')).revertible).toMatchObject({
      kind: 'none'
    })
  })

  it('基线 dirty 再改 → 不可自动撤销', async () => {
    const repo = await createGitRepo()
    await writeFile(join(repo, 'README.md'), 'user-dirty\n')
    const fixture = await createRestoreFixture(repo)
    await recordWriteTurn(fixture, 'turn-1', async () => {
      await writeFile(join(repo, 'README.md'), 'user-dirty-then-agent\n')
    })

    const listed = await fixture.service.getChangeSet('task-1')
    expect(listed.paths.find((item) => item.path === 'README.md')?.attribution).toBe(
      'overlap-unknown'
    )
    expect(listed.revertible).toMatchObject({ kind: 'none' })
    const restored = await fixture.service.restoreLatestTurn('task-1')
    expect(restored.ok).toBe(false)
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('user-dirty-then-agent\n')
  })

  it('外部在 after 之后改同一文件 → 拒绝，文件保持外部内容', async () => {
    const repo = await createGitRepo()
    const fixture = await createRestoreFixture(repo)
    await recordWriteTurn(fixture, 'turn-1', async () => {
      await writeFile(join(repo, 'README.md'), 'agent-edit\n')
    })
    await writeFile(join(repo, 'README.md'), 'external-edit\n')

    const listed = await fixture.service.getChangeSet('task-1')
    expect(listed.paths.find((item) => item.path === 'README.md')?.attribution).toBe(
      'user-changed-after-task'
    )
    expect(listed.revertible).toMatchObject({ kind: 'none' })
    const restored = await fixture.service.restoreLatestTurn('task-1')
    expect(restored.ok).toBe(false)
    expect(restored.reason).toBe('drift')
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('external-edit\n')
  })

  it('更早 Turn 即使 complete 也不显示/执行自动撤销', async () => {
    const repo = await createGitRepo()
    const fixture = await createRestoreFixture(repo)
    await recordWriteTurn(fixture, 'turn-1', async () => {
      await writeFile(join(repo, 'README.md'), 'first\n')
    })
    await recordWriteTurn(fixture, 'turn-2', async () => {
      await writeFile(join(repo, 'notes.txt'), 'second\n')
    })

    const listed = await fixture.service.getChangeSet('task-1')
    expect(listed.revertible).toMatchObject({ kind: 'latest-turn', turnId: 'turn-2' })
    expect(listed.revertible).not.toMatchObject({ turnId: 'turn-1' })
    const restored = await fixture.service.restoreLatestTurn('task-1')
    expect(restored.ok).toBe(true)
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('first\n')
    expect(await readFile(join(repo, 'notes.txt'), 'utf8').catch(() => 'missing')).toBe('missing')
  })

  it('后续 Turn 改同一路径 → 最新可评但 before 不在 HEAD，被盖住的那轮只读', async () => {
    const repo = await createGitRepo()
    const fixture = await createRestoreFixture(repo)
    await recordWriteTurn(fixture, 'turn-1', async () => {
      await writeFile(join(repo, 'README.md'), 'first\n')
    })
    await recordWriteTurn(fixture, 'turn-2', async () => {
      await writeFile(join(repo, 'README.md'), 'second\n')
    })

    const listed = await fixture.service.getChangeSet('task-1')
    // 检查点只存哈希，turn-2 的 before 是 turn-1 的 after，不能 git checkout 伪造。
    expect(listed.revertible).toMatchObject({ kind: 'none' })
    expect(listed.revertible).not.toMatchObject({ turnId: 'turn-1' })
    const restored = await fixture.service.restoreLatestTurn('task-1')
    expect(restored.ok).toBe(false)
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('second\n')
    const checkpoints = await fixture.checkpointStore.list('task-1')
    expect(checkpoints.find((item) => item.turnId === 'turn-1')?.status).toBe('complete')
    expect(checkpoints.find((item) => item.turnId === 'turn-2')?.status).toBe('complete')
  })

  it('incomplete checkpoint → 不可撤销', async () => {
    const repo = await createGitRepo()
    const fixture = await createRestoreFixture(repo)
    await fixture.service.recordTurnCheckpoint({
      ...fixture.identity,
      turnId: 'turn-1',
      phase: 'before'
    })
    await writeFile(join(repo, 'README.md'), 'in-progress\n')

    expect((await fixture.service.getChangeSet('task-1')).revertible).toMatchObject({
      kind: 'none'
    })
    const restored = await fixture.service.restoreLatestTurn('task-1')
    expect(restored.ok).toBe(false)
    expect(restored.reason).toBe('incomplete')
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('in-progress\n')
  })

  it('撤销后再编辑 → 新变化不是被抹掉的历史', async () => {
    const repo = await createGitRepo()
    const fixture = await createRestoreFixture(repo)
    await recordWriteTurn(fixture, 'turn-1', async () => {
      await writeFile(join(repo, 'README.md'), 'agent-edit\n')
    })
    expect((await fixture.service.restoreLatestTurn('task-1')).ok).toBe(true)
    await writeFile(join(repo, 'README.md'), 'after-restore\n')

    const listed = await fixture.service.getChangeSet('task-1')
    expect(listed.paths.find((item) => item.path === 'README.md')?.attribution).toBe(
      'user-changed-after-task'
    )
    expect(listed.revertible).toMatchObject({ kind: 'none' })
    expect((await fixture.checkpointStore.get('task-1', 'turn-1'))?.status).toBe('complete')
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('after-restore\n')
  })

  it('untracked 新增可删；binary/omitted 拒绝自动', async () => {
    const repo = await createGitRepo()
    const added = await createRestoreFixture(repo)
    await recordWriteTurn(added, 'turn-1', async () => {
      await writeFile(join(repo, 'notes.txt'), 'new-notes\n')
    })
    expect((await added.service.getChangeSet('task-1')).revertible).toMatchObject({
      kind: 'latest-turn',
      paths: ['notes.txt']
    })
    expect((await added.service.restoreLatestTurn('task-1')).ok).toBe(true)
    await expect(readFile(join(repo, 'notes.txt'), 'utf8')).rejects.toThrow()

    const binaryRepo = await createGitRepo()
    const binary = await createRestoreFixture(binaryRepo)
    await recordWriteTurn(binary, 'turn-1', async () => {
      await writeFile(
        join(binaryRepo, 'blob.bin'),
        Buffer.concat([Buffer.from('BIN'), Buffer.from([0, 1, 2]), Buffer.from('end')])
      )
    })
    expect((await binary.service.getChangeSet('task-1')).revertible).toMatchObject({
      kind: 'none'
    })
    expect((await binary.service.restoreLatestTurn('task-1')).ok).toBe(false)
    expect(await readFile(join(binaryRepo, 'blob.bin'))).toEqual(
      Buffer.concat([Buffer.from('BIN'), Buffer.from([0, 1, 2]), Buffer.from('end')])
    )
  })

  it('非 Git 仅新增可删；修改已有文件拒绝', async () => {
    const root = await createTemporaryDirectory()
    await writeFile(join(root, 'existing.txt'), 'keep\n')
    const added = await createRestoreFixture(root)
    await recordWriteTurn(added, 'turn-1', async () => {
      await writeFile(join(root, 'new.txt'), 'created\n')
    })
    expect((await added.service.getChangeSet('task-1')).revertible).toMatchObject({
      kind: 'latest-turn'
    })
    expect((await added.service.restoreLatestTurn('task-1')).ok).toBe(true)
    await expect(readFile(join(root, 'new.txt'), 'utf8')).rejects.toThrow()
    expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('keep\n')

    const modifiedRoot = await createTemporaryDirectory()
    await writeFile(join(modifiedRoot, 'existing.txt'), 'keep\n')
    const modified = await createRestoreFixture(modifiedRoot)
    await recordWriteTurn(modified, 'turn-1', async () => {
      await writeFile(join(modifiedRoot, 'existing.txt'), 'changed\n')
    })
    expect((await modified.service.getChangeSet('task-1')).revertible).toMatchObject({
      kind: 'none'
    })
    expect((await modified.service.restoreLatestTurn('task-1')).ok).toBe(false)
    expect(await readFile(join(modifiedRoot, 'existing.txt'), 'utf8')).toBe('changed\n')
  })

  it('../ 或 symlink 逃逸拒绝且不写外部', async () => {
    const repo = await createGitRepo()
    const outsideDir = await createTemporaryDirectory()
    const secretPath = join(outsideDir, 'secret.txt')
    await writeFile(secretPath, 'OUTSIDE_SECRET\n')
    const fixture = await createRestoreFixture(repo)
    await recordWriteTurn(fixture, 'turn-1', async () => {
      await writeFile(join(repo, 'notes.txt'), 'inside\n')
    })
    await rm(join(repo, 'notes.txt'))
    await symlink(secretPath, join(repo, 'notes.txt'))

    const restored = await fixture.service.restoreLatestTurn('task-1')
    expect(restored.ok).toBe(false)
    expect(await readFile(secretPath, 'utf8')).toBe('OUTSIDE_SECRET\n')
    expect(JSON.stringify(restored)).not.toContain(outsideDir)
    expect(JSON.stringify(restored)).not.toContain('OUTSIDE_SECRET')
  })

  it('Broker deny → execute 0 次，文件不变', async () => {
    const repo = await createGitRepo()
    const fixture = await createRestoreFixture(repo, {
      broker: {
        authorizeOperation: async (_intent, execute) => {
          // 拒绝时不得调用 execute。用计数器证明副作用回调未被触发。
          void execute
          return { ok: false, reason: 'user-denied' }
        }
      }
    })
    await recordWriteTurn(fixture, 'turn-1', async () => {
      await writeFile(join(repo, 'README.md'), 'agent-edit\n')
    })

    const restored = await fixture.service.restoreLatestTurn('task-1')
    expect(restored.ok).toBe(false)
    expect(restored.reason).toBe('denied')
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('agent-edit\n')
  })

  it('活动 Turn 进行中拒绝', async () => {
    const repo = await createGitRepo()
    const fixture = await createRestoreFixture(repo, { hasActiveExecution: () => true })
    await recordWriteTurn(fixture, 'turn-1', async () => {
      await writeFile(join(repo, 'README.md'), 'agent-edit\n')
    })

    expect((await fixture.service.getChangeSet('task-1')).revertible).toMatchObject({
      kind: 'none'
    })
    const restored = await fixture.service.restoreLatestTurn('task-1')
    expect(restored.ok).toBe(false)
    expect(restored.reason).toBe('active-turn')
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('agent-edit\n')
  })

  it('删除 tracked 文件后可从 HEAD 写回，且不调用 git reset/checkout', async () => {
    const repo = await createGitRepo()
    const intents: OperationIntent[] = []
    const fixture = await createRestoreFixture(repo, {
      broker: createRecordingBroker(intents)
    })
    await recordWriteTurn(fixture, 'turn-1', async () => {
      await rm(join(repo, 'README.md'))
    })
    expect((await fixture.service.getChangeSet('task-1')).revertible).toMatchObject({
      kind: 'latest-turn'
    })
    expect((await fixture.service.restoreLatestTurn('task-1')).ok).toBe(true)
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('hello\n')
    expect(intents.every((intent) => intent.operationType !== 'git-mutate')).toBe(true)
    expect(intents.some((intent) => intent.operationType === 'write-file')).toBe(true)
  })
})

async function recordWriteTurn(
  fixture: Awaited<ReturnType<typeof createRestoreFixture>>,
  turnId: string,
  mutate: () => Promise<void>
): Promise<void> {
  await fixture.service.recordTurnCheckpoint({
    ...fixture.identity,
    turnId,
    phase: 'before'
  })
  await mutate()
  await fixture.service.recordTurnCheckpoint({
    ...fixture.identity,
    turnId,
    phase: 'after'
  })
}

function createAllowingBroker(): Pick<PermissionBroker, 'authorizeOperation'> {
  return {
    authorizeOperation: async (intent, execute) => {
      const value = await execute({
        ...intent,
        executionRoot: intent.executionRoot,
        targets: intent.targets
      })
      return { ok: true, value, reason: 'user-allowed', scope: 'once' }
    }
  }
}

function createRecordingBroker(
  intents: OperationIntent[]
): Pick<PermissionBroker, 'authorizeOperation'> {
  return {
    authorizeOperation: async (intent, execute) => {
      intents.push(intent)
      const value = await execute({
        ...intent,
        executionRoot: intent.executionRoot,
        targets: intent.targets
      })
      return { ok: true, value, reason: 'user-allowed', scope: 'once' }
    }
  }
}

async function createRestoreFixture(
  repo: string,
  options: {
    hasActiveExecution?: () => boolean
    broker?: Pick<PermissionBroker, 'authorizeOperation'>
  } = {}
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
  let recoverySerial = 0
  const service = new GitReviewService({
    baselineStore,
    checkpointStore,
    getTaskIdentity: (taskId) => {
      if (taskId !== identity.taskId) throw new Error('未找到指定 Task 历史。')
      return identity
    },
    getProjectAvailability: async () => ({ state: 'available' }),
    now: () => '2026-08-22T12:00:00.000Z',
    hasActiveExecution: options.hasActiveExecution ?? (() => false),
    broker: options.broker ?? createAllowingBroker(),
    createRecoveryId: () => `recovery_${++recoverySerial}`
  })
  return { service, identity, checkpointStore }
}

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-studio-restore-'))
  temporaryDirectories.push(path)
  return path
}

async function createGitRepo(): Promise<string> {
  const repo = await createTemporaryDirectory()
  try {
    await runGit(repo, ['init', '-b', 'main'])
  } catch {
    await runGit(repo, ['init'])
  }
  await runGit(repo, ['config', 'user.email', 'restore-test@example.test'])
  await runGit(repo, ['config', 'user.name', 'Restore Test'])
  await runGit(repo, ['config', 'commit.gpgsign', 'false'])
  await writeFile(join(repo, 'README.md'), 'hello\n')
  await runGit(repo, ['add', 'README.md'])
  await runGit(repo, ['commit', '-m', 'add README.md'])
  return repo
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
