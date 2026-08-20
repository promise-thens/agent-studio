import { promises as fs } from 'node:fs'
import { dirname, join, posix, resolve, sep } from 'node:path'
import {
  grokMemoryTitle,
  isCurrentProjectMemoryDir,
  parseGrokMemoryId,
  GROK_MEMORY_MAX_BYTES,
  type GrokMemoryDocument,
  type GrokMemoryShareStatus,
  type GrokMemorySummary
} from '../../../shared/grok-memory'
import { DesktopIpcFailure } from '../../security/ipc-sender-validation'
import {
  ensureSharedGrokMemory,
  getUserGrokMemoryDir,
  isAllowedMemoryCanonical,
  isPathInside
} from './grok-shared-memory'
import { GrokHomeConfigController } from './grok-home-config-controller'

const PROJECT_DIR_PATTERN = /^[A-Za-z0-9._-]+-[0-9A-Fa-f]{8}$/

export class GrokMemoryStore {
  readonly memoryRoot: string
  private shareStatus: GrokMemoryShareStatus = 'skipped-existing'

  constructor(
    private readonly grokHome: string,
    private readonly userMemoryDir: string = getUserGrokMemoryDir(),
    private readonly config = new GrokHomeConfigController(grokHome)
  ) {
    this.memoryRoot = join(resolve(grokHome), 'memory')
  }

  async ensureShare(): Promise<GrokMemoryShareStatus> {
    this.shareStatus = await ensureSharedGrokMemory({
      grokHome: this.grokHome,
      userMemoryDir: this.userMemoryDir
    })
    return this.shareStatus
  }

  getShareStatus(): GrokMemoryShareStatus {
    return this.shareStatus
  }

  async getEnabledState(): Promise<{ enabled: boolean; shareStatus: GrokMemoryShareStatus }> {
    const shareStatus = await this.ensureShare()
    return {
      enabled: await this.config.readMemoryEnabled(),
      shareStatus
    }
  }

  async setEnabled(
    enabled: boolean
  ): Promise<{ enabled: boolean; shareStatus: GrokMemoryShareStatus }> {
    await this.config.apply({ memoryEnabled: enabled })
    return this.getEnabledState()
  }

  async list(projectHint?: string): Promise<GrokMemorySummary[]> {
    await this.ensureShare()
    const summaries: GrokMemorySummary[] = []
    const globalFile = join(this.memoryRoot, 'MEMORY.md')
    const globalSummary = await this.summarizeIfAllowed('global/MEMORY.md', globalFile)
    if (globalSummary) summaries.push(globalSummary)

    let entries: string[] = []
    try {
      entries = await fs.readdir(this.memoryRoot)
    } catch (error) {
      if (isNotFound(error)) return summaries
      throw error
    }

    for (const entry of entries.sort()) {
      if (!PROJECT_DIR_PATTERN.test(entry)) continue
      const projectDir = join(this.memoryRoot, entry)
      if (!(await this.isAllowedDir(projectDir))) continue
      const isCurrent = isCurrentProjectMemoryDir(entry, projectHint)
      const projectFile = join(projectDir, 'MEMORY.md')
      const projectSummary = await this.summarizeIfAllowed(
        `project/${entry}/MEMORY.md`,
        projectFile,
        isCurrent
      )
      if (projectSummary) summaries.push(projectSummary)

      const sessionsDir = join(projectDir, 'sessions')
      let sessionFiles: string[] = []
      try {
        sessionFiles = await fs.readdir(sessionsDir)
      } catch (error) {
        if (isNotFound(error)) continue
        throw error
      }
      for (const file of sessionFiles.sort()) {
        if (!file.endsWith('.md') || file.includes('..')) continue
        const sessionSummary = await this.summarizeIfAllowed(
          `session/${entry}/${file}`,
          join(sessionsDir, file),
          isCurrent
        )
        if (sessionSummary) summaries.push(sessionSummary)
      }
    }
    return summaries
  }

  async get(memoryId: string): Promise<GrokMemoryDocument> {
    const parsed = requireMemoryId(memoryId)
    const absolute = join(this.memoryRoot, parsed.relativePosixPath.split('/').join(sep))
    await this.assertAllowedFile(absolute)
    const raw = await fs.readFile(absolute, 'utf8')
    if (raw.includes('\0')) {
      throw new DesktopIpcFailure('invalid-input', '记忆文件包含非法字符。')
    }
    const bytes = Buffer.byteLength(raw, 'utf8')
    const truncated = bytes > GROK_MEMORY_MAX_BYTES
    const markdown = truncated
      ? raw.slice(0, decodeUtf8Prefix(raw, GROK_MEMORY_MAX_BYTES).length)
      : raw
    const document: GrokMemoryDocument = {
      memoryId: parsed.memoryId,
      scope: parsed.scope,
      title: grokMemoryTitle(markdown, fallbackTitle(parsed.memoryId)),
      markdown
    }
    if (truncated) document.truncated = true
    if (parsed.projectKey) document.projectKey = parsed.projectKey
    return document
  }

  async save(memoryId: string, markdown: string): Promise<GrokMemoryDocument> {
    const parsed = requireMemoryId(memoryId)
    if (typeof markdown !== 'string' || markdown.includes('\0')) {
      throw new DesktopIpcFailure('invalid-input', '记忆内容无效。')
    }
    if (Buffer.byteLength(markdown, 'utf8') > GROK_MEMORY_MAX_BYTES) {
      throw new DesktopIpcFailure('payload-too-large', '记忆内容超过 256 KiB。')
    }
    const absolute = join(this.memoryRoot, parsed.relativePosixPath.split('/').join(sep))
    await this.assertAllowedWriteTarget(absolute)
    await fs.mkdir(dirname(absolute), { recursive: true, mode: 0o700 })
    await chmodBestEffort(dirname(absolute), 0o700)
    await writeAtomicText(absolute, markdown)
    return {
      memoryId: parsed.memoryId,
      scope: parsed.scope,
      title: grokMemoryTitle(markdown, fallbackTitle(parsed.memoryId)),
      markdown,
      ...(parsed.projectKey ? { projectKey: parsed.projectKey } : {})
    }
  }

  async delete(memoryId: string): Promise<void> {
    const parsed = requireMemoryId(memoryId)
    if (parsed.scope !== 'session') {
      throw new DesktopIpcFailure(
        'invalid-input',
        '只能删除会话摘要，不能删除全局或项目 MEMORY.md。'
      )
    }
    const absolute = join(this.memoryRoot, parsed.relativePosixPath.split('/').join(sep))
    await this.assertAllowedFile(absolute)
    await fs.rm(absolute, { force: false })
  }

  private async summarizeIfAllowed(
    memoryId: string,
    absolute: string,
    isCurrentProject = false
  ): Promise<GrokMemorySummary | null> {
    const parsed = parseGrokMemoryId(memoryId)
    if (!parsed) return null
    try {
      await this.assertAllowedFile(absolute)
      const stat = await fs.stat(absolute)
      if (!stat.isFile()) return null
      const raw = await fs.readFile(absolute, 'utf8')
      if (raw.includes('\0')) return null
      const summary: GrokMemorySummary = {
        memoryId: parsed.memoryId,
        scope: parsed.scope,
        title: grokMemoryTitle(raw, fallbackTitle(parsed.memoryId)),
        updatedAt: stat.mtime.toISOString()
      }
      if (parsed.projectKey) summary.projectKey = parsed.projectKey
      if (isCurrentProject) summary.isCurrentProject = true
      return summary
    } catch {
      return null
    }
  }

  private async isAllowedDir(absolute: string): Promise<boolean> {
    try {
      const canonical = await fs.realpath(absolute)
      return isAllowedMemoryCanonical({
        grokHome: this.grokHome,
        userMemoryDir: this.userMemoryDir,
        canonical
      })
    } catch {
      return false
    }
  }

  private async assertAllowedFile(absolute: string): Promise<void> {
    const logicalRoot = this.memoryRoot
    if (!isPathInside(logicalRoot, absolute)) {
      throw new DesktopIpcFailure('invalid-input', '记忆路径无效。')
    }
    let canonical: string
    try {
      canonical = await fs.realpath(absolute)
    } catch (error) {
      if (isNotFound(error)) throw new DesktopIpcFailure('not-found', '未找到该记忆文件。')
      throw error
    }
    if (
      !isAllowedMemoryCanonical({
        grokHome: this.grokHome,
        userMemoryDir: this.userMemoryDir,
        canonical
      })
    ) {
      throw new DesktopIpcFailure('invalid-input', '记忆路径无效。')
    }
  }

  private async assertAllowedWriteTarget(absolute: string): Promise<void> {
    const logicalRoot = this.memoryRoot
    if (!isPathInside(logicalRoot, absolute)) {
      throw new DesktopIpcFailure('invalid-input', '记忆路径无效。')
    }
    await fs.mkdir(this.memoryRoot, { recursive: true, mode: 0o700 }).catch(() => undefined)
    const parent = dirname(absolute)
    await fs.mkdir(parent, { recursive: true, mode: 0o700 })
    try {
      const canonical = await fs.realpath(absolute)
      if (
        !isAllowedMemoryCanonical({
          grokHome: this.grokHome,
          userMemoryDir: this.userMemoryDir,
          canonical
        })
      ) {
        throw new DesktopIpcFailure('invalid-input', '记忆路径无效。')
      }
    } catch (error) {
      if (isNotFound(error)) {
        const parentCanonical = await fs.realpath(parent)
        if (
          !isAllowedMemoryCanonical({
            grokHome: this.grokHome,
            userMemoryDir: this.userMemoryDir,
            canonical: parentCanonical
          })
        ) {
          throw new DesktopIpcFailure('invalid-input', '记忆路径无效。')
        }
        return
      }
      throw error
    }
  }
}

function requireMemoryId(memoryId: string): NonNullable<ReturnType<typeof parseGrokMemoryId>> {
  const parsed = parseGrokMemoryId(memoryId)
  if (!parsed) throw new DesktopIpcFailure('invalid-input', '记忆标识无效。')
  return parsed
}

function fallbackTitle(memoryId: string): string {
  return posix.basename(memoryId)
}

function decodeUtf8Prefix(text: string, maxBytes: number): string {
  let used = 0
  let result = ''
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8')
    if (used + size > maxBytes) break
    result += character
    used += size
  }
  return result
}

async function writeAtomicText(path: string, text: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    await fs.writeFile(temporaryPath, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fs.rename(temporaryPath, path)
    await chmodBestEffort(path, 0o600)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

async function chmodBestEffort(path: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return
  await fs.chmod(path, mode).catch(() => undefined)
}
