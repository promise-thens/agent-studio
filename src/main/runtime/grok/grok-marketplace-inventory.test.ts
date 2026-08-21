import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getManagedGrokHome } from '../../provider/grok-provider-config'
import { listGrokMarketplacePlugins } from './grok-marketplace-inventory'

const temporaryDirectories: string[] = []

/** 合成 19 项货架名；禁止从用户 ~/.grok 拷贝真机 cache。 */
const SYNTHETIC_CATALOG_NAMES = [
  'chrome-devtools',
  'figma',
  'exa',
  'slack',
  'notion',
  'linear',
  'github',
  'browser',
  'postgres',
  'redis',
  'docker',
  'playwright',
  'sentry',
  'stripe',
  'vercel',
  'supabase',
  'terraform',
  'kubernetes',
  'datadog'
] as const

const FIXTURE_SHA = 'cafebabedeadbeef0123456789abcdef01234567'
const FIXTURE_GIT_URL = 'https://github.com/example/xai-plugin-fixture.git'
const REGISTRY_SOURCE_URL = 'https://github.com/xai-org/plugin-marketplace.git'

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function createUserData(): Promise<string> {
  return createTemporaryDirectory('agent-studio-mkt-inv-')
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function expectNoLeak(value: unknown, forbidden: string[]): void {
  const text = JSON.stringify(value)
  for (const item of forbidden) {
    expect(text).not.toContain(item)
  }
}

function isSymlinkPrivilegeError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'EPERM' || error.code === 'EACCES')
  )
}

/** Windows 未开开发人员模式时无法建 symlink，跳过而不是把套件打红。 */
async function symlinkOrSkip(
  skip: (reason?: string) => void,
  target: string,
  linkPath: string
): Promise<boolean> {
  try {
    await symlink(target, linkPath)
    return true
  } catch (error) {
    if (!isSymlinkPrivilegeError(error)) throw error
    skip('本机无权创建 symlink')
    return false
  }
}

async function writeMarketplaceSource(
  grokHome: string,
  sourceDirName: string,
  marketplace: unknown,
  pluginIndex?: unknown
): Promise<string> {
  const sourceDir = join(grokHome, 'marketplace-cache', sourceDirName)
  const pluginMeta = join(sourceDir, '.grok-plugin')
  await mkdir(pluginMeta, { recursive: true })
  await writeJson(join(pluginMeta, 'marketplace.json'), marketplace)
  if (pluginIndex !== undefined) {
    await writeJson(join(pluginMeta, 'plugin-index.json'), pluginIndex)
  }
  return sourceDir
}

function buildMarketplacePlugins(names: readonly string[]): Array<{
  name: string
  description: string
  source: { source: string; url: string; sha: string }
}> {
  return names.map((name) => ({
    name,
    description:
      name === 'chrome-devtools' ? 'Connect Grok to Chrome DevTools.' : `Fixture plugin ${name}.`,
    source: {
      source: 'url',
      url: FIXTURE_GIT_URL,
      sha: FIXTURE_SHA
    }
  }))
}

describe('Grok 市场货架只读扫描', () => {
  it('marketplace-cache 不存在时返回空列表，且不创建目录', async () => {
    const userDataPath = await createUserData()
    const grokHome = getManagedGrokHome(userDataPath)

    expect(await listGrokMarketplacePlugins(userDataPath)).toEqual([])
    await expect(realpath(grokHome)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(realpath(join(grokHome, 'marketplace-cache'))).rejects.toMatchObject({
      code: 'ENOENT'
    })

    await mkdir(grokHome, { recursive: true })
    expect(await listGrokMarketplacePlugins(userDataPath)).toEqual([])
    await expect(realpath(join(grokHome, 'marketplace-cache'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('合成 19 项可解析，结果 JSON 不含绝对路径 / sha / url', async () => {
    expect(SYNTHETIC_CATALOG_NAMES).toHaveLength(19)

    const userDataPath = await createUserData()
    const grokHome = getManagedGrokHome(userDataPath)
    const sourceDir = await writeMarketplaceSource(
      grokHome,
      '9f3a2c1b0e8d',
      {
        name: 'xai-official',
        description: 'Official xAI plugin marketplace',
        owner: { name: 'xAI' },
        plugins: buildMarketplacePlugins(SYNTHETIC_CATALOG_NAMES)
      },
      {
        version: 1,
        plugins: {
          'chrome-devtools': {
            sha: FIXTURE_SHA,
            version: '1.7.0',
            components: {
              skills: [{ name: 'chrome-devtools' }],
              mcpServers: [{ name: 'chrome-devtools' }],
              hooks: [{ name: 'SessionStart' }]
            }
          }
        }
      }
    )
    await writeFile(join(grokHome, 'marketplace-cache', 'not-a-source.json'), '{}\n')

    const listed = await listGrokMarketplacePlugins(userDataPath)
    expect(listed).toHaveLength(19)
    expect(listed.map((item) => item.name).sort()).toEqual([...SYNTHETIC_CATALOG_NAMES].sort())
    expect(new Set(listed.map((item) => item.sourceName))).toEqual(new Set(['xai-official']))
    expect(listed.every((item) => item.displayName === item.name)).toBe(true)
    expect(listed.every((item) => item.installed === false)).toBe(true)

    const chrome = listed.find((item) => item.name === 'chrome-devtools')
    expect(chrome).toMatchObject({
      name: 'chrome-devtools',
      displayName: 'chrome-devtools',
      description: 'Connect Grok to Chrome DevTools.',
      sourceName: 'xai-official',
      installed: false,
      skillCount: 1,
      mcpCount: 1,
      hookCount: 1
    })

    const figma = listed.find((item) => item.name === 'figma')
    expect(figma).toMatchObject({
      name: 'figma',
      displayName: 'figma',
      description: 'Fixture plugin figma.',
      sourceName: 'xai-official',
      installed: false
    })
    expect(figma).not.toHaveProperty('skillCount')
    expect(figma).not.toHaveProperty('mcpCount')
    expect(figma).not.toHaveProperty('hookCount')

    for (const item of listed) {
      expect(item).not.toHaveProperty('path')
      expect(item).not.toHaveProperty('sha')
      expect(item).not.toHaveProperty('url')
    }

    const serialized = JSON.stringify(listed)
    expect(serialized).not.toMatch(/"path"/)
    expect(serialized).not.toMatch(/"sha"/)
    expect(serialized).not.toMatch(/"url"/)
    expect(serialized).not.toContain('https://')
    expectNoLeak(listed, [
      userDataPath,
      grokHome,
      sourceDir,
      FIXTURE_SHA,
      FIXTURE_GIT_URL,
      'SessionStart',
      'xAI'
    ])
  })

  it('symlink 逃出 grok-home 的 cache 源跳过，不中断其它源、不泄漏外部路径', async ({ skip }) => {
    const userDataPath = await createUserData()
    const grokHome = getManagedGrokHome(userDataPath)
    await writeMarketplaceSource(grokHome, 'safe-source', {
      name: 'xai-official',
      plugins: [
        {
          name: 'figma',
          description: 'Design handoff helper.',
          source: { source: 'url', url: FIXTURE_GIT_URL, sha: FIXTURE_SHA }
        }
      ]
    })

    const outsideRoot = await createTemporaryDirectory('agent-studio-mkt-outside-')
    const outsideSource = join(outsideRoot, 'leaky-source')
    await mkdir(join(outsideSource, '.grok-plugin'), { recursive: true })
    await writeJson(join(outsideSource, '.grok-plugin', 'marketplace.json'), {
      name: 'stolen-market',
      plugins: [
        {
          name: 'stolen-plugin',
          description: '不该读取',
          source: { source: 'url', url: FIXTURE_GIT_URL, sha: FIXTURE_SHA }
        }
      ]
    })

    const cacheRoot = join(grokHome, 'marketplace-cache')
    if (!(await symlinkOrSkip(skip, outsideSource, join(cacheRoot, 'escaped-source')))) return

    const listed = await listGrokMarketplacePlugins(userDataPath)
    expect(listed).toEqual([
      {
        name: 'figma',
        displayName: 'figma',
        description: 'Design handoff helper.',
        sourceName: 'xai-official',
        installed: false
      }
    ])
    expect(listed.some((item) => item.name === 'stolen-plugin')).toBe(false)
    expectNoLeak(listed, [
      outsideSource,
      outsideRoot,
      userDataPath,
      grokHome,
      FIXTURE_SHA,
      FIXTURE_GIT_URL,
      'stolen-market',
      '不该读取'
    ])
  })

  it('chrome-devtools 经 plugin_subdir 标已装，禁止用 chrome-devtools-mcp 前缀去猜', async () => {
    const userDataPath = await createUserData()
    const grokHome = getManagedGrokHome(userDataPath)
    await writeMarketplaceSource(grokHome, '9f3a2c1b0e8d', {
      name: 'xai-official',
      plugins: [
        {
          name: 'chrome-devtools',
          description: 'Connect Grok to Chrome DevTools.',
          source: { source: 'url', url: FIXTURE_GIT_URL, sha: FIXTURE_SHA }
        },
        {
          name: 'exa',
          description: 'Search helper.',
          source: { source: 'url', url: FIXTURE_GIT_URL, sha: FIXTURE_SHA }
        },
        {
          name: 'linear',
          description: 'Issue tracker helper.',
          source: { source: 'url', url: FIXTURE_GIT_URL, sha: FIXTURE_SHA }
        }
      ]
    })

    const hashedDir = join(grokHome, 'installed-plugins', 'chrome-devtools-mcp-2df60288')
    await mkdir(hashedDir, { recursive: true })
    await writeJson(join(grokHome, 'installed-plugins', 'registry.json'), {
      version: 1,
      repos: {
        'chrome-devtools-mcp-2df60288': {
          path: hashedDir,
          plugins: {
            'chrome-devtools-mcp': { version: '1.7.0' }
          },
          marketplace: {
            plugin_subdir: 'chrome-devtools',
            source_display_name: 'xAI Official',
            source_url_or_path: REGISTRY_SOURCE_URL
          }
        },
        'exa-mcp-00aabbcc': {
          path: join(grokHome, 'installed-plugins', 'exa-mcp-00aabbcc'),
          plugins: {
            'exa-mcp': { version: '0.1.0' }
          }
        },
        'linear-11111111': {
          path: join(grokHome, 'installed-plugins', 'linear-11111111'),
          plugins: {
            linear: { version: '2.0.0' }
          }
        }
      }
    })

    const listed = await listGrokMarketplacePlugins(userDataPath)
    expect(listed).toEqual([
      {
        name: 'chrome-devtools',
        displayName: 'chrome-devtools',
        description: 'Connect Grok to Chrome DevTools.',
        sourceName: 'xai-official',
        installed: true
      },
      {
        name: 'exa',
        displayName: 'exa',
        description: 'Search helper.',
        sourceName: 'xai-official',
        installed: false
      },
      {
        name: 'linear',
        displayName: 'linear',
        description: 'Issue tracker helper.',
        sourceName: 'xai-official',
        installed: true
      }
    ])
    expectNoLeak(listed, [
      hashedDir,
      userDataPath,
      grokHome,
      FIXTURE_SHA,
      FIXTURE_GIT_URL,
      REGISTRY_SOURCE_URL,
      'chrome-devtools-mcp',
      'exa-mcp',
      'source_url_or_path'
    ])
  })
})
