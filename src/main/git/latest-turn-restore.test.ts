import { execFile as execFileCallback } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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

  it('git show 失败不得当成文件本不存在而去删除', async () => {
    const repo = await createGitRepo()
    const stub = await writeGitShowFailureStub()
    const fixture = await createRestoreFixture(repo, { gitExecutable: stub })
    await recordWriteTurn(fixture, 'turn-1', async () => {
      await writeFile(join(repo, 'README.md'), 'agent-edit\n')
    })
    expect((await fixture.service.getChangeSet('task-1')).revertible).toMatchObject({
      kind: 'none'
    })
    const restored = await fixture.service.restoreLatestTurn('task-1')
    expect(restored.ok).toBe(false)
    expect(restored.reason).toBe('not-recoverable')
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('agent-edit\n')
  })

  it('git mv 重命名不可自动撤销，不得只删 dest', async () => {
    const repo = await createGitRepo()
    const fixture = await createRestoreFixture(repo)
    await recordWriteTurn(fixture, 'turn-1', async () => {
      await runGit(repo, ['mv', 'README.md', 'NOTES.md'])
    })
    expect((await fixture.service.getChangeSet('task-1')).revertible).toMatchObject({
      kind: 'none'
    })
    const restored = await fixture.service.restoreLatestTurn('task-1')
    expect(restored.ok).toBe(false)
    expect(restored.reason).toBe('not-recoverable')
    expect(await readFile(join(repo, 'NOTES.md'), 'utf8')).toBe('hello\n')
    await expect(readFile(join(repo, 'README.md'), 'utf8')).rejects.toThrow()
  })

  it('嵌套仓库恢复只写 git root 内路径，不改外部文件', async () => {
    const root = await createTemporaryDirectory()
    await writeFile(join(root, 'outside.txt'), 'OUTSIDE\n')
    const inner = join(root, 'nested')
    await mkdir(inner)
    await initGitRepo(inner)
    await writeFile(join(inner, 'file.txt'), 'hello\n')
    await runGit(inner, ['add', 'file.txt'])
    await runGit(inner, ['commit', '-m', 'add file.txt'])
    const fixture = await createRestoreFixture(root)
    await recordWriteTurn(fixture, 'turn-1', async () => {
      await writeFile(join(inner, 'file.txt'), 'agent-edit\n')
    })
    const listed = await fixture.service.getChangeSet('task-1')
    expect(listed.gitPresence).toBe('git')
    expect(listed.revertible).toMatchObject({ kind: 'latest-turn' })
    expect((await fixture.service.restoreLatestTurn('task-1')).ok).toBe(true)
    expect(await readFile(join(inner, 'file.txt'), 'utf8')).toBe('hello\n')
    expect(await readFile(join(root, 'outside.txt'), 'utf8')).toBe('OUTSIDE\n')
    expect(JSON.stringify(listed)).not.toContain('OUTSIDE')
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
    gitExecutable?: string
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
    createRecoveryId: () => `recovery_${++recoverySerial}`,
    ...(options.gitExecutable ? { gitExecutable: options.gitExecutable } : {})
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
  await initGitRepo(repo)
  await writeFile(join(repo, 'README.md'), 'hello\n')
  await runGit(repo, ['add', 'README.md'])
  await runGit(repo, ['commit', '-m', 'add README.md'])
  return repo
}

async function initGitRepo(dir: string): Promise<void> {
  try {
    await runGit(dir, ['init', '-b', 'main'])
  } catch {
    await runGit(dir, ['init'])
  }
  await runGit(dir, ['config', 'user.email', 'restore-test@example.test'])
  await runGit(dir, ['config', 'user.name', 'Restore Test'])
  await runGit(dir, ['config', 'commit.gpgsign', 'false'])
}

async function writeGitShowFailureStub(): Promise<string> {
  const dir = await createTemporaryDirectory()
  const stub = join(dir, 'git-stub.mjs')
  await writeFile(
    stub,
    [
      '#!/usr/bin/env node',
      "import { spawnSync } from 'node:child_process'",
      'const args = process.argv.slice(2)',
      'if (args.includes("show")) process.exit(1)',
      'const result = spawnSync("git", args, { encoding: "utf8", cwd: process.cwd(), env: process.env })',
      'if (result.stdout) process.stdout.write(result.stdout)',
      'if (result.stderr) process.stderr.write(result.stderr)',
      'process.exit(result.status ?? 1)'
    ].join('\n')
  )
  await chmod(stub, 0o755)
  return stub
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
