import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
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
        : await materializeSessionScreenshot(input.executionRoot, located.realPath)
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
  | { kind: 'session-media'; realPath: string }
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
    if (!(await screenshotBytesAreAllowed(realFile, `shot${ext}`, input.mediaRoots))) return null
    return { kind: 'session-media', realPath: realFile }
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
): Promise<boolean> {
  const numbered = await readGrokSessionMediaFile(
    { absolutePath: realFile, originalName: basename(realFile) },
    { mediaRoots: [...mediaRoots] }
  )
  if (numbered) return ALLOWED_SCREENSHOT_MIME.has(numbered.mimeType)

  const bytes = await fs.readFile(realFile).catch(() => null)
  if (!bytes) return false
  const classified = classifyArtifactBytes({ relativePath, bytes })
  return (
    classified.ok && classified.kind === 'image' && ALLOWED_SCREENSHOT_MIME.has(classified.mimeType)
  )
}

/**
 * session 媒体根在 execution root 之外，必须先落到 Task 可注册的相对路径。
 * 描述符只保存 posix 相对路径，不用原文件名，避免 URL 或绝对路径泄漏。
 */
async function materializeSessionScreenshot(
  executionRoot: string,
  realFile: string
): Promise<string | null> {
  const realRoot = await fs.realpath(executionRoot).catch(() => null)
  if (!realRoot) return null
  const bytes = await fs.readFile(realFile).catch(() => null)
  if (!bytes) return null
  const ext = extname(realFile).toLowerCase()
  if (!ALLOWED_SCREENSHOT_EXT.has(ext)) return null
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  const relativePath = `screenshots/${hash}${ext}`
  const destination = join(realRoot, 'screenshots', `${hash}${ext}`)
  if (!isPathInsideRoot(realRoot, destination)) return null
  await fs.mkdir(dirname(destination), { recursive: true })
  await fs.writeFile(destination, bytes, { mode: 0o600 })
  const realDestination = await fs.realpath(destination).catch(() => null)
  if (!realDestination || !isPathInsideRoot(realRoot, realDestination)) return null
  return relativePath
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
