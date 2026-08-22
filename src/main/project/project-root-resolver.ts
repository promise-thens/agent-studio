import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { GitHeadState, ProjectGitPresence, ResolvedProjectRoot } from '../../shared/git-review'
import { buildCommandEnvironment } from '../command/command-environment'

const MAX_GIT_STDOUT_BYTES = 2 * 1024 * 1024
/** 只读 git 必须短超时，避免每一轮 start 被 15s 卡住。 */
export const DEFAULT_GIT_TIMEOUT_MS = 3_000
const NESTED_SCAN_MAX_DEPTH = 3
const NESTED_SCAN_MAX_DIRS = 64
const SKIP_NESTED_DIRECTORY_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.next',
  'target',
  'build',
  'coverage',
  '.cache'
])

export interface ResolveProjectRootInput {
  taskId: string
  projectId: string
  environmentId: string
  environmentKind?: 'local'
  executionRoot: string
  now?: () => string
  gitExecutable?: string
  sourceEnvironment?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export interface ReadOnlyGitOptions {
  gitExecutable?: string
  sourceEnvironment?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** 禁止 git 向该目录及其父级 chdir；用于挡住父仓库。 */
  ceilingDir?: string
  /** cwd 必须落在该 canonical root 内，防止只读查询逃逸。 */
  allowedRoot?: string
}

/**
 * 从 Task 环境引用解析 canonical execution root 与 Git 身份。
 * 父目录仓库一律视为 parent-escaped，绝不把父仓库当成 gitRoot。
 */
export async function resolveProjectRoot(
  input: ResolveProjectRootInput
): Promise<ResolvedProjectRoot> {
  const now = input.now ?? (() => new Date().toISOString())
  const identity = {
    taskId: input.taskId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    environmentKind: 'local' as const,
    resolvedAt: now()
  }
  const gitOptions: ReadOnlyGitOptions = {
    gitExecutable: input.gitExecutable,
    sourceEnvironment: input.sourceEnvironment,
    timeoutMs: input.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  }

  const canonical = await canonicalizeExecutionRoot(input.executionRoot)
  if (canonical.kind === 'invalid') {
    return {
      ...identity,
      executionRoot: safeDisplayRoot(input.executionRoot),
      git: { kind: 'invalid', reason: canonical.reason }
    }
  }

  const git = await detectGitPresence(canonical.path, {
    ...gitOptions,
    allowedRoot: canonical.path
  })
  return {
    ...identity,
    executionRoot: canonical.path,
    git,
    ...(canonical.fingerprint ? { rootFingerprint: canonical.fingerprint } : {})
  }
}

/**
 * 只读 git：固定可执行文件 + 参数数组 + cwd + 最小环境，不走 Shell，也不走 AppCommandRunner。
 * 写操作（add/commit/push/reset/stash/clean/merge）直接拒绝。
 */
export async function runReadOnlyGit(
  cwd: string,
  args: string[],
  options: ReadOnlyGitOptions = {}
): Promise<
  | { ok: true; stdout: string }
  | { ok: false; unavailable: boolean; stdout: string; exitCode?: number }
> {
  if (!isReadOnlyGitArgs(args)) {
    return { ok: false, unavailable: false, stdout: '' }
  }
  if (options.allowedRoot && !isPathInsideRoot(options.allowedRoot, cwd)) {
    return { ok: false, unavailable: false, stdout: '' }
  }

  const env = buildCommandEnvironment(options.sourceEnvironment ?? process.env)
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_CONFIG_NOSYSTEM = '1'
  if (options.ceilingDir) {
    env.GIT_CEILING_DIRECTORIES = options.ceilingDir
  }

  return await new Promise((resolveResult) => {
    execFile(
      options.gitExecutable ?? 'git',
      args,
      {
        cwd,
        env,
        timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_STDOUT_BYTES,
        windowsHide: true,
        encoding: 'utf8'
      },
      (error, stdout) => {
        if (!error) {
          resolveResult({ ok: true, stdout: String(stdout ?? '') })
          return
        }
        const exitCode =
          error && typeof error === 'object' && 'code' in error && typeof error.code === 'number'
            ? error.code
            : undefined
        resolveResult({
          ok: false,
          unavailable: isGitUnavailableError(error),
          stdout: String(stdout ?? ''),
          ...(exitCode !== undefined ? { exitCode } : {})
        })
      }
    )
  })
}

/**
 * 只读取 git blob 字节。与 runReadOnlyGit 共用只读参数白名单，禁止 reset/checkout。
 */
export async function runReadOnlyGitBytes(
  cwd: string,
  args: string[],
  options: ReadOnlyGitOptions = {}
): Promise<{ ok: true; stdout: Buffer } | { ok: false; unavailable: boolean; stdout: Buffer }> {
  if (!isReadOnlyGitArgs(args)) {
    return { ok: false, unavailable: false, stdout: Buffer.alloc(0) }
  }
  if (options.allowedRoot && !isPathInsideRoot(options.allowedRoot, cwd)) {
    return { ok: false, unavailable: false, stdout: Buffer.alloc(0) }
  }

  const env = buildCommandEnvironment(options.sourceEnvironment ?? process.env)
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_CONFIG_NOSYSTEM = '1'
  if (options.ceilingDir) {
    env.GIT_CEILING_DIRECTORIES = options.ceilingDir
  }

  return await new Promise((resolveResult) => {
    execFile(
      options.gitExecutable ?? 'git',
      args,
      {
        cwd,
        env,
        timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_STDOUT_BYTES,
        windowsHide: true,
        encoding: 'buffer'
      },
      (error, stdout) => {
        const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '')
        if (!error) {
          resolveResult({ ok: true, stdout: bytes })
          return
        }
        resolveResult({
          ok: false,
          unavailable: isGitUnavailableError(error),
          stdout: bytes
        })
      }
    )
  })
}

export function isPathInsideRoot(root: string, target: string): boolean {
  const comparedRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const comparedTarget = process.platform === 'win32' ? target.toLowerCase() : target
  const child = relative(comparedRoot, comparedTarget)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

export function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export function toPosixRelativePath(root: string, absolutePath: string): string | null {
  if (!isPathInsideRoot(root, absolutePath)) return null
  const relativePath = relative(root, absolutePath)
  if (!relativePath || relativePath === '.') return ''
  return relativePath.split(/[\\/]/u).join('/')
}

export function fingerprintStats(stats: { dev: number; ino: number }, realPath: string): string {
  return `${stats.dev}:${stats.ino}:${realPath}`
}

async function canonicalizeExecutionRoot(
  executionRoot: string
): Promise<
  | { kind: 'ok'; path: string; fingerprint: string }
  | { kind: 'invalid'; reason: 'root-missing' | 'not-directory' | 'escaped' | 'unavailable' }
> {
  if (typeof executionRoot !== 'string' || !executionRoot.trim() || executionRoot.includes('\0')) {
    return { kind: 'invalid', reason: 'escaped' }
  }
  if (!isAbsolute(executionRoot) || hasParentTraversal(executionRoot)) {
    return { kind: 'invalid', reason: 'escaped' }
  }
  try {
    const stats = await fs.stat(executionRoot)
    if (!stats.isDirectory()) return { kind: 'invalid', reason: 'not-directory' }
    const path = await fs.realpath(executionRoot)
    return { kind: 'ok', path, fingerprint: fingerprintStats(stats, path) }
  } catch (error) {
    if (isNotFound(error)) return { kind: 'invalid', reason: 'root-missing' }
    return { kind: 'invalid', reason: 'unavailable' }
  }
}

async function detectGitPresence(
  executionRoot: string,
  options: ReadOnlyGitOptions
): Promise<ProjectGitPresence> {
  const contained = await showToplevel(executionRoot, {
    ...options,
    ceilingDir: dirname(executionRoot)
  })
  if (contained.kind === 'unavailable') {
    return { kind: 'non-git', reason: 'git-unavailable' }
  }
  if (contained.kind === 'ok') {
    if (!isPathInsideRoot(executionRoot, contained.toplevel)) {
      return { kind: 'non-git', reason: 'parent-escaped' }
    }
    const nested = !sameCanonicalPath(contained.toplevel, executionRoot)
    const head = await readHeadState(contained.toplevel, options)
    return { kind: 'git', gitRoot: contained.toplevel, head, nested }
  }

  const unconstrained = await showToplevel(executionRoot, options)
  if (unconstrained.kind === 'unavailable') {
    return { kind: 'non-git', reason: 'git-unavailable' }
  }
  if (unconstrained.kind === 'ok' && !isPathInsideRoot(executionRoot, unconstrained.toplevel)) {
    return { kind: 'non-git', reason: 'parent-escaped' }
  }

  const nestedRoot = await findNestedGitRoot(executionRoot, options)
  if (nestedRoot) {
    const head = await readHeadState(nestedRoot, options)
    return { kind: 'git', gitRoot: nestedRoot, head, nested: true }
  }

  return { kind: 'non-git', reason: 'no-repository' }
}

async function showToplevel(
  cwd: string,
  options: ReadOnlyGitOptions
): Promise<{ kind: 'ok'; toplevel: string } | { kind: 'missing' } | { kind: 'unavailable' }> {
  const result = await runReadOnlyGit(cwd, ['rev-parse', '--show-toplevel'], options)
  if (result.ok) {
    const raw = result.stdout.trim()
    if (!raw || hasParentTraversal(raw)) return { kind: 'missing' }
    try {
      const toplevel = await fs.realpath(raw)
      return { kind: 'ok', toplevel }
    } catch {
      return { kind: 'missing' }
    }
  }
  if (result.unavailable) return { kind: 'unavailable' }
  return { kind: 'missing' }
}

async function readHeadState(gitRoot: string, options: ReadOnlyGitOptions): Promise<GitHeadState> {
  const oidResult = await runReadOnlyGit(
    gitRoot,
    ['rev-parse', '--verify', '--quiet', 'HEAD'],
    options
  )
  const oid =
    oidResult.ok && /^[0-9a-f]{40,64}$/i.test(oidResult.stdout.trim())
      ? oidResult.stdout.trim().toLowerCase()
      : null

  const symbolic = await runReadOnlyGit(
    gitRoot,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    options
  )
  if (symbolic.ok && symbolic.stdout.trim()) {
    return { oid, branch: symbolic.stdout.trim(), detached: false }
  }

  const abbrev = await runReadOnlyGit(gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], options)
  const name = abbrev.ok ? abbrev.stdout.trim() : ''
  if (name === 'HEAD') return { oid, branch: null, detached: true }
  return { oid, branch: name || null, detached: Boolean(oid) && !name }
}

/**
 * 只在 execution root 自身不是仓库时向下有界扫描一层层 .git。
 * 不跟随指向 root 外的符号链接，避免把外部仓库当成嵌套仓库。
 */
async function findNestedGitRoot(
  executionRoot: string,
  options: ReadOnlyGitOptions
): Promise<string | null> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: executionRoot, depth: 0 }]
  let visited = 0

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    if (current.dir !== executionRoot && (await hasGitMetadata(current.dir))) {
      const toplevel = await showToplevel(current.dir, {
        ...options,
        ceilingDir: executionRoot,
        allowedRoot: executionRoot
      })
      if (
        toplevel.kind === 'ok' &&
        isPathInsideRoot(executionRoot, toplevel.toplevel) &&
        !sameCanonicalPath(toplevel.toplevel, executionRoot)
      ) {
        return toplevel.toplevel
      }
    }
    if (current.depth >= NESTED_SCAN_MAX_DEPTH) continue
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (
        SKIP_NESTED_DIRECTORY_NAMES.has(entry.name) ||
        entry.name === '.' ||
        entry.name === '..'
      ) {
        continue
      }
      visited += 1
      if (visited > NESTED_SCAN_MAX_DIRS) return null
      const child = join(current.dir, entry.name)
      let canonicalChild: string
      try {
        const stats = await fs.stat(child)
        if (!stats.isDirectory()) continue
        canonicalChild = await fs.realpath(child)
      } catch {
        continue
      }
      if (!isPathInsideRoot(executionRoot, canonicalChild)) continue
      queue.push({ dir: canonicalChild, depth: current.depth + 1 })
    }
  }
  return null
}

async function hasGitMetadata(dir: string): Promise<boolean> {
  try {
    await fs.lstat(join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

function isReadOnlyGitArgs(args: string[]): boolean {
  if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== 'string')) {
    return false
  }
  let index = 0
  while (args[index] === '-c' && typeof args[index + 1] === 'string') {
    const assignment = args[index + 1]
    if (!assignment || assignment.includes('\0') || !assignment.includes('=')) return false
    index += 2
  }
  const command = args[index]
  const rest = args.slice(index + 1)
  if (rest.some((arg) => arg.includes('\0'))) return false
  if (command === 'diff') {
    // --output 会写文件，禁止经只读入口进入。
    return rest.every(
      (arg) => arg !== '--output' && !arg.startsWith('--output=') && arg !== '--ext-diff'
    )
  }
  if (command === 'ls-files') {
    return rest.every((arg) => arg !== '--stdin' && !arg.startsWith('--out'))
  }
  if (command === 'show') {
    // 只允许 `show <rev>:<path>` 读 blob，禁止 --output 等写入口。
    return rest.length === 1 && isSafeGitShowSpec(rest[0] ?? '')
  }
  return (
    command === 'rev-parse' ||
    command === 'status' ||
    command === 'symbolic-ref' ||
    command === 'merge-base'
  )
}

/** rev 只接受 HEAD 或十六进制对象名，path 必须是无 `..` 的相对路径。 */
function isSafeGitShowSpec(value: string): boolean {
  if (!value || value.includes('\0') || value.startsWith('-')) return false
  const colon = value.indexOf(':')
  if (colon <= 0) return false
  const rev = value.slice(0, colon)
  const path = value.slice(colon + 1)
  if (rev !== 'HEAD' && !/^[0-9a-f]{7,64}$/i.test(rev)) return false
  if (!path || path.includes('\0') || isAbsolute(path) || hasParentTraversal(path)) return false
  if (path.includes(':')) return false
  return true
}

function isGitUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? error.code : undefined
  if (code === 'ENOENT' || code === 'ETIMEDOUT') return true
  return 'killed' in error && Boolean(error.killed)
}

function hasParentTraversal(value: string): boolean {
  return value.split(/[\\/]+/u).some((segment) => segment === '..')
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function safeDisplayRoot(executionRoot: string): string {
  if (typeof executionRoot !== 'string' || !executionRoot.trim() || executionRoot.includes('\0')) {
    return ''
  }
  return isAbsolute(executionRoot) ? resolve(executionRoot) : executionRoot
}
