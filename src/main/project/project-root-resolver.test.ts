import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveProjectRoot } from './project-root-resolver'

const execFile = promisify(execFileCallback)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('resolveProjectRoot', () => {
  it('本地干净仓库：gitRoot 等于 execution root，并返回 HEAD oid', async () => {
    const repo = await createGitRepo()
    const canonical = await realpath(repo)
    const resolved = await resolveProjectRoot(identity(canonical))

    expect(resolved.executionRoot).toBe(canonical)
    expect(resolved.git).toMatchObject({ kind: 'git', nested: false, gitRoot: canonical })
    if (resolved.git.kind !== 'git') throw new Error('期望 git 仓库。')
    expect(resolved.git.head.oid).toMatch(/^[0-9a-f]{40,64}$/)
    expect(resolved.git.head.detached).toBe(false)
    expect(resolved.git.head.branch).toBeTruthy()
  })

  it('非 Git 目录：gitPresence 为 non-git，不伪造 commit', async () => {
    const root = await createTemporaryDirectory()
    const resolved = await resolveProjectRoot(identity(await realpath(root)))

    expect(resolved.git).toEqual({ kind: 'non-git', reason: 'no-repository' })
  })

  it('子目录本身不是 git、父目录是 git：parent-escaped，不跟随父仓库', async () => {
    const parent = await createGitRepo()
    const child = join(parent, 'subdir')
    await mkdir(child)
    const resolved = await resolveProjectRoot(identity(await realpath(child)))

    expect(resolved.git).toEqual({ kind: 'non-git', reason: 'parent-escaped' })
    expect(JSON.stringify(resolved)).not.toContain((await realpath(parent)) + '/.git')
  })

  it('execution root 内嵌套 .git：nested=true，gitRoot 是内层仓库且仍在 execution root 内', async () => {
    const root = await createTemporaryDirectory()
    const inner = join(root, 'inner')
    await mkdir(inner)
    await initGitRepo(inner)
    await writeTrackedCommit(inner, 'nested.md', 'nested\n')
    const canonicalRoot = await realpath(root)
    const canonicalInner = await realpath(inner)
    const resolved = await resolveProjectRoot(identity(canonicalRoot))

    expect(resolved.git).toMatchObject({
      kind: 'git',
      nested: true,
      gitRoot: canonicalInner
    })
    if (resolved.git.kind !== 'git') throw new Error('期望嵌套 git 仓库。')
    expect(canonicalInner.startsWith(canonicalRoot)).toBe(true)
    expect(resolved.git.gitRoot).not.toBe(canonicalRoot)
  })

  it('execution root 缺失时返回 invalid root-missing', async () => {
    const missing = join(await createTemporaryDirectory(), 'gone')
    const resolved = await resolveProjectRoot(identity(missing))
    expect(resolved.git).toEqual({ kind: 'invalid', reason: 'root-missing' })
  })

  it('execution root 不是目录时返回 invalid not-directory', async () => {
    const root = await createTemporaryDirectory()
    const file = join(root, 'file.txt')
    await writeFile(file, 'not-a-dir\n')
    const resolved = await resolveProjectRoot(identity(file))
    expect(resolved.git).toEqual({ kind: 'invalid', reason: 'not-directory' })
  })

  it('git 可执行失败时返回 non-git git-unavailable', async () => {
    const root = await createTemporaryDirectory()
    const resolved = await resolveProjectRoot({
      ...identity(await realpath(root)),
      gitExecutable: join(root, 'no-such-git-binary')
    })
    expect(resolved.git).toEqual({ kind: 'non-git', reason: 'git-unavailable' })
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

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-studio-root-'))
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
