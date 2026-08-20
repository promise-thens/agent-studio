import { promises as fs } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { getManagedGrokHome } from '../../provider/grok-provider-config'
import {
  MANAGED_GROK_PLUGIN_SCOPE,
  MAX_RUNTIME_PLUGIN_NAME_LENGTH,
  MAX_RUNTIME_PLUGIN_NAMES,
  isRuntimePluginId,
  type RuntimePluginDetail,
  type RuntimePluginSummary
} from '../../../shared/runtime-plugin'

const MAX_JSON_BYTES = 64 * 1024
const MAX_DISPLAY_NAME_LENGTH = 256
const MAX_VERSION_LENGTH = 64

/** 跟随 symlink 逃出受管 grok-home 时的安全文案，故意不含绝对路径。 */
const INVALID_ESCAPE_REASON = '插件目录指向了受管 Grok Home 之外的位置。'
const INVALID_READ_REASON = '插件文件无法读取或解析。'

interface PluginJail {
  grokHome: string
  plugins: string
}

interface NameScan {
  names: string[]
  invalidReason?: string
}

type JsonRead =
  | { kind: 'missing' }
  | { kind: 'ok'; value: Record<string, unknown> }
  | { kind: 'invalid'; reason: string }

/**
 * 列出 App 专属 grok-home/plugins 下一层已安装插件。
 * 只读扫描，不创建目录、不修改用户 ~/.grok；缺目录视为空列表而不是错误。
 */
export async function listGrokPlugins(userDataPath: string): Promise<RuntimePluginSummary[]> {
  const jail = await resolvePluginJail(userDataPath)
  if (!jail) return []

  let entries: string[]
  try {
    entries = await fs.readdir(jail.plugins)
  } catch {
    return []
  }

  const pluginIds = entries.filter((name) => isRuntimePluginId(name)).sort(compareAscii)

  const summaries: RuntimePluginSummary[] = []
  for (const pluginId of pluginIds) {
    const detail = await readPlugin(jail, pluginId)
    if (detail) summaries.push(toSummary(detail))
  }
  return summaries
}

/**
 * 读取单个插件的脱敏详情。非法 pluginId 或目录不存在返回 null，不抛错。
 */
export async function getGrokPlugin(
  userDataPath: string,
  pluginId: string
): Promise<RuntimePluginDetail | null> {
  if (!isRuntimePluginId(pluginId)) return null
  const jail = await resolvePluginJail(userDataPath)
  if (!jail) return null
  return readPlugin(jail, pluginId)
}

/**
 * 解析扫描牢笼：realpath(grok-home) 必须落在 userData 内，plugins 必须落在 grok-home 内。
 * 任一跳到 ~/.grok 或其它位置则拒绝扫描，避免桌面读到用户自己的 Grok 配置。
 */
async function resolvePluginJail(userDataPath: string): Promise<PluginJail | null> {
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

  const pluginsCanonical = await realpathOrNull(join(getManagedGrokHome(userDataPath), 'plugins'))
  if (!pluginsCanonical) return null
  if (!isPathInside(grokHomeCanonical, pluginsCanonical)) return null

  try {
    const stats = await fs.stat(pluginsCanonical)
    if (!stats.isDirectory()) return null
  } catch {
    return null
  }

  return { grokHome: grokHomeCanonical, plugins: pluginsCanonical }
}

/**
 * 读取单个插件。目录或任何被读文件的 realpath 一旦逃出 grok-home，
 * 整项标 invalid 并停止跟随，以免把外部 manifest / env / 命令读进摘要。
 */
async function readPlugin(jail: PluginJail, pluginId: string): Promise<RuntimePluginDetail | null> {
  const candidate = join(jail.plugins, pluginId)
  const resolved = await realpathExisting(candidate)
  if (resolved.kind === 'missing') return null
  if (resolved.kind === 'invalid') {
    return makeInvalidDetail(pluginId, resolved.reason)
  }
  if (!isPathInside(jail.grokHome, resolved.canonical)) {
    return makeInvalidDetail(pluginId, INVALID_ESCAPE_REASON)
  }

  try {
    const stats = await fs.stat(resolved.canonical)
    if (!stats.isDirectory()) return null
  } catch {
    return makeInvalidDetail(pluginId, INVALID_READ_REASON)
  }

  return scanPluginContents(pluginId, resolved.canonical, jail.grokHome)
}

async function scanPluginContents(
  pluginId: string,
  pluginCanonical: string,
  grokHome: string
): Promise<RuntimePluginDetail> {
  let invalidReason: string | undefined
  let displayName = pluginId
  let version: string | undefined

  const manifest = await readJsonInside(grokHome, join(pluginCanonical, 'plugin.json'))
  if (manifest.kind === 'invalid') {
    invalidReason = manifest.reason
  } else if (manifest.kind === 'ok') {
    displayName = pickDisplayName(manifest.value, pluginId)
    version = pickVersion(manifest.value)
  }

  const skills = await scanSkills(grokHome, join(pluginCanonical, 'skills'))
  if (!invalidReason && skills.invalidReason) invalidReason = skills.invalidReason

  const mcp = await scanMcp(grokHome, join(pluginCanonical, '.mcp.json'))
  if (!invalidReason && mcp.invalidReason) invalidReason = mcp.invalidReason

  const hooks = await scanHooks(grokHome, join(pluginCanonical, 'hooks', 'hooks.json'))
  if (!invalidReason && hooks.invalidReason) invalidReason = hooks.invalidReason

  const skillNames = capNames(skills.names)
  const mcpNames = capNames(mcp.names)
  const hookNames = capNames(hooks.names)

  if (invalidReason) {
    return makeInvalidDetail(pluginId, invalidReason, {
      displayName,
      version,
      skillNames,
      mcpNames,
      hookNames
    })
  }

  const detail: RuntimePluginDetail = {
    pluginId,
    displayName,
    status: 'enabled',
    scope: MANAGED_GROK_PLUGIN_SCOPE,
    skillCount: skillNames.length,
    mcpCount: mcpNames.length,
    hookCount: hookNames.length,
    skillNames,
    mcpNames,
    hookNames
  }
  if (version) detail.version = version
  return detail
}

/** Skill 名取 skills 下第一层子目录名，且该目录内必须有落在牢笼内的 SKILL.md。 */
async function scanSkills(grokHome: string, skillsPath: string): Promise<NameScan> {
  const directory = await resolveDirectoryInside(grokHome, skillsPath)
  if (directory.kind === 'missing') return { names: [] }
  if (directory.kind === 'invalid') return { names: [], invalidReason: directory.reason }

  let entries: string[]
  try {
    entries = await fs.readdir(directory.canonical)
  } catch {
    return { names: [], invalidReason: INVALID_READ_REASON }
  }

  const names: string[] = []
  let invalidReason: string | undefined
  for (const entryName of entries) {
    if (!isAcceptableLeafName(entryName)) continue
    const skillDir = await resolveDirectoryInside(grokHome, join(directory.canonical, entryName))
    if (skillDir.kind === 'missing') continue
    if (skillDir.kind === 'invalid') {
      invalidReason = skillDir.reason
      continue
    }

    const skillFile = await realpathExisting(join(skillDir.canonical, 'SKILL.md'))
    if (skillFile.kind === 'missing') continue
    if (skillFile.kind === 'invalid') {
      invalidReason = skillFile.reason
      continue
    }
    if (!isPathInside(grokHome, skillFile.canonical)) {
      invalidReason = INVALID_ESCAPE_REASON
      continue
    }
    try {
      const stats = await fs.stat(skillFile.canonical)
      if (!stats.isFile()) continue
    } catch {
      invalidReason = INVALID_READ_REASON
      continue
    }
    names.push(entryName)
  }

  return { names, invalidReason }
}

/** 只取 MCP 配置对象的 server 名；不返回 command / env。 */
async function scanMcp(grokHome: string, filePath: string): Promise<NameScan> {
  const json = await readJsonInside(grokHome, filePath)
  if (json.kind === 'missing') return { names: [] }
  if (json.kind === 'invalid') return { names: [], invalidReason: json.reason }
  return { names: serverNamesFromConfig(json.value) }
}

/** Hook 名取 hooks.json 顶层类型键，例如 PreToolUse；永不返回命令字符串。 */
async function scanHooks(grokHome: string, filePath: string): Promise<NameScan> {
  const json = await readJsonInside(grokHome, filePath)
  if (json.kind === 'missing') return { names: [] }
  if (json.kind === 'invalid') return { names: [], invalidReason: json.reason }
  return { names: Object.keys(json.value) }
}

async function readJsonInside(grokHome: string, filePath: string): Promise<JsonRead> {
  const resolved = await realpathExisting(filePath)
  if (resolved.kind === 'missing') return { kind: 'missing' }
  if (resolved.kind === 'invalid') return { kind: 'invalid', reason: resolved.reason }
  if (!isPathInside(grokHome, resolved.canonical)) {
    return { kind: 'invalid', reason: INVALID_ESCAPE_REASON }
  }

  try {
    const stats = await fs.stat(resolved.canonical)
    if (!stats.isFile() || stats.size > MAX_JSON_BYTES) {
      return { kind: 'invalid', reason: INVALID_READ_REASON }
    }
    const text = await fs.readFile(resolved.canonical, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (!isPlainRecord(parsed)) return { kind: 'invalid', reason: INVALID_READ_REASON }
    return { kind: 'ok', value: parsed }
  } catch {
    return { kind: 'invalid', reason: INVALID_READ_REASON }
  }
}

async function resolveDirectoryInside(
  grokHome: string,
  directoryPath: string
): Promise<
  { kind: 'missing' } | { kind: 'ok'; canonical: string } | { kind: 'invalid'; reason: string }
> {
  const resolved = await realpathExisting(directoryPath)
  if (resolved.kind === 'missing') return { kind: 'missing' }
  if (resolved.kind === 'invalid') return resolved
  if (!isPathInside(grokHome, resolved.canonical)) {
    return { kind: 'invalid', reason: INVALID_ESCAPE_REASON }
  }
  try {
    const stats = await fs.stat(resolved.canonical)
    if (!stats.isDirectory()) return { kind: 'missing' }
    return { kind: 'ok', canonical: resolved.canonical }
  } catch {
    return { kind: 'invalid', reason: INVALID_READ_REASON }
  }
}

/**
 * realpath 跟随 symlink。目标不存在则视为缺失；
 * 损坏链接或其它读失败视为该项 invalid，不中断整个扫描。
 */
async function realpathExisting(
  path: string
): Promise<
  { kind: 'missing' } | { kind: 'ok'; canonical: string } | { kind: 'invalid'; reason: string }
> {
  try {
    return { kind: 'ok', canonical: await fs.realpath(path) }
  } catch (error) {
    if (!isNotFound(error) && !isNotDirectory(error)) {
      return { kind: 'invalid', reason: INVALID_READ_REASON }
    }
    try {
      await fs.lstat(path)
      return { kind: 'invalid', reason: INVALID_READ_REASON }
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

function serverNamesFromConfig(value: Record<string, unknown>): string[] {
  const fromMcpServers = asServerMap(value.mcpServers)
  if (fromMcpServers) return Object.keys(fromMcpServers)
  const fromServers = asServerMap(value.servers)
  if (fromServers) return Object.keys(fromServers)
  return []
}

function asServerMap(value: unknown): Record<string, unknown> | null {
  return isPlainRecord(value) ? value : null
}

function pickDisplayName(manifest: Record<string, unknown>, fallback: string): string {
  const fromDisplayName = asSafeLabel(manifest.displayName, MAX_DISPLAY_NAME_LENGTH)
  if (fromDisplayName) return fromDisplayName
  const fromName = asSafeLabel(manifest.name, MAX_DISPLAY_NAME_LENGTH)
  if (fromName) return fromName
  return fallback
}

function pickVersion(manifest: Record<string, unknown>): string | undefined {
  return asSafeLabel(manifest.version, MAX_VERSION_LENGTH)
}

function asSafeLabel(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength || trimmed.includes('\0')) return undefined
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return undefined
  return trimmed
}

function capNames(names: string[]): string[] {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const name of [...names].sort(compareAscii)) {
    if (!isAcceptableLeafName(name) || seen.has(name)) continue
    seen.add(name)
    unique.push(name)
    if (unique.length >= MAX_RUNTIME_PLUGIN_NAMES) break
  }
  return unique
}

function isAcceptableLeafName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_RUNTIME_PLUGIN_NAME_LENGTH) return false
  if (name === '.' || name.includes('\0')) return false
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false
  return true
}

function toSummary(detail: RuntimePluginDetail): RuntimePluginSummary {
  const summary: RuntimePluginSummary = {
    pluginId: detail.pluginId,
    displayName: detail.displayName,
    status: detail.status,
    scope: detail.scope,
    skillCount: detail.skillCount,
    mcpCount: detail.mcpCount,
    hookCount: detail.hookCount
  }
  if (detail.version) summary.version = detail.version
  return summary
}

function makeInvalidDetail(
  pluginId: string,
  reason: string,
  extras?: {
    displayName?: string
    version?: string
    skillNames?: string[]
    mcpNames?: string[]
    hookNames?: string[]
  }
): RuntimePluginDetail {
  const skillNames = extras?.skillNames ?? []
  const mcpNames = extras?.mcpNames ?? []
  const hookNames = extras?.hookNames ?? []
  const detail: RuntimePluginDetail = {
    pluginId,
    displayName: extras?.displayName ?? pluginId,
    status: 'invalid',
    scope: MANAGED_GROK_PLUGIN_SCOPE,
    skillCount: skillNames.length,
    mcpCount: mcpNames.length,
    hookCount: hookNames.length,
    skillNames,
    mcpNames,
    hookNames,
    invalidReason: reason
  }
  if (extras?.version) detail.version = extras.version
  return detail
}

function isPathInside(root: string, target: string): boolean {
  const comparedRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const comparedTarget = process.platform === 'win32' ? target.toLowerCase() : target
  const child = relative(comparedRoot, comparedTarget)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
  return isErrno(error, 'ENOENT')
}

function isNotDirectory(error: unknown): boolean {
  return isErrno(error, 'ENOTDIR')
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
