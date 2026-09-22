import { constants, promises as fs, type BigIntStats } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { getManagedGrokHome } from '../../provider/grok-provider-config'
import { isRuntimePluginId, parseSafePluginDescription } from '../../../shared/runtime-plugin'
import {
  MAX_PLUGIN_DISCOVERIES,
  isPluginRepositoryKey,
  pluginDiscoveryId,
  type PluginDiscoveryRoot,
  type PluginDiscoverySource,
  type PluginRegistryState,
  type PluginSourceReport,
  type RuntimePluginDiscovery,
  type RuntimePluginDiscoverySnapshot
} from '../../../shared/runtime-plugin-discovery'

const MAX_METADATA_BYTES = 64 * 1024
const ROOTS: PluginDiscoveryRoot[] = ['installed-plugins', 'plugins']
const MANIFESTS = ['.grok-plugin/plugin.json', '.claude-plugin/plugin.json', 'plugin.json']

export interface InstalledPluginRegistryEntry {
  pluginId: string
  candidatePath: string
  version?: string
  /** 仅主进程用于匹配市场来源，绝不进入摘要。 */
  marketplace?: { sourceUrl: string; pluginName: string }
}

type MetadataRead =
  { kind: 'missing' } | { kind: 'invalid' } | { kind: 'ok'; value: Record<string, unknown> }

/** 不跟随任何元数据路径上的符号链接，防止受限清单入口被替换为凭据文件。 */
async function confinedPath(
  root: string,
  candidate: string
): Promise<'missing' | 'invalid' | string> {
  const child = relative(root, candidate)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))
    return 'invalid'
  let current = root
  try {
    for (const part of child.split(sep)) {
      current = join(current, part)
      if ((await fs.lstat(current)).isSymbolicLink()) return 'invalid'
    }
    const canonical = await fs.realpath(candidate)
    return canonical === candidate ? canonical : 'invalid'
  } catch (error) {
    return errno(error, 'ENOENT') || errno(error, 'ENOTDIR') ? 'missing' : 'invalid'
  }
}

/** 文件句柄限量读；打开后复核 canonical path 与 dev/ino，拒绝 symlink、换绑、设备和超大文件。 */
async function readMetadata(root: string, path: string): Promise<MetadataRead> {
  const canonical = await confinedPath(root, path)
  if (canonical === 'missing' || canonical === 'invalid') return { kind: canonical }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile() || stat.size > BigInt(MAX_METADATA_BYTES)) return { kind: 'invalid' }
    if (!(await pathStillNamesOpenedFile(root, canonical, stat))) return { kind: 'invalid' }
    const bytes = Buffer.alloc(MAX_METADATA_BYTES + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > MAX_METADATA_BYTES) return { kind: 'invalid' }
    const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
    return record(value) ? { kind: 'ok', value } : { kind: 'invalid' }
  } catch {
    return { kind: 'invalid' }
  } finally {
    await handle?.close()
  }
}

/** 元数据打开后复核同一路径仍指向同一 inode，并且 realpath 仍受固定根约束。 */
async function pathStillNamesOpenedFile(
  root: string,
  path: string,
  openedStat: BigIntStats
): Promise<boolean> {
  try {
    const canonical = await confinedPath(root, path)
    if (canonical !== path) return false
    const currentStat = await fs.lstat(path, { bigint: true })
    return (
      !currentStat.isSymbolicLink() &&
      currentStat.dev === openedStat.dev &&
      currentStat.ino === openedStat.ino
    )
  } catch {
    return false
  }
}

/** 用户发现仅允许三种固定 manifest；不扫描 Skill、MCP、Hooks 或用户配置。 */
async function readManifest(home: string, directory: string): Promise<MetadataRead> {
  for (const path of MANIFESTS) {
    const result = await readMetadata(home, join(directory, path))
    if (result.kind !== 'missing') return result
  }
  return { kind: 'missing' }
}

/**
 * 注册表是安装库存的唯一依据；合法空表不回退扫描残留。
 * 仓库键、逻辑插件 ID、真实目录与清单身份分别验证，坏项只影响自身。
 */
export async function readInstalledPluginRegistry(home: string): Promise<{
  entries: InstalledPluginRegistryEntry[]
  state: PluginRegistryState
  rejectedCount: number
}> {
  const root = join(home, 'installed-plugins')
  const json = await readMetadata(home, join(root, 'registry.json'))
  if (json.kind !== 'ok') return { entries: [], state: json.kind, rejectedCount: 0 }
  if (json.value.version !== 1 || !record(json.value.repos)) {
    return { entries: [], state: 'invalid', rejectedCount: 0 }
  }
  const entries: InstalledPluginRegistryEntry[] = []
  let rejectedCount = 0
  const repos = Object.entries(json.value.repos)
  for (const [key, repo] of repos.slice(0, MAX_PLUGIN_DISCOVERIES)) {
    if (!isPluginRepositoryKey(key) || !record(repo) || !record(repo.plugins)) {
      rejectedCount++
      continue
    }
    const candidatePath =
      typeof repo.path === 'string'
        ? isAbsolute(repo.path)
          ? repo.path
          : join(root, repo.path)
        : join(root, key)
    const canonical = await confinedPath(root, candidatePath)
    if (canonical === 'missing' || canonical === 'invalid') {
      rejectedCount++
      continue
    }
    const manifest = await readManifest(home, canonical)
    if (manifest.kind !== 'ok' || !isRuntimePluginId(manifest.value.name)) {
      rejectedCount++
      continue
    }
    const names = Object.keys(repo.plugins)
    if (names.length === 0) rejectedCount++
    for (const name of names) {
      if (
        !isRuntimePluginId(name) ||
        name !== manifest.value.name ||
        !record(repo.plugins[name]) ||
        entries.some((item) => item.pluginId === name)
      ) {
        rejectedCount++
        continue
      }
      const entry: InstalledPluginRegistryEntry = { pluginId: name, candidatePath: canonical }
      const version = safeLabel(manifest.value.version, 64)
      if (version) entry.version = version
      if (
        record(repo.marketplace) &&
        typeof repo.marketplace.source_url_or_path === 'string' &&
        isRuntimePluginId(repo.marketplace.plugin_subdir)
      ) {
        entry.marketplace = {
          sourceUrl: repo.marketplace.source_url_or_path,
          pluginName: repo.marketplace.plugin_subdir
        }
      }
      entries.push(entry)
    }
  }
  rejectedCount += Math.max(0, repos.length - MAX_PLUGIN_DISCOVERIES)
  return {
    entries,
    state: rejectedCount > 0 ? 'partial' : repos.length === 0 ? 'empty' : 'ready',
    rejectedCount
  }
}

/**
 * 主进程固定发现 App Home 与用户 Home 的两个插件根。
 * 测试通过 osHome 注入假目录；绝不改 GROK_HOME、不复制插件、不读取信任与密钥。
 */
export async function listGrokPluginDiscoveries(
  userDataPath: string,
  osHome: string = homedir()
): Promise<RuntimePluginDiscoverySnapshot> {
  const items: RuntimePluginDiscovery[] = []
  const sources: PluginSourceReport[] = []
  for (const source of ['app', 'user'] as const) {
    const parent = source === 'app' ? userDataPath : osHome
    const requestedHome = source === 'app' ? getManagedGrokHome(parent) : join(parent, '.grok')
    const report: PluginSourceReport = {
      source,
      state: 'missing',
      registryState: 'missing',
      rejectedCount: 0,
      truncated: false
    }
    sources.push(report)
    let parentCanonical: string
    try {
      parentCanonical = await fs.realpath(parent)
    } catch (error) {
      if (!errno(error, 'ENOENT')) report.state = 'invalid'
      continue
    }
    const home = await confinedPath(
      parentCanonical,
      join(parentCanonical, relative(parent, requestedHome))
    )
    if (home === 'missing' || home === 'invalid') {
      report.state = home
      continue
    }
    report.state = 'ready'
    const registry = await readInstalledPluginRegistry(home)
    report.registryState = registry.state
    report.rejectedCount = registry.rejectedCount
    const registered = new Set(registry.entries.map((entry) => entry.candidatePath))
    let visited = 0
    for (const root of ROOTS) {
      const rootPath = await confinedPath(home, join(home, root))
      if (rootPath === 'missing') continue
      if (rootPath === 'invalid') {
        report.rejectedCount++
        report.state = 'invalid'
        continue
      }
      try {
        const directory = await fs.opendir(rootPath)
        for await (const entry of directory) {
          if (++visited > MAX_PLUGIN_DISCOVERIES) {
            report.truncated = true
            break
          }
          if (
            !isPluginRepositoryKey(entry.name) ||
            (!entry.isDirectory() && !entry.isSymbolicLink())
          )
            continue
          const path = join(rootPath, entry.name)
          if (source === 'app' && root === 'installed-plugins' && registered.has(path)) continue
          const item = await discoverDirectory(home, path, source, root, entry.name)
          // 有清单的 App drop-in 由原应用库存展示，不重复算作发现项。
          if (source === 'app' && root === 'plugins' && item.state === 'identified') continue
          if (item.state === 'invalid') report.rejectedCount++
          items.push(item)
        }
      } catch {
        report.state = 'invalid'
        report.rejectedCount++
      }
    }
  }
  return { items: items.sort((a, b) => a.discoveryId.localeCompare(b.discoveryId)), sources }
}

/** 清单缺失时只返回真实目录名，不能臆造 pluginId、版本或组件数。 */
async function discoverDirectory(
  home: string,
  path: string,
  source: PluginDiscoverySource,
  root: PluginDiscoveryRoot,
  directoryName: string
): Promise<RuntimePluginDiscovery> {
  const item: RuntimePluginDiscovery = {
    discoveryId: pluginDiscoveryId(source, root, directoryName),
    source,
    root,
    directoryName,
    state: 'unidentified'
  }
  const canonical = await confinedPath(home, path)
  if (canonical === 'invalid' || canonical === 'missing') return { ...item, state: 'invalid' }
  const manifest = await readManifest(home, canonical)
  if (manifest.kind === 'missing') return item
  if (manifest.kind !== 'ok' || !isRuntimePluginId(manifest.value.name)) {
    return { ...item, state: 'invalid' }
  }
  item.state = 'identified'
  item.pluginId = manifest.value.name
  item.displayName = safeLabel(manifest.value.displayName, 256) ?? manifest.value.name
  const version = safeLabel(manifest.value.version, 64)
  if (version) item.version = version
  const description = parseSafePluginDescription(manifest.value.description)
  if (description) item.description = description
  return item
}

/**
 * 受控定位重新发现并校验 ID，只允许固定根下一层真实目录。
 * 返回路径仅供主进程 shell.openPath 使用，不得经 IPC 回传。
 */
export async function resolveGrokPluginDiscoveryDirectory(
  userDataPath: string,
  discoveryId: string,
  osHome: string = homedir()
): Promise<string | null> {
  if (typeof discoveryId !== 'string' || discoveryId.length > 320) return null
  const snapshot = await listGrokPluginDiscoveries(userDataPath, osHome)
  const item = snapshot.items.find((item) => item.discoveryId === discoveryId)
  if (!item || item.state === 'invalid') return null
  try {
    const parent = item.source === 'app' ? userDataPath : osHome
    const requestedHome = item.source === 'app' ? getManagedGrokHome(parent) : join(parent, '.grok')
    const parentCanonical = await fs.realpath(parent)
    const canonicalHome = await confinedPath(
      parentCanonical,
      join(parentCanonical, relative(parent, requestedHome))
    )
    if (canonicalHome === 'missing' || canonicalHome === 'invalid') return null
    const path = await confinedPath(
      canonicalHome,
      join(canonicalHome, item.root, item.directoryName)
    )
    if (path === 'missing' || path === 'invalid') return null
    const expected = await fs.stat(path, { bigint: true })
    if (!expected.isDirectory()) return null
    // shell.openPath 前重新跑完整路径牢笼并比较目录 inode，拒绝发现后被同路径替换。
    const revalidated = await confinedPath(canonicalHome, path)
    if (revalidated !== path) return null
    const current = await fs.stat(revalidated, { bigint: true })
    return current.isDirectory() && current.dev === expected.dev && current.ino === expected.ino
      ? revalidated
      : null
  } catch {
    return null
  }
}

/** 标签不能含路径分隔或控制字符，避免把元数据伪装成路径和多行状态。 */
function safeLabel(value: unknown, max: number): string | undefined {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/[\p{Cc}/\\]/u.test(value)
    ? value.trim()
    : undefined
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
