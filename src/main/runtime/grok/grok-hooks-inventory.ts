import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { getManagedGrokHome } from '../../provider/grok-provider-config'
import {
  MAX_GROK_HOOK_EVENT_NAME_LENGTH,
  MAX_GROK_HOOK_JSON_BYTES,
  MAX_GROK_HOOK_ROWS,
  parseGrokHookSummary,
  parseSafeMatcher,
  type GrokHookSummary
} from '../../../shared/grok-hook'
import { isPathInside } from './grok-shared-memory'

const HOOKS_DIR = 'hooks'

/** 跟随 symlink 逃出受管 grok-home 时的安全文案，故意不含绝对路径与分隔符。 */
const INVALID_ESCAPE_WARNING = '钩子文件指向了受管 Grok Home 之外的位置。'
const INVALID_DIR_ESCAPE_WARNING = '钩子目录指向了受管 Grok Home 之外的位置。'
const INVALID_OVERSIZE_WARNING = '钩子文件过大，已跳过。'
const INVALID_READ_WARNING = '钩子文件无法读取或解析。'
const INVALID_TYPE_WARNING = '钩子类型无效。'
const INVALID_TARGET_WARNING = '钩子目标缺失。'
const INVALID_URL_WARNING = '钩子地址无效。'

type PathResolve = { kind: 'missing' } | { kind: 'ok'; canonical: string } | { kind: 'invalid' }
type HooksRootResolve =
  { kind: 'missing' } | { kind: 'ok'; canonical: string } | { kind: 'escaped' }

/**
 * 只读扫描 App 专属 grok-home/hooks 下一层 *.json。
 * 用 realpath + stat + readFile + JSON.parse；不创建目录，不执行钩子目标。
 * 不读用户主目录下的 Grok hooks、项目目录或插件 hooks.json。
 */
export async function listGrokHooks(userDataPath: string): Promise<GrokHookSummary[]> {
  const grokHome = await resolveManagedGrokHome(userDataPath)
  if (!grokHome) return []

  const hooksRoot = await resolveHooksRoot(grokHome)
  if (hooksRoot.kind === 'missing') return []
  if (hooksRoot.kind === 'escaped') {
    // 目录存在但 realpath 已离开 grok-home：Grok 仍会跟随，UI 必须诚实标 invalid，且不得读外部树。
    const parsed = parseGrokHookSummary(fileInvalid(HOOKS_DIR, INVALID_DIR_ESCAPE_WARNING))
    return parsed ? [parsed] : []
  }

  let entries: string[]
  try {
    entries = await fs.readdir(hooksRoot.canonical)
  } catch {
    return []
  }

  const rows: GrokHookSummary[] = []
  for (const fileName of [...entries].sort(compareAscii)) {
    if (!isHookJsonFileName(fileName)) continue
    const fileRows = await readHookFile(grokHome, join(hooksRoot.canonical, fileName), fileName)
    for (const row of fileRows) {
      const parsed = parseGrokHookSummary(row)
      if (!parsed) continue
      rows.push(parsed)
      if (rows.length >= MAX_GROK_HOOK_ROWS) return rows
    }
  }
  return rows
}

/**
 * 解析受管 grok-home：必须真实存在且落在 userData 内。
 * 缺失或逃逸一律视为没有钩子，避免扫到用户 ~/.grok。
 */
async function resolveManagedGrokHome(userDataPath: string): Promise<string | null> {
  if (
    typeof userDataPath !== 'string' ||
    userDataPath.length === 0 ||
    userDataPath.includes('\0')
  ) {
    return null
  }

  const userDataCanonical = await realpathOrNull(userDataPath)
  if (!userDataCanonical) return null

  const grokHomeCanonical = await realpathOrNull(getManagedGrokHome(userDataPath))
  if (!grokHomeCanonical) return null
  if (!isPathInside(userDataCanonical, grokHomeCanonical)) return null

  try {
    const stats = await fs.stat(grokHomeCanonical)
    return stats.isDirectory() ? grokHomeCanonical : null
  } catch {
    return null
  }
}

/**
 * hooks 目录必须仍在 grok-home 内。
 * 不存在 → missing（真·未配置）；realpath 逃出 → escaped（一条 invalid，不扫描外部树）。
 */
async function resolveHooksRoot(grokHome: string): Promise<HooksRootResolve> {
  const resolved = await realpathExisting(join(grokHome, HOOKS_DIR))
  if (resolved.kind !== 'ok') return { kind: 'missing' }
  if (!isPathInside(grokHome, resolved.canonical)) return { kind: 'escaped' }
  try {
    const stats = await fs.stat(resolved.canonical)
    return stats.isDirectory() ? { kind: 'ok', canonical: resolved.canonical } : { kind: 'missing' }
  } catch {
    return { kind: 'missing' }
  }
}

/**
 * 读单个 JSON。realpath 一旦逃出 grok-home，整项 invalid 并停止跟随，
 * 以免把外部 command / url 读进摘要。
 */
async function readHookFile(
  grokHome: string,
  filePath: string,
  fileName: string
): Promise<GrokHookSummary[]> {
  const resolved = await realpathExisting(filePath)
  if (resolved.kind === 'missing') return []
  if (resolved.kind === 'invalid') {
    return [fileInvalid(fileName, INVALID_READ_WARNING)]
  }
  if (!isPathInside(grokHome, resolved.canonical)) {
    return [fileInvalid(fileName, INVALID_ESCAPE_WARNING)]
  }

  try {
    const stats = await fs.stat(resolved.canonical)
    if (!stats.isFile()) {
      return [fileInvalid(fileName, INVALID_READ_WARNING)]
    }
    if (stats.size > MAX_GROK_HOOK_JSON_BYTES) {
      return [fileInvalid(fileName, INVALID_OVERSIZE_WARNING)]
    }
    const text = await fs.readFile(resolved.canonical, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (!isPlainRecord(parsed)) {
      return [fileInvalid(fileName, INVALID_READ_WARNING)]
    }
    return parseHookDocument(fileName, parsed)
  } catch {
    return [fileInvalid(fileName, INVALID_READ_WARNING)]
  }
}

function parseHookDocument(fileName: string, document: Record<string, unknown>): GrokHookSummary[] {
  // 顶层 hooks 若是对象则按 10-hooks.md 包装形状；否则顶层键就是事件名。
  const eventMap = isPlainRecord(document.hooks) ? document.hooks : document
  const rows: GrokHookSummary[] = []

  for (const [eventName, groups] of Object.entries(eventMap)) {
    if (!isUsableEventName(eventName) || !Array.isArray(groups)) continue
    let handlerIndex = 0
    for (const group of groups) {
      if (!isPlainRecord(group) || !Array.isArray(group.hooks)) continue
      const matcher = parseSafeMatcher(group.matcher)
      for (const handler of group.hooks) {
        rows.push(toHandlerRow(fileName, eventName, handlerIndex, handler, matcher))
        handlerIndex += 1
        if (rows.length >= MAX_GROK_HOOK_ROWS) return rows
      }
    }
  }
  return rows
}

/**
 * 一条 DTO 对应内部 { type, command|url }。
 * command / url 只用于判定类型，绝不写入返回对象。
 */
function toHandlerRow(
  fileName: string,
  eventName: string,
  handlerIndex: number,
  handler: unknown,
  matcher: string | undefined
): GrokHookSummary {
  const id = `${fileName}:${eventName}:${String(handlerIndex)}`
  if (!isPlainRecord(handler)) {
    return handlerInvalid(id, eventName, INVALID_TYPE_WARNING, matcher)
  }

  if (handler.type === 'command') {
    if (typeof handler.command !== 'string' || !handler.command.trim()) {
      return handlerInvalid(id, eventName, INVALID_TARGET_WARNING, matcher)
    }
    return handlerValid(id, eventName, 'command', matcher)
  }

  if (handler.type === 'http') {
    if (typeof handler.url !== 'string' || !handler.url.trim()) {
      return handlerInvalid(id, eventName, INVALID_TARGET_WARNING, matcher)
    }
    const httpOrigin = originFromHookUrl(handler.url)
    if (!httpOrigin) {
      return handlerInvalid(id, eventName, INVALID_URL_WARNING, matcher)
    }
    return handlerValid(id, eventName, 'http', matcher, httpOrigin)
  }

  return handlerInvalid(id, eventName, INVALID_TYPE_WARNING, matcher)
}

function handlerValid(
  id: string,
  event: string,
  targetKind: 'command' | 'http',
  matcher: string | undefined,
  httpOrigin?: string
): GrokHookSummary {
  const row: GrokHookSummary = { id, event, enabled: true, targetKind }
  if (targetKind === 'http' && httpOrigin) row.httpOrigin = httpOrigin
  if (matcher) row.matcher = matcher
  return row
}

function handlerInvalid(
  id: string,
  event: string,
  warning: string,
  matcher: string | undefined
): GrokHookSummary {
  const row: GrokHookSummary = {
    id,
    event,
    enabled: false,
    targetKind: 'invalid',
    warning
  }
  if (matcher) row.matcher = matcher
  return row
}

function fileInvalid(fileName: string, warning: string): GrokHookSummary {
  return {
    id: fileName,
    event: '',
    enabled: false,
    targetKind: 'invalid',
    warning
  }
}

/**
 * 从完整 hook URL 取 origin。含 userinfo 直接无效，避免把账号密码写进警告或 DTO。
 * query / hash 随 origin 剥掉，不单独回传。
 */
function originFromHookUrl(raw: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (parsed.username || parsed.password) return undefined
  return parsed.origin
}

async function realpathExisting(path: string): Promise<PathResolve> {
  try {
    return { kind: 'ok', canonical: await fs.realpath(path) }
  } catch (error) {
    if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTDIR')) return { kind: 'invalid' }
    try {
      await fs.lstat(path)
      return { kind: 'invalid' }
    } catch {
      return { kind: 'missing' }
    }
  }
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await fs.realpath(path)
  } catch {
    return null
  }
}

function isHookJsonFileName(name: string): boolean {
  if (!name.endsWith('.json') || name.length === 0) return false
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) return false
  if (name.includes('..')) return false
  return true
}

function isUsableEventName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_GROK_HOOK_EVENT_NAME_LENGTH) return false
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) return false
  return true
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
