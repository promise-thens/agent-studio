import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { getManagedGrokHome } from '../../provider/grok-provider-config'
import {
  parseMarketplacePluginSummary,
  type MarketplacePluginSummary
} from '../../../shared/runtime-marketplace-plugin'
import { isPathInside } from './grok-shared-memory'

const MARKETPLACE_CACHE_DIR = 'marketplace-cache'
const INSTALLED_PLUGINS_DIR = 'installed-plugins'
const INSTALLED_REGISTRY_FILE = 'registry.json'
const MARKETPLACE_JSON = join('.grok-plugin', 'marketplace.json')
const PLUGIN_INDEX_JSON = join('.grok-plugin', 'plugin-index.json')
const MAX_JSON_BYTES = 64 * 1024

type JsonRead =
  { kind: 'missing' } | { kind: 'ok'; value: Record<string, unknown> } | { kind: 'invalid' }

interface ComponentCounts {
  skillCount?: number
  mcpCount?: number
  hookCount?: number
}

/**
 * 只读扫描 App grok-home 的 marketplace-cache 货架。
 * cache 缺失返回 [] 且不 mkdir，不算错误；源目录 realpath 一旦逃出 grok-home 则跳过该源。
 * 每条结果必须经过 parseMarketplacePluginSummary，避免 path / sha / url 漏到 Renderer。
 */
export async function listGrokMarketplacePlugins(
  userDataPath: string
): Promise<MarketplacePluginSummary[]> {
  const grokHome = await resolveManagedGrokHome(userDataPath)
  if (!grokHome) return []

  const cacheRoot = await resolveDirectoryInside(grokHome, join(grokHome, MARKETPLACE_CACHE_DIR))
  if (!cacheRoot) return []

  let entries: string[]
  try {
    entries = await fs.readdir(cacheRoot)
  } catch {
    return []
  }

  const installedNames = await readInstalledCatalogNames(grokHome)
  const summaries: MarketplacePluginSummary[] = []

  for (const entryName of entries) {
    const sourceCanonical = await resolveDirectoryInside(grokHome, join(cacheRoot, entryName))
    if (!sourceCanonical) continue
    summaries.push(...(await readSourceCatalog(grokHome, sourceCanonical, installedNames)))
  }

  return summaries.sort((left, right) => {
    const bySource = compareAscii(left.sourceName, right.sourceName)
    if (bySource !== 0) return bySource
    return compareAscii(left.name, right.name)
  })
}

/**
 * 解析受管 grok-home：必须真实存在且落在 userData 内。
 * 缺失或逃逸一律视为没有货架，避免扫到用户 ~/.grok。
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
 * 从 installed-plugins/registry.json 收集「货架名」集合。
 * 只认 marketplace.plugin_subdir 精确相等，或 plugins 键精确相等；禁止用前缀去猜。
 * 不读取、不返回 registry 的 path / source_url_or_path。
 */
async function readInstalledCatalogNames(grokHome: string): Promise<Set<string>> {
  const installedRoot = await resolveDirectoryInside(
    grokHome,
    join(grokHome, INSTALLED_PLUGINS_DIR)
  )
  if (!installedRoot) return new Set()

  const json = await readJsonInside(grokHome, join(installedRoot, INSTALLED_REGISTRY_FILE))
  if (json.kind !== 'ok') return new Set()
  if (json.value.version !== 1 || !isPlainRecord(json.value.repos)) return new Set()

  const names = new Set<string>()
  for (const repoValue of Object.values(json.value.repos)) {
    if (!isPlainRecord(repoValue)) continue
    const marketplace = isPlainRecord(repoValue.marketplace) ? repoValue.marketplace : null
    const pluginSubdir = marketplace?.plugin_subdir
    if (typeof pluginSubdir === 'string' && pluginSubdir.length > 0) {
      names.add(pluginSubdir)
    }
    if (isPlainRecord(repoValue.plugins)) {
      for (const pluginId of Object.keys(repoValue.plugins)) {
        if (pluginId.length > 0) names.add(pluginId)
      }
    }
  }
  return names
}

/**
 * 读取单个市场源的 marketplace.json，并用可选 plugin-index.json 填计数。
 * 源 name 取 json.name（如 xai-official），绝不用 git URL 或目录 hash。
 */
async function readSourceCatalog(
  grokHome: string,
  sourceCanonical: string,
  installedNames: ReadonlySet<string>
): Promise<MarketplacePluginSummary[]> {
  const marketplace = await readJsonInside(grokHome, join(sourceCanonical, MARKETPLACE_JSON))
  if (marketplace.kind !== 'ok') return []
  if (typeof marketplace.value.name !== 'string' || marketplace.value.name.length === 0) {
    return []
  }
  if (!Array.isArray(marketplace.value.plugins)) return []

  const sourceName = marketplace.value.name
  const index = await readPluginIndex(grokHome, sourceCanonical)
  const summaries: MarketplacePluginSummary[] = []

  for (const pluginValue of marketplace.value.plugins) {
    if (!isPlainRecord(pluginValue) || typeof pluginValue.name !== 'string') continue
    const counts = index.get(pluginValue.name) ?? {}
    const parsed = parseMarketplacePluginSummary({
      name: pluginValue.name,
      displayName: pluginValue.name,
      description: pluginValue.description,
      sourceName,
      installed: installedNames.has(pluginValue.name),
      ...counts
    })
    if (parsed) summaries.push(parsed)
  }

  return summaries
}

/** 缺 index 或某插件无 components 数组时省略计数，不编造 0。 */
async function readPluginIndex(
  grokHome: string,
  sourceCanonical: string
): Promise<Map<string, ComponentCounts>> {
  const json = await readJsonInside(grokHome, join(sourceCanonical, PLUGIN_INDEX_JSON))
  const counts = new Map<string, ComponentCounts>()
  if (json.kind !== 'ok' || !isPlainRecord(json.value.plugins)) return counts

  for (const [pluginName, pluginValue] of Object.entries(json.value.plugins)) {
    if (!isPlainRecord(pluginValue) || !isPlainRecord(pluginValue.components)) continue
    const next: ComponentCounts = {}
    const skillCount = arrayLength(pluginValue.components.skills)
    const mcpCount = arrayLength(pluginValue.components.mcpServers)
    const hookCount = arrayLength(pluginValue.components.hooks)
    if (skillCount !== undefined) next.skillCount = skillCount
    if (mcpCount !== undefined) next.mcpCount = mcpCount
    if (hookCount !== undefined) next.hookCount = hookCount
    if (skillCount !== undefined || mcpCount !== undefined || hookCount !== undefined) {
      counts.set(pluginName, next)
    }
  }
  return counts
}

/** JSON 的 realpath 必须在 grok-home 内；超限、非对象或逃逸都当无效，避免把外部清单读进 DTO。 */
async function readJsonInside(grokHome: string, filePath: string): Promise<JsonRead> {
  const resolved = await realpathExisting(filePath)
  if (resolved.kind === 'missing') return { kind: 'missing' }
  if (resolved.kind === 'invalid') return { kind: 'invalid' }
  if (!isPathInside(grokHome, resolved.canonical)) return { kind: 'invalid' }

  try {
    const stats = await fs.stat(resolved.canonical)
    if (!stats.isFile() || stats.size > MAX_JSON_BYTES) return { kind: 'invalid' }
    const parsed: unknown = JSON.parse(await fs.readFile(resolved.canonical, 'utf8'))
    if (!isPlainRecord(parsed)) return { kind: 'invalid' }
    return { kind: 'ok', value: parsed }
  } catch {
    return { kind: 'invalid' }
  }
}

/**
 * 目录 realpath 必须仍在 grok-home 内。
 * symlink 逃逸或目标不是目录时跳过该项，不抛错、不跟随到 ~/.grok。
 */
async function resolveDirectoryInside(
  grokHome: string,
  directoryPath: string
): Promise<string | null> {
  const resolved = await realpathExisting(directoryPath)
  if (resolved.kind !== 'ok') return null
  if (!isPathInside(grokHome, resolved.canonical)) return null
  try {
    const stats = await fs.stat(resolved.canonical)
    return stats.isDirectory() ? resolved.canonical : null
  } catch {
    return null
  }
}

async function realpathExisting(
  path: string
): Promise<{ kind: 'missing' } | { kind: 'ok'; canonical: string } | { kind: 'invalid' }> {
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

function arrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined
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
