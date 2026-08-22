import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectAvailability } from '../../shared/task-history'
import { resolveProjectRoot } from '../project/project-root-resolver'
import {
  captureTaskChangeBaseline,
  createEnsureTaskChangeBaseline,
  evaluateBaselineValidity,
  TaskChangeBaselineStore
} from './task-change-baseline'

const execFile = promisify(execFileCallback)
const temporaryDirectories: string[] = []
const available: ProjectAvailability = { state: 'available' }

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('captureTaskChangeBaseline', () => {
  it('干净仓库：gitRoot 等于 execution root，HEAD oid 写入 baseCommit，preExistingPaths 为空', async () => {
    const repo = await createGitRepo()
    const canonical = await realpath(repo)
    const resolved = await resolveProjectRoot(identity(canonical))
    const baseline = await captureTaskChangeBaseline(resolved, {
      now: () => '2026-08-22T10:00:00.000Z'
    })

    expect(baseline.status).toBe('captured')
    expect(baseline.gitPresence).toBe('git')
    expect(baseline.executionRoot).toBe(canonical)
    expect(baseline.gitRoot).toBe(canonical)
    expect(baseline.baseCommit).toMatch(/^[0-9a-f]{40,64}$/)
    expect(baseline.preExistingPaths).toEqual([])
    expect(baseline.schemaVersion).toBe(1)
  })

  it('脏仓库：已修改 tracked 与 untracked 进入 preExistingPaths，并带 contentHash', async () => {
    const repo = await createGitRepo()
    await writeFile(join(repo, 'README.md'), 'dirty-tracked\n')
    await writeFile(join(repo, 'notes.txt'), 'untracked-notes\n')
    const canonical = await realpath(repo)
    const resolved = await resolveProjectRoot(identity(canonical))
    const baseline = await captureTaskChangeBaseline(resolved)

    expect(baseline.preExistingPaths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'README.md',
          kind: 'tracked',
          contentHash: sha256('dirty-tracked\n')
        }),
        expect.objectContaining({
          path: 'notes.txt',
          kind: 'untracked',
          contentHash: sha256('untracked-notes\n')
        })
      ])
    )
    expect(JSON.stringify(baseline.preExistingPaths)).not.toContain('dirty-tracked')
    expect(JSON.stringify(baseline.preExistingPaths)).not.toContain('untracked-notes')
  })

  it('非 Git 目录：gitPresence=non-git，不伪造 commit，但仍记录有限已有文件', async () => {
    const root = await createTemporaryDirectory()
    await writeFile(join(root, 'notes.txt'), 'already-there\n')
    const resolved = await resolveProjectRoot(identity(await realpath(root)))
    const baseline = await captureTaskChangeBaseline(resolved)

    expect(baseline.gitPresence).toBe('non-git')
    expect(baseline.status).toBe('captured')
    expect(baseline.baseCommit).toBeUndefined()
    expect(baseline.gitRoot).toBeUndefined()
    expect(baseline.preExistingPaths).toEqual([
      expect.objectContaining({
        path: 'notes.txt',
        kind: 'untracked',
        contentHash: sha256('already-there\n')
      })
    ])
  })

  it('超大或二进制文件只记 omitted，不把文件正文写入 JSON', async () => {
    const repo = await createGitRepo()
    const uniqueText = 'UNIQUE_PAYLOAD_DO_NOT_PERSIST'
    const binary = Buffer.concat([Buffer.from('BIN'), Buffer.from([0, 1, 2]), Buffer.from('end')])
    await writeFile(join(repo, 'blob.bin'), binary)
    await writeFile(join(repo, 'huge.txt'), `${uniqueText}\n${'y'.repeat(8 * 1024)}`)
    const resolved = await resolveProjectRoot(identity(await realpath(repo)))
    const baseline = await captureTaskChangeBaseline(resolved, { maxHashFileBytes: 64 })

    expect(baseline.preExistingPaths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'blob.bin', kind: 'untracked', omitted: 'binary' }),
        expect.objectContaining({ path: 'huge.txt', kind: 'untracked', omitted: 'too-large' })
      ])
    )
    expect(
      baseline.preExistingPaths.find((item) => item.path === 'blob.bin')?.contentHash
    ).toBeUndefined()
    expect(JSON.stringify(baseline)).not.toContain(uniqueText)
  })

  it('路径数量超限时截断并标记 omitted=limit', async () => {
    const repo = await createGitRepo()
    await writeFile(join(repo, 'a.txt'), 'a\n')
    await writeFile(join(repo, 'b.txt'), 'b\n')
    await writeFile(join(repo, 'c.txt'), 'c\n')
    const resolved = await resolveProjectRoot(identity(await realpath(repo)))
    const baseline = await captureTaskChangeBaseline(resolved, { maxPaths: 1 })

    expect(baseline.truncated).toBe(true)
    expect(baseline.preExistingPaths.length).toBeGreaterThanOrEqual(1)
    expect(baseline.preExistingPaths.some((item) => item.omitted === 'limit')).toBe(true)
  })

  it('git 可执行失败：baseline status=unavailable，不抛出', async () => {
    const root = await createTemporaryDirectory()
    const resolved = await resolveProjectRoot({
      ...identity(await realpath(root)),
      gitExecutable: join(root, 'no-such-git-binary')
    })
    const baseline = await captureTaskChangeBaseline(resolved, {
      gitExecutable: join(root, 'no-such-git-binary')
    })
    expect(baseline.status).toBe('unavailable')
    expect(baseline.gitPresence).toBe('non-git')
    expect(baseline.baseCommit).toBeUndefined()
  })

  it('git status 失败不得写成 captured 空路径', async () => {
    const repo = await createGitRepo()
    await writeFile(join(repo, 'dirty.txt'), 'keep-me\n')
    const stub = await writeGitStatusFailureStub()
    const resolved = await resolveProjectRoot({
      ...identity(await realpath(repo)),
      gitExecutable: stub
    })
    expect(resolved.git.kind).toBe('git')
    const baseline = await captureTaskChangeBaseline(resolved, { gitExecutable: stub })
    expect(baseline.status).toBe('unavailable')
    expect(baseline.preExistingPaths).toEqual([])
    expect(baseline.gitPresence).toBe('git')
    expect(baseline.baseCommit).toMatch(/^[0-9a-f]{40,64}$/)
  })

  it('符号链接逃出 execution root 时不得哈希目标内容', async () => {
    const repo = await createGitRepo()
    const outside = await createTemporaryDirectory()
    const secret = 'SECRET_OUTSIDE_PAYLOAD_DO_NOT_HASH'
    await writeFile(join(outside, 'secret.txt'), `${secret}\n`)
    await symlink(join(outside, 'secret.txt'), join(repo, 'escape.txt'))
    const resolved = await resolveProjectRoot(identity(await realpath(repo)))
    const baseline = await captureTaskChangeBaseline(resolved)
    expect(JSON.stringify(baseline)).not.toContain(secret)
    expect(baseline.preExistingPaths.some((item) => item.path === 'escape.txt')).toBe(false)
  })
})

describe('evaluateBaselineValidity 与 Store', () => {
  it('checkout 切分支会使基线 head-changed，store 不自动覆盖为新 HEAD', async () => {
    const repo = await createGitRepo()
    const canonical = await realpath(repo)
    const store = new TaskChangeBaselineStore({ rootDir: await createTemporaryDirectory() })
    const first = await resolveProjectRoot(identity(canonical))
    const baseline = await captureTaskChangeBaseline(first, {
      now: () => '2026-08-22T10:00:00.000Z'
    })
    await store.put(baseline)
    const originalHead = baseline.baseCommit
    expect(originalHead).toBeTruthy()

    await runGit(repo, ['checkout', '-b', 'other'])
    const current = await resolveProjectRoot(identity(canonical))
    await expect(evaluateBaselineValidity(baseline, current, available)).resolves.toEqual({
      valid: false,
      reason: 'head-changed'
    })

    await store.put({
      ...baseline,
      status: 'invalid',
      invalidReason: 'head-changed'
    })
    const recapture = await captureTaskChangeBaseline(current, {
      now: () => '2026-08-22T11:00:00.000Z'
    })
    expect(recapture.headBranch).toBe('other')
    const stored = await store.put(recapture)
    expect(stored.status).toBe('invalid')
    expect(stored.baseCommit).toBe(originalHead)
    expect(stored.headBranch).not.toBe('other')
    expect(stored.capturedAt).toBe('2026-08-22T10:00:00.000Z')
  })

  it('同分支新 commit 不使基线失效', async () => {
    const repo = await createGitRepo()
    const canonical = await realpath(repo)
    const baseline = await captureTaskChangeBaseline(await resolveProjectRoot(identity(canonical)))
    await writeTrackedCommit(repo, 'next.md', 'second\n')
    const current = await resolveProjectRoot(identity(canonical))
    expect(current.git.kind === 'git' && current.git.head.oid).not.toBe(baseline.baseCommit)
    await expect(evaluateBaselineValidity(baseline, current, available)).resolves.toEqual({
      valid: true
    })
  })

  it('execution root 换成别的路径或删除：path-replaced 或 root-missing', async () => {
    const repo = await createGitRepo()
    const canonical = await realpath(repo)
    const baseline = await captureTaskChangeBaseline(await resolveProjectRoot(identity(canonical)))

    const other = await createTemporaryDirectory()
    const moved = await resolveProjectRoot(identity(await realpath(other)))
    await expect(evaluateBaselineValidity(baseline, moved, available)).resolves.toEqual({
      valid: false,
      reason: 'path-replaced'
    })

    await rm(repo, { recursive: true, force: true })
    const missing = await resolveProjectRoot(identity(canonical))
    await expect(evaluateBaselineValidity(baseline, missing, available)).resolves.toEqual({
      valid: false,
      reason: 'root-missing'
    })

    await mkdir(canonical)
    await initGitRepo(canonical)
    await writeTrackedCommit(canonical, 'README.md', 'replaced\n')
    const replaced = await resolveProjectRoot(identity(canonical))
    await expect(evaluateBaselineValidity(baseline, replaced, available)).resolves.toEqual({
      valid: false,
      reason: 'path-replaced'
    })
  })

  it('Project availability unavailable：project-unavailable', async () => {
    const repo = await createGitRepo()
    const resolved = await resolveProjectRoot(identity(await realpath(repo)))
    const baseline = await captureTaskChangeBaseline(resolved)
    await expect(
      evaluateBaselineValidity(baseline, resolved, {
        state: 'unavailable',
        message: '目录已移动、不可访问或权限已撤回。'
      })
    ).resolves.toEqual({ valid: false, reason: 'project-unavailable' })
  })

  it('已存在且仍 valid 的 baseline 不会被 put 覆盖', async () => {
    const repo = await createGitRepo()
    const store = new TaskChangeBaselineStore({ rootDir: await createTemporaryDirectory() })
    const resolved = await resolveProjectRoot(identity(await realpath(repo)))
    const first = await captureTaskChangeBaseline(resolved, {
      now: () => '2026-08-22T10:00:00.000Z'
    })
    await store.put(first)
    const second = await captureTaskChangeBaseline(resolved, {
      now: () => '2026-08-22T11:00:00.000Z'
    })
    const stored = await store.put(second)
    expect(stored.capturedAt).toBe('2026-08-22T10:00:00.000Z')
  })
})

describe('createEnsureTaskChangeBaseline', () => {
  it('首次捕获，再次 start 不 recapture；失效后也不自动重建', async () => {
    const repo = await createGitRepo()
    const canonical = await realpath(repo)
    const store = new TaskChangeBaselineStore({ rootDir: await createTemporaryDirectory() })
    const ensure = createEnsureTaskChangeBaseline({
      store,
      getProjectAvailability: async () => available,
      now: () => '2026-08-22T10:00:00.000Z'
    })
    const input = {
      taskId: 'task-1',
      projectId: 'project-1',
      environmentId: 'local:testenv',
      executionRoot: canonical
    }

    await ensure(input)
    const first = await store.get(input.taskId, input.environmentId)
    expect(first?.status).toBe('captured')
    const originalHead = first?.baseCommit

    await ensure({ ...input })
    const reused = await store.get(input.taskId, input.environmentId)
    expect(reused?.capturedAt).toBe(first?.capturedAt)
    expect(reused?.baseCommit).toBe(originalHead)

    await writeTrackedCommit(repo, 'later.md', 'later\n')
    await ensure({ ...input })
    const stillValid = await store.get(input.taskId, input.environmentId)
    expect(stillValid?.status).toBe('captured')
    expect(stillValid?.baseCommit).toBe(originalHead)

    await runGit(repo, ['checkout', '-b', 'other'])
    await ensure({ ...input })
    const invalid = await store.get(input.taskId, input.environmentId)
    expect(invalid).toMatchObject({ status: 'invalid', invalidReason: 'head-changed' })
    expect(invalid?.baseCommit).toBe(originalHead)

    await ensure({ ...input })
    const stillInvalid = await store.get(input.taskId, input.environmentId)
    expect(stillInvalid?.status).toBe('invalid')
    expect(stillInvalid?.baseCommit).toBe(originalHead)
    expect(stillInvalid?.capturedAt).toBe(first?.capturedAt)
  })
})

function identity(executionRoot: string): {
  taskId: string
  projectId: string
  environmentId: string
  environmentKind: 'local'
  executionRoot: string
} {
  return {
    taskId: 'task-1',
    projectId: 'project-1',
    environmentId: 'local:testenv',
    environmentKind: 'local' as const,
    executionRoot
  }
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-studio-baseline-'))
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
  await runGit(dir, ['config', 'user.email', 'baseline-test@example.test'])
  await runGit(dir, ['config', 'user.name', 'Baseline Test'])
  await runGit(dir, ['config', 'commit.gpgsign', 'false'])
}

async function writeTrackedCommit(dir: string, fileName: string, content: string): Promise<void> {
  await writeFile(join(dir, fileName), content)
  await runGit(dir, ['add', fileName])
  await runGit(dir, ['commit', '-m', `add ${fileName}`])
}

async function writeGitStatusFailureStub(): Promise<string> {
  const dir = await createTemporaryDirectory()
  const stub = join(dir, 'git-stub.mjs')
  await writeFile(
    stub,
    [
      '#!/usr/bin/env node',
      "import { spawnSync } from 'node:child_process'",
      'const args = process.argv.slice(2)',
      'if (args.includes("status")) process.exit(128)',
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
