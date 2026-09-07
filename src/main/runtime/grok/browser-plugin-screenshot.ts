import { createHash } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import { classifyArtifactBytes, type ArtifactDescriptor } from '../../../shared/artifact'
import { ArtifactRegistry, ArtifactRegistryError } from '../../artifact/artifact-registry'
import { isPathInsideRoot, toPosixRelativePath } from '../../project/project-root-resolver'
import { readGrokSessionMediaFile } from './grok-runtime-media'

/** chrome-devtools / browser-use 文档里的截图工具；ACP 是否原样出现仍 not-observed。 */
const BROWSER_PLUGIN_SCREENSHOT_TOOL_NAMES = new Set(['take_screenshot', 'browser_screenshot'])

const ALLOWED_SCREENSHOT_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const ALLOWED_SCREENSHOT_MIME = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_SCREENSHOT_PATH_BYTES = 16 * 1024
const BROWSER_PLUGIN_SCREENSHOT_TITLE = '屏幕截图'

export interface RegisterBrowserPluginScreenshotInput {
  taskId: string
  turnId: string
  absolutePath: string
  registry: ArtifactRegistry
  executionRoot: string
  mediaRoots: readonly string[]
}

/**
 * 把插件截图登记为当前 Turn 的 image Artifact。
 * 只认 execution root 或已冻结 session `images/` 下的 png/jpeg/webp；
 * 越界、svg、空文件、探测失败一律返回 null，禁止抛进 session/prompt。
 */
export async function registerBrowserPluginScreenshot(
  input: RegisterBrowserPluginScreenshotInput
): Promise<ArtifactDescriptor | null> {
  try {
    const located = await locateBrowserPluginScreenshot(input)
    if (!located) return null
    const relativePath =
      located.kind === 'execution-root'
        ? located.relativePath
        : await materializeSessionScreenshot(input.executionRoot, located.bytes, located.ext)
    if (!relativePath) return null
    const descriptor = await input.registry.registerFileCandidate({
      taskId: input.taskId,
      turnId: input.turnId,
      source: 'agent-event',
      relativePath,
      title: BROWSER_PLUGIN_SCREENSHOT_TITLE
    })
    if (descriptor.kind !== 'image') return null
    if (!ALLOWED_SCREENSHOT_MIME.has(descriptor.mimeType)) return null
    return descriptor
  } catch (error) {
    // 只保留稳定失败类别，路径和原始异常不得离开本函数。
    if (error instanceof ArtifactRegistryError) return null
    return null
  }
}

/**
 * 只读冻结键 rawInput.filePath。嵌套 tool_input、相对路径、NUL 一律丢掉。
 * ACP 是否出现该键仍 not-observed，实现不得从 title / content JSON 猜路径。
 */
export function copyBrowserPluginScreenshotFilePath(rawInput: unknown): string | null {
  if (rawInput == null || typeof rawInput !== 'object' || Array.isArray(rawInput)) return null
  const filePath = (rawInput as Record<string, unknown>).filePath
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) return null
  if (Buffer.byteLength(filePath) > MAX_SCREENSHOT_PATH_BYTES) return null
  if (!isAbsolute(filePath)) return null
  return filePath
}

/** 同一条 update 上同时有截图工具名和 filePath 才进入入库队列。 */
export function toolCallHasBrowserPluginScreenshot(update: unknown): boolean {
  if (!isRecord(update)) return false
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
    return false
  }
  if (!isBrowserPluginScreenshotToolName(update.name)) return false
  return copyBrowserPluginScreenshotFilePath(update.rawInput) != null
}

export function isBrowserPluginScreenshotToolName(name: unknown): name is string {
  return typeof name === 'string' && BROWSER_PLUGIN_SCREENSHOT_TOOL_NAMES.has(name)
}

/**
 * 截图路径白名单：先 lstat 拒绝符号链接，再 realpath 限制在 execution root
 * 或 session 媒体根的 `images/` 下。禁止把 Imagine 编号文件名规则套到 chrome-devtools。
 */
async function locateBrowserPluginScreenshot(input: {
  absolutePath: string
  executionRoot: string
  mediaRoots: readonly string[]
}): Promise<
  | { kind: 'execution-root'; realPath: string; relativePath: string }
  | { kind: 'session-media'; bytes: Buffer; ext: string }
  | null
> {
  const realFile = await confineRegularScreenshotFile(input.absolutePath)
  if (!realFile) return null
  const ext = extname(realFile).toLowerCase()
  if (!ALLOWED_SCREENSHOT_EXT.has(ext)) return null

  const realExecutionRoot = await fs.realpath(input.executionRoot).catch(() => null)
  if (realExecutionRoot && isPathInsideRoot(realExecutionRoot, realFile)) {
    const relativePath = toPosixRelativePath(realExecutionRoot, realFile)
    if (!relativePath) return null
    if (!(await screenshotBytesAreAllowed(realFile, relativePath, input.mediaRoots))) return null
    return { kind: 'execution-root', realPath: realFile, relativePath }
  }

  for (const mediaRoot of input.mediaRoots) {
    const realMediaRoot = await fs.realpath(mediaRoot).catch(() => null)
    if (!realMediaRoot || !isPathInsideRoot(realMediaRoot, realFile)) continue
    if (!isSessionImagesPath(realMediaRoot, realFile)) continue
    const bytes = await screenshotBytesAreAllowed(realFile, `shot${ext}`, input.mediaRoots)
    if (!bytes) return null
    return { kind: 'session-media', bytes, ext }
  }
  return null
}

async function confineRegularScreenshotFile(absolutePath: string): Promise<string | null> {
  if (!absolutePath || absolutePath.includes('\0') || !isAbsolute(absolutePath)) return null
  if (Buffer.byteLength(absolutePath) > MAX_SCREENSHOT_PATH_BYTES) return null
  const stats = await fs.lstat(absolutePath).catch(() => null)
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) return null
  return fs.realpath(absolutePath).catch(() => null)
}

function isSessionImagesPath(mediaRoot: string, realFile: string): boolean {
  const rel = relative(mediaRoot, realFile)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false
  const parts = rel.split(sep)
  return parts.length >= 3 && parts[parts.length - 2] === 'images'
}

async function screenshotBytesAreAllowed(
  realFile: string,
  relativePath: string,
  mediaRoots: readonly string[]
): Promise<Buffer | null> {
  const numbered = await readGrokSessionMediaFile(
    { absolutePath: realFile, originalName: basename(realFile) },
    { mediaRoots: [...mediaRoots] }
  )
  if (numbered) {
    return ALLOWED_SCREENSHOT_MIME.has(numbered.mimeType) ? numbered.bytes : null
  }

  const bytes = await fs.readFile(realFile).catch(() => null)
  if (!bytes) return null
  const classified = classifyArtifactBytes({ relativePath, bytes })
  if (
    !classified.ok ||
    classified.kind !== 'image' ||
    !ALLOWED_SCREENSHOT_MIME.has(classified.mimeType)
  ) {
    return null
  }
  return bytes
}

/**
 * session 媒体根在 execution root 之外，必须先落到 Task 可注册的相对路径。
 * 只写入已经校验过的字节，禁止再次 readFile 跟随中途换成的 symlink。
 */
async function materializeSessionScreenshot(
  executionRoot: string,
  bytes: Buffer,
  ext: string
): Promise<string | null> {
  const realRoot = await fs.realpath(executionRoot).catch(() => null)
  if (!realRoot || !ALLOWED_SCREENSHOT_EXT.has(ext)) return null
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  const screenshotsDir = await confineScreenshotsDirectory(realRoot)
  if (!screenshotsDir) return null
  const destination = join(screenshotsDir, `${hash}${ext}`)
  if (!isPathInsideRoot(realRoot, destination) || !isPathInsideRoot(screenshotsDir, destination)) {
    return null
  }
  const destStats = await fs.lstat(destination).catch(() => null)
  if (destStats?.isSymbolicLink()) return null
  // O_NOFOLLOW：父目录已确认是普通目录后，目标若在写入瞬间被换成链接则失败而不是跟出去。
  const handle = await fs
    .open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600
    )
    .catch(() => null)
  if (!handle) return null
  try {
    await handle.writeFile(bytes)
  } finally {
    await handle.close()
  }
  const realDestination = await fs.realpath(destination).catch(() => null)
  if (!realDestination || !isPathInsideRoot(realRoot, realDestination)) return null
  return toPosixRelativePath(realRoot, realDestination)
}

/**
 * screenshots 目录必须是 execution root 内的普通目录。
 * 若它是指向根外的 symlink，lstat 直接拒绝，禁止 mkdir/writeFile 先把字节写出去。
 */
async function confineScreenshotsDirectory(realRoot: string): Promise<string | null> {
  const screenshotsDir = join(realRoot, 'screenshots')
  const existing = await fs.lstat(screenshotsDir).catch(() => null)
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) return null
  } else {
    await fs.mkdir(screenshotsDir, { recursive: true, mode: 0o700 })
    const created = await fs.lstat(screenshotsDir).catch(() => null)
    if (!created || created.isSymbolicLink() || !created.isDirectory()) return null
  }
  const realDir = await fs.realpath(screenshotsDir).catch(() => null)
  if (!realDir || !isPathInsideRoot(realRoot, realDir)) return null
  return realDir
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
