import { promises as fs } from 'node:fs'
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readMarketplaceSourceUrlMatches } from './grok-marketplace-sources'

const temporaryDirectories: string[] = []
const OFFICIAL_URL = 'https://github.com/xai-org/plugin-marketplace.git'

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function createHome(name = 'grok-home'): Promise<{ root: string; home: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-studio-mkt-source-')))
  temporaryDirectories.push(root)
  const home = join(root, name)
  await mkdir(home, { recursive: true })
  return { root, home }
}

/** 写入受管 App 的来源配置，不借用用户真机配置。 */
async function writeSources(
  home: string,
  sources: ReadonlyArray<{ name: string; git: string }>
): Promise<void> {
  const text = sources
    .map((source) =>
      [
        '[[marketplace.sources]]',
        `name = ${JSON.stringify(source.name)}`,
        `git = ${JSON.stringify(source.git)}`
      ].join('\n')
    )
    .join('\n\n')
  await writeFile(join(home, 'config.toml'), `${text}\n`, 'utf8')
}

/** 创建纯本地 .git/config 夹具；不会运行 clone、fetch 或插件脚本。 */
async function writeOrigin(
  home: string,
  directory: string,
  git: string,
  extra = ''
): Promise<void> {
  const gitDirectory = join(home, 'marketplace-cache', directory, '.git')
  await mkdir(gitDirectory, { recursive: true })
  await writeFile(
    join(gitDirectory, 'config'),
    `[remote "origin"]\n  url = ${git}\n${extra}`,
    'utf8'
  )
}

function cannotCreateSymlink(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'EPERM' || error.code === 'EACCES')
  )
}

describe('Grok 市场来源 URL 匹配', () => {
  it('只用配置 URL 与缓存 origin 精确匹配，不按目录名或货架自报名猜来源', async () => {
    const { home } = await createHome()
    const customUrl = 'https://example.test/custom-marketplace.git'
    await writeSources(home, [
      { name: 'configured-official', git: OFFICIAL_URL },
      { name: 'configured-custom', git: customUrl }
    ])
    await writeOrigin(home, 'random-cache-a', OFFICIAL_URL)
    await writeOrigin(home, 'xai-official', 'https://example.test/unconfigured.git')
    await writeOrigin(home, 'random-cache-b', customUrl)

    await expect(
      readMarketplaceSourceUrlMatches(home, ['random-cache-a', 'xai-official', 'random-cache-b'])
    ).resolves.toEqual([
      {
        cacheDirectory: 'random-cache-a',
        sourceName: 'configured-official',
        gitUrl: OFFICIAL_URL
      },
      {
        cacheDirectory: 'random-cache-b',
        sourceName: 'configured-custom',
        gitUrl: customUrl
      }
    ])
  })

  it('拒绝配置重名、URL 重复及同一 URL 的重复缓存，只保留唯一映射', async () => {
    const { home } = await createHome()
    const urls = {
      nameA: 'https://example.test/name-a.git',
      nameB: 'https://example.test/name-b.git',
      shared: 'https://example.test/shared.git',
      repeatedCache: 'https://example.test/repeated-cache.git',
      safe: 'https://example.test/safe.git'
    }
    await writeSources(home, [
      { name: 'duplicate-name', git: urls.nameA },
      { name: 'duplicate-name', git: urls.nameB },
      { name: 'shared-a', git: urls.shared },
      { name: 'shared-b', git: urls.shared },
      { name: 'repeated-cache', git: urls.repeatedCache },
      { name: 'safe', git: urls.safe }
    ])
    for (const [directory, git] of [
      ['name-a', urls.nameA],
      ['name-b', urls.nameB],
      ['shared', urls.shared],
      ['repeat-a', urls.repeatedCache],
      ['repeat-b', urls.repeatedCache],
      ['safe', urls.safe]
    ] as const) {
      await writeOrigin(home, directory, git)
    }

    await expect(
      readMarketplaceSourceUrlMatches(home, [
        'name-a',
        'name-b',
        'shared',
        'repeat-a',
        'repeat-b',
        'safe'
      ])
    ).resolves.toEqual([{ cacheDirectory: 'safe', sourceName: 'safe', gitUrl: urls.safe }])
  })

  it.each([
    '[include]\n  path = /tmp/external-marketplace-config\n',
    '[includeIf "gitdir:/tmp/demo"]\n  path = /tmp/external-marketplace-config\n'
  ])('Git 配置含 include 时拒绝整个来源映射', async (includeBlock) => {
    const { home } = await createHome()
    await writeSources(home, [{ name: 'official', git: OFFICIAL_URL }])
    await writeOrigin(home, 'official-cache', OFFICIAL_URL, includeBlock)

    await expect(readMarketplaceSourceUrlMatches(home, ['official-cache'])).resolves.toEqual([])
  })

  it('同一缓存声明多个 origin 时拒绝映射', async () => {
    const { home } = await createHome()
    await writeSources(home, [{ name: 'official', git: OFFICIAL_URL }])
    await writeOrigin(
      home,
      'official-cache',
      OFFICIAL_URL,
      '[remote "origin"]\n  url = https://example.test/other.git\n'
    )

    await expect(readMarketplaceSourceUrlMatches(home, ['official-cache'])).resolves.toEqual([])
  })

  it('拒绝配置或 Git 元数据符号链接，也不接受越界目录参数', async ({ skip }) => {
    const first = await createHome('first-home')
    const outsideConfig = join(first.root, 'outside-config.toml')
    await writeFile(
      outsideConfig,
      `[[marketplace.sources]]\nname = "official"\ngit = "${OFFICIAL_URL}"\n`,
      'utf8'
    )
    try {
      await symlink(outsideConfig, join(first.home, 'config.toml'))
    } catch (error) {
      if (!cannotCreateSymlink(error)) throw error
      skip('本机无权创建 symlink')
      return
    }
    await expect(readMarketplaceSourceUrlMatches(first.home, ['anything'])).resolves.toEqual([])

    const second = await createHome('second-home')
    await writeSources(second.home, [{ name: 'official', git: OFFICIAL_URL }])
    const outsideGitConfig = join(second.root, 'outside-git-config')
    await writeFile(outsideGitConfig, `[remote "origin"]\n  url = ${OFFICIAL_URL}\n`, 'utf8')
    const gitDirectory = join(second.home, 'marketplace-cache', 'official-cache', '.git')
    await mkdir(gitDirectory, { recursive: true })
    await symlink(outsideGitConfig, join(gitDirectory, 'config'))

    await expect(
      readMarketplaceSourceUrlMatches(second.home, ['official-cache', '../outside'])
    ).resolves.toEqual([])
  })

  it('文件打开后若同一路径换成另一 inode，则拒绝来源 URL 匹配', async () => {
    const { home } = await createHome()
    await writeSources(home, [{ name: 'configured', git: OFFICIAL_URL }])
    await writeOrigin(home, 'cache', OFFICIAL_URL)
    const configPath = join(home, 'config.toml')
    const originalOpen = fs.open.bind(fs)
    let replaced = false
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (!replaced && args[0] === configPath) {
        await rename(configPath, `${configPath}.opened`)
        await writeFile(
          configPath,
          `[[marketplace.sources]]\nname = "replaced"\ngit = "${OFFICIAL_URL}"\n`,
          'utf8'
        )
        replaced = true
      }
      return handle
    })

    await expect(readMarketplaceSourceUrlMatches(home, ['cache'])).resolves.toEqual([])
    expect(replaced).toBe(true)
  })

  it('配置、Git 元数据或来源数量超限时保持未匹配', async () => {
    const oversized = await createHome('oversized-home')
    await writeFile(join(oversized.home, 'config.toml'), 'x'.repeat(64 * 1024 + 1), 'utf8')
    await expect(readMarketplaceSourceUrlMatches(oversized.home, ['cache'])).resolves.toEqual([])

    const gitOversized = await createHome('git-oversized-home')
    await writeSources(gitOversized.home, [{ name: 'official', git: OFFICIAL_URL }])
    await writeOrigin(gitOversized.home, 'cache', OFFICIAL_URL, `# ${'x'.repeat(64 * 1024)}\n`)
    await expect(readMarketplaceSourceUrlMatches(gitOversized.home, ['cache'])).resolves.toEqual([])

    const tooMany = await createHome('too-many-home')
    await writeSources(tooMany.home, [{ name: 'official', git: OFFICIAL_URL }])
    await expect(
      readMarketplaceSourceUrlMatches(
        tooMany.home,
        Array.from({ length: 65 }, (_, index) => `cache-${index}`)
      )
    ).resolves.toEqual([])
  })
})
