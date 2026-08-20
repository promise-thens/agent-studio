import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

export type SharedMemoryLinkResult = 'linked' | 'already-linked' | 'skipped-existing'

export function getUserGrokMemoryDir(resolveHome: () => string = homedir): string {
  return join(resolveHome(), '.grok', 'memory')
}

export function assertUserGrokMemoryDir(userMemoryDir: string): void {
  if (!isAbsolute(userMemoryDir)) {
    throw new Error('共享记忆目录必须是绝对路径。')
  }
  const normalized = resolve(userMemoryDir)
  if (basename(normalized) !== 'memory' || basename(dirname(normalized)) !== '.grok') {
    throw new Error('共享记忆目录必须是 <home>/.grok/memory。')
  }
}

/**
 * 只连接记忆目录。不得碰 config.toml / plugins / auth。
 * 整棵树（全局 + 项目 <slug>-<hash8> + sessions + 索引）随 junction 一起可见。
 */
export async function ensureSharedGrokMemory(input: {
  grokHome: string
  userMemoryDir: string
}): Promise<SharedMemoryLinkResult> {
  assertUserGrokMemoryDir(input.userMemoryDir)
  const grokHome = resolve(input.grokHome)
  const userMemoryDir = resolve(input.userMemoryDir)
  const managedMemory = join(grokHome, 'memory')

  await fs.mkdir(userMemoryDir, { recursive: true, mode: 0o700 })
  await chmodBestEffort(userMemoryDir, 0o700)

  let managedStat: Awaited<ReturnType<typeof fs.lstat>> | null = null
  try {
    managedStat = await fs.lstat(managedMemory)
  } catch (error) {
    if (!isNotFound(error)) throw error
  }

  if (!managedStat) {
    await createMemoryLink(userMemoryDir, managedMemory)
    return 'linked'
  }

  if (managedStat.isSymbolicLink() || isJunction(managedStat)) {
    const canonical = await safeRealpath(managedMemory)
    const expected = await safeRealpath(userMemoryDir)
    if (canonical && expected && samePath(canonical, expected)) {
      return 'already-linked'
    }
    return 'skipped-existing'
  }

  if (managedStat.isDirectory()) {
    const entries = await fs.readdir(managedMemory)
    if (entries.length === 0) {
      await fs.rmdir(managedMemory)
      await createMemoryLink(userMemoryDir, managedMemory)
      return 'linked'
    }
    return 'skipped-existing'
  }

  return 'skipped-existing'
}

export function isAllowedMemoryCanonical(input: {
  grokHome: string
  userMemoryDir: string
  canonical: string
}): boolean {
  const grokHome = resolve(input.grokHome)
  const userMemoryDir = resolve(input.userMemoryDir)
  const canonical = resolve(input.canonical)
  return isPathInside(join(grokHome, 'memory'), canonical) || isPathInside(userMemoryDir, canonical)
}

export function isPathInside(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child))
  return (
    relativePath === '' ||
    (Boolean(relativePath) && !relativePath.startsWith('..') && !isAbsolute(relativePath))
  )
}

async function createMemoryLink(userMemoryDir: string, managedMemory: string): Promise<void> {
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  await fs.symlink(userMemoryDir, managedMemory, type)
}

function isJunction(stat: { isDirectory(): boolean; isSymbolicLink(): boolean }): boolean {
  // Windows junction 在 Node 里通常表现为 directory + 不是普通 symlink 的 stat，lstat 仍可能 isSymbolicLink。
  return process.platform === 'win32' && stat.isDirectory() && stat.isSymbolicLink()
}

async function safeRealpath(path: string): Promise<string | null> {
  try {
    return await fs.realpath(path)
  } catch {
    return null
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  if (process.platform === 'win32') {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
  }
  return normalizedLeft === normalizedRight
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

async function chmodBestEffort(path: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return
  await fs.chmod(path, mode).catch(() => undefined)
}
