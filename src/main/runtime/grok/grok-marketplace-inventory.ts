import { constants, promises as fs, type BigIntStats } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { getManagedGrokHome } from '../../provider/grok-provider-config'
import {
  parseMarketplacePluginSummary,
  type MarketplacePluginSummary
} from '../../../shared/runtime-marketplace-plugin'
import { isPathInside } from './grok-shared-memory'
import { readInstalledPluginRegistry } from './grok-plugin-inventory-discovery'
import {
  readMarketplaceSourceUrlMatches,
  type MarketplaceSourceUrlMatch
} from './grok-marketplace-sources'

const MARKETPLACE_CACHE_DIR = 'marketplace-cache'
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
  // 这里只记录两个本地 URL 是否相同；不得据此宣称来源官方、可信或未经改写。
  const sources = await readMarketplaceSourceUrlMatches(grokHome, entries)
  const summaries: MarketplacePluginSummary[] = []

  for (const entryName of entries) {
    const sourceCanonical = await resolveDirectoryInside(grokHome, join(cacheRoot, entryName))
    if (!sourceCanonical) continue
    const matches = sources.filter((source) => source.cacheDirectory === entryName)
    const source = matches.length === 1 ? matches[0] : undefined
    summaries.push(...(await readSourceCatalog(grokHome, sourceCanonical, installedNames, source)))
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
 * 只有通过目录与清单验证的 App 注册项才算安装。
 * 来源 URL 和市场名一起精确匹配，绝不让用户插件或另一个同名源顶替。
 */
async function readInstalledCatalogNames(grokHome: string): Promise<Set<string>> {
  const names = new Set<string>()
  for (const entry of (await readInstalledPluginRegistry(grokHome)).entries) {
    if (entry.marketplace) {
      names.add(JSON.stringify([entry.marketplace.sourceUrl, entry.marketplace.pluginName]))
    }
  }
  return names
}

/**
 * 读取单个市场源的 marketplace.json，并用可选 plugin-index.json 填计数。
 * URL 匹配时使用 App 配置中的 name；未匹配时只展示清单自报名。
 * 匹配只用于消歧与安装记录关联，不构成官方或信任证明。
 */
async function readSourceCatalog(
  grokHome: string,
  sourceCanonical: string,
  installedNames: ReadonlySet<string>,
  matchedSource?: MarketplaceSourceUrlMatch
): Promise<MarketplacePluginSummary[]> {
  const marketplace = await readJsonInside(grokHome, join(sourceCanonical, MARKETPLACE_JSON))
  if (marketplace.kind !== 'ok') return []
  if (typeof marketplace.value.name !== 'string' || marketplace.value.name.length === 0) {
    return []
  }
  if (!Array.isArray(marketplace.value.plugins)) return []

  const sourceName = matchedSource?.sourceName ?? marketplace.value.name
  const sourceId = createHash('sha256').update(sourceCanonical).digest('hex')
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
      sourceId,
      sourceUrlMatched: Boolean(matchedSource),
      installed: Boolean(
        matchedSource &&
        installedNames.has(JSON.stringify([matchedSource.gitUrl, pluginValue.name]))
      ),
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

/**
 * JSON 的 realpath 必须在 grok-home 内；打开后再复核 canonical path 与 dev/ino。
 * 超限、非对象、路径换绑或逃逸都当无效，避免把外部清单读进 DTO。
 */
async function readJsonInside(grokHome: string, filePath: string): Promise<JsonRead> {
  const resolved = await realpathExisting(filePath)
  if (resolved.kind === 'missing') return { kind: 'missing' }
  if (resolved.kind === 'invalid') return { kind: 'invalid' }
  if (!isPathInside(grokHome, resolved.canonical)) return { kind: 'invalid' }

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(
      resolved.canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile() || stats.size > BigInt(MAX_JSON_BYTES)) return { kind: 'invalid' }
    if (!(await pathStillNamesOpenedFile(grokHome, resolved.canonical, stats))) {
      return { kind: 'invalid' }
    }
    const bytes = Buffer.alloc(MAX_JSON_BYTES + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > MAX_JSON_BYTES) return { kind: 'invalid' }
    const parsed: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
    if (!isPlainRecord(parsed)) return { kind: 'invalid' }
    return { kind: 'ok', value: parsed }
  } catch {
    return { kind: 'invalid' }
  } finally {
    await handle?.close()
  }
}

/** 复核已打开文件仍由同一路径指向且留在 grok-home，避免 realpath 后被换绑。 */
async function pathStillNamesOpenedFile(
  grokHome: string,
  path: string,
  openedStat: BigIntStats
): Promise<boolean> {
  try {
    const [canonical, currentStat] = await Promise.all([
      fs.realpath(path),
      fs.lstat(path, { bigint: true })
    ])
    return (
      canonical === path &&
      isPathInside(grokHome, canonical) &&
      !currentStat.isSymbolicLink() &&
      currentStat.dev === openedStat.dev &&
      currentStat.ino === openedStat.ino
    )
  } catch {
    return false
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
