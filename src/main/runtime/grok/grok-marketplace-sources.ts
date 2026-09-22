import { execFile } from 'node:child_process'
import { constants, promises as fs, type BigIntStats } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { buildCommandEnvironment } from '../../command/command-environment'

const MAX_SOURCE_BYTES = 64 * 1024
const MAX_SOURCES = 64
const SOURCE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

/** 仅主进程使用的 URL 匹配事实；URL、缓存目录和 Git 配置不得进入 Renderer。 */
export interface MarketplaceSourceUrlMatch {
  cacheDirectory: string
  sourceName: string
  gitUrl: string
}

/**
 * 只比较 App 配置的 git URL 与对应缓存 origin，不将两个本地可编辑值的相等解释为官方或可信。
 * 缺失、损坏、重复或无法安全读取时仅保持未匹配，不拉网络、不执行插件、不改配置。
 */
export async function readMarketplaceSourceUrlMatches(
  grokHome: string,
  cacheDirectories: readonly string[]
): Promise<MarketplaceSourceUrlMatch[]> {
  const config = await readSourceText(grokHome, join(grokHome, 'config.toml'))
  if (config === null) return []
  const configured = parseConfiguredSources(config)
  if (configured.length === 0 || cacheDirectories.length > MAX_SOURCES) return []

  const candidates: MarketplaceSourceUrlMatch[] = []
  for (const directory of cacheDirectories) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(directory)) continue
    const gitConfig = await readSourceText(
      grokHome,
      join(grokHome, 'marketplace-cache', directory, '.git', 'config')
    )
    if (gitConfig === null) continue
    const origin = await readGitOrigin(grokHome, gitConfig)
    const matches = configured.filter((source) => source.gitUrl === origin)
    if (matches.length === 1) candidates.push({ cacheDirectory: directory, ...matches[0] })
    if (candidates.length > MAX_SOURCES) return []
  }
  // 同一 URL 对应多个缓存也不猜当前生效副本；保留货架展示但不给 URL 匹配或已安装标记。
  return candidates.filter(
    (candidate) => candidates.filter((source) => source.gitUrl === candidate.gitUrl).length === 1
  )
}

/** 只投影 marketplace.sources；任意其他配置值、原始 TOML 和错误都不离开本模块。 */
function parseConfiguredSources(
  text: string
): Array<Omit<MarketplaceSourceUrlMatch, 'cacheDirectory'>> {
  try {
    const parsed = parseToml(text)
    const marketplace = parsed.marketplace
    if (!isRecord(marketplace) || !Array.isArray(marketplace.sources)) return []
    if (marketplace.sources.length > MAX_SOURCES) return []
    const sources = marketplace.sources.flatMap((source) => {
      if (!isRecord(source) || typeof source.name !== 'string' || !SOURCE_NAME.test(source.name)) {
        return []
      }
      if (!isSafeGitUrl(source.git)) return []
      return [{ sourceName: source.name, gitUrl: source.git }]
    })
    return sources.filter(
      (source) =>
        sources.filter(
          (other) => other.sourceName === source.sourceName || other.gitUrl === source.gitUrl
        ).length === 1
    )
  } catch {
    return []
  }
}

/** 仅接受无凭据的明确 HTTPS 身份，精确匹配原串，不将路径、别名或 URL 重写推成官方。 */
function isSafeGitUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || /[\p{Cc}\s]/u.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

/**
 * 固定根内逐层拒绝符号链接，再用不跟随链接的文件句柄限量读取。
 * 打开后复核 canonical path 与 dev/ino，Git 后续只消费句柄读到的字符串。
 */
async function readSourceText(root: string, path: string): Promise<string | null> {
  const child = relative(root, path)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return null
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    let current = root
    for (const part of child.split(sep)) {
      current = join(current, part)
      if ((await fs.lstat(current)).isSymbolicLink()) return null
    }
    if ((await fs.realpath(path)) !== path) return null
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile() || stat.size > BigInt(MAX_SOURCE_BYTES)) return null
    if (!(await pathStillNamesOpenedFile(path, stat))) return null
    const bytes = Buffer.alloc(MAX_SOURCE_BYTES + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    return bytesRead <= MAX_SOURCE_BYTES ? bytes.subarray(0, bytesRead).toString('utf8') : null
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

/** 文件打开后用路径当前身份复核句柄，拒绝校验与读取之间被换成链接或另一 inode。 */
async function pathStillNamesOpenedFile(path: string, openedStat: BigIntStats): Promise<boolean> {
  try {
    const [canonical, currentStat] = await Promise.all([
      fs.realpath(path),
      fs.lstat(path, { bigint: true })
    ])
    return (
      canonical === path &&
      !currentStat.isSymbolicLink() &&
      currentStat.dev === openedStat.dev &&
      currentStat.ino === openedStat.ino
    )
  } catch {
    return false
  }
}

/**
 * Git 仅解析 stdin 中的单份配置：禁 include、全局配置、网络和交互，不访问插件脚本。
 * 复用命令环境白名单隔离凭据；超时、超限、多 origin 或解析失败统一保持未匹配。
 */
async function readGitOrigin(cwd: string, config: string): Promise<string | null> {
  const env = buildCommandEnvironment(process.env)
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['config', '--file', '-', '--no-includes', '--null', '--list'],
      { cwd, env, timeout: 3000, maxBuffer: MAX_SOURCE_BYTES, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        const records = stdout.split('\0')
        if (records.pop() !== '') {
          resolve(null)
          return
        }
        const origins: string[] = []
        for (const record of records) {
          const separator = record.indexOf('\n')
          if (separator <= 0) {
            resolve(null)
            return
          }
          const key = record.slice(0, separator)
          const normalizedKey = key.toLowerCase()
          // 即使 --no-includes 不展开外部文件，也拒绝带 include 的配置，避免来源身份依赖隐藏输入。
          if (normalizedKey.startsWith('include.') || normalizedKey.startsWith('includeif.')) {
            resolve(null)
            return
          }
          if (key === 'remote.origin.url') origins.push(record.slice(separator + 1))
        }
        resolve(origins.length === 1 && isSafeGitUrl(origins[0]) ? origins[0] : null)
      }
    )
    // Git 提前退出时 stdin 可报 EPIPE；结果由 execFile 回调处理，不允许未捕获错误冒泡。
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(config)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
