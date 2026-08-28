import { promises as fs } from 'node:fs'
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'
import { classifyTaskAttachmentBytes } from '../../../shared/task-attachment'

/** Grok CLI 默认 session 媒体根；Agent Studio 另有 App grok-home/sessions。 */
export const DEFAULT_GROK_SESSION_MEDIA_ROOT = '/tmp/sessions'

const MAX_MEDIA_PROMPT_CHARS = 8 * 1024
const MEDIA_FILE_NAME = /^\d+\.(png|jpe?g|webp|gif)$/i

export interface GrokRuntimeMediaCandidate {
  absolutePath: string
  originalName: string
}

export interface GrokRuntimeMediaBytes {
  bytes: Buffer
  mimeType: string
  originalName: string
}

/**
 * 从 ACP tool_call content 抽出 Grok Imagine 落盘描述。
 * 只认编号图片文件名和 images 目录，路径不得进入事件。
 */
export function extractGrokRuntimeMediaPaths(content: unknown): GrokRuntimeMediaCandidate[] {
  if (!Array.isArray(content)) return []
  const found: GrokRuntimeMediaCandidate[] = []
  for (const item of content) {
    const text = toolCallContentText(item)
    const candidate = text ? parseGrokMediaGenPromptText(text) : null
    if (candidate) found.push(candidate)
  }
  return found
}

/** 同步判断 tool_call 是否带可入库的生图描述，供 Adapter 决定是否走异步队列。 */
export function toolCallHasGrokRuntimeMedia(content: unknown): boolean {
  return extractGrokRuntimeMediaPaths(content).length > 0
}

/**
 * 读取并校验 session 媒体文件。符号链接、越界、非图片一律失败关闭。
 */
export async function readGrokSessionMediaFile(
  candidate: GrokRuntimeMediaCandidate,
  options: { mediaRoot?: string; mediaRoots?: string[] } = {}
): Promise<GrokRuntimeMediaBytes | null> {
  const roots =
    options.mediaRoots ??
    (options.mediaRoot ? [options.mediaRoot] : [DEFAULT_GROK_SESSION_MEDIA_ROOT])
  for (const root of roots) {
    const confined = await confineGrokSessionMediaPath(candidate.absolutePath, root)
    if (!confined) continue
    const bytes = await fs.readFile(confined).catch(() => null)
    if (!bytes) continue
    const classified = classifyTaskAttachmentBytes({
      originalName: candidate.originalName,
      bytes
    })
    if (!classified.ok || classified.kind !== 'image') return null
    return {
      bytes,
      mimeType: classified.mimeType,
      originalName: classified.originalName
    }
  }
  return null
}

function parseGrokMediaGenPromptText(text: string): GrokRuntimeMediaCandidate | null {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > MAX_MEDIA_PROMPT_CHARS) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const originalName = parsed.filename
  const sessionFolder = parsed.session_folder
  const absolutePath = parsed.path
  if (typeof originalName !== 'string' || !MEDIA_FILE_NAME.test(originalName)) return null
  if (sessionFolder !== 'images') return null
  if (typeof absolutePath !== 'string' || !absolutePath || absolutePath.includes('\0')) return null
  if (basename(absolutePath) !== originalName) return null
  if (basename(dirname(absolutePath)) !== 'images') return null
  return { absolutePath, originalName }
}

function toolCallContentText(item: unknown): string | null {
  if (!isRecord(item)) return null
  if (item.type === 'content' && isRecord(item.content)) {
    if (item.content.type !== 'text' || typeof item.content.text !== 'string') return null
    return item.content.text
  }
  // 兼容扁平 Text 块，避免 Grok 某版 SDK 不包 type:content。
  if (item.type === 'text' && typeof item.text === 'string') return item.text
  return null
}

async function confineGrokSessionMediaPath(
  absolutePath: string,
  mediaRoot: string
): Promise<string | null> {
  if (!absolutePath || absolutePath.includes('\0') || !isAbsolute(absolutePath)) return null
  const stats = await fs.lstat(absolutePath).catch(() => null)
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) return null
  const realFile = await fs.realpath(absolutePath).catch(() => null)
  const realRoot = await fs.realpath(mediaRoot).catch(() => null)
  if (!realFile || !realRoot) return null
  const rel = relative(realRoot, realFile)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  const parts = rel.split(sep)
  // /tmp/sessions/<id>/images/n.jpg 或 grok-home/sessions/<cwd>/<id>/images/n.jpg
  const fileName = parts[parts.length - 1]
  const folder = parts[parts.length - 2]
  if (parts.length < 3 || folder !== 'images' || !MEDIA_FILE_NAME.test(fileName ?? '')) {
    return null
  }
  return realFile
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
