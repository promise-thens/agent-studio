import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GrokHomeConfigController } from './grok-home-config-controller'

const modelBlock = `[model.agent-studio-default]
model = "model-1"
base_url = "https://api.example.com/v1"
name = "Model One"
env_key = "AGENT_STUDIO_MODEL_API_KEY"
`

describe('GrokHomeConfigController', () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(
      dirs
        .splice(0)
        .map((dir) =>
          import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }))
        )
    )
  })

  async function createController(): Promise<GrokHomeConfigController> {
    const grokHome = await mkdtemp(join(tmpdir(), 'grok-home-config-'))
    dirs.push(grokHome)
    return new GrokHomeConfigController(grokHome)
  }

  it('writeText 含注释的合法 toml 保存后 read 仍含该注释', async () => {
    const controller = await createController()
    const text = `# 保留我
${modelBlock}
[memory]
# 跨会话记忆
enabled = true
`
    await controller.writeText(text)
    expect(await controller.read()).toContain('# 保留我')
    expect(await controller.read()).toContain('# 跨会话记忆')
  })

  it('writeText 含 api_key = sk-test-not-real 被拒绝且文件不变', async () => {
    const controller = await createController()
    await controller.writeText(`${modelBlock}\n[memory]\nenabled = true\n`)
    const before = await controller.read()
    await expect(
      controller.writeText(`${modelBlock}\napi_key = "sk-test-not-real"\n`)
    ).rejects.toThrow(/明文|密钥/)
    expect(await controller.read()).toBe(before)
  })

  it('删掉 [model.agent-studio-default] 的全文被拒绝', async () => {
    const controller = await createController()
    await expect(controller.writeText('[memory]\nenabled = true\n')).rejects.toThrow(/供应商页/)
  })

  it('损坏 toml 拒绝记忆补丁，模型重建带 replacedCorruptFile', async () => {
    const controller = await createController()
    await writeFile(controller.configPath, '[[[not toml', 'utf8')
    await expect(controller.apply({ memoryEnabled: true })).rejects.toThrow(/损坏/)
    const result = await controller.apply({ modelBlock })
    expect(result.replacedCorruptFile).toBe(true)
    expect(await controller.read()).toContain('[model.agent-studio-default]')
  })

  it('enable 后 toml 含该 id；disable 后进入 disabled 列表', async () => {
    const controller = await createController()
    await controller.apply({ modelBlock, pluginsEnabled: ['demo-plugin'] })
    expect(await controller.read()).toContain('"demo-plugin"')
    await controller.apply({
      pluginsEnabled: [],
      pluginsDisabled: ['demo-plugin']
    })
    const text = await controller.read()
    expect(text).toContain('disabled = ["demo-plugin"]')
  })

  it('apply sandboxProfile 走合并写入，缺省读取为 off', async () => {
    const controller = await createController()
    expect(await controller.readSandboxProfile()).toBe('off')
    await controller.apply({
      modelBlock,
      memoryEnabled: true,
      mcpServers: [
        {
          name: 'github',
          enabled: true,
          transport: 'stdio',
          command: '/usr/bin/false',
          args: ['--help']
        }
      ],
      pluginsEnabled: ['demo-plugin']
    })
    await controller.apply({ sandboxProfile: 'read-only' })
    expect(await controller.readSandboxProfile()).toBe('read-only')
    const text = await controller.read()
    expect(text).toContain('[memory]')
    expect(text).toContain('[mcp_servers.github]')
    expect(text).toContain('[plugins]')
    expect(text).toContain('profile = "read-only"')
  })

  it('非法 sandbox profile 拒绝且文件不变', async () => {
    const controller = await createController()
    await controller.apply({ modelBlock, memoryEnabled: true })
    const before = await controller.read()
    await expect(controller.apply({ sandboxProfile: 'devbox' as never })).rejects.toThrow(
      /sandbox profile 无效/
    )
    expect(await controller.read()).toBe(before)
    expect(await controller.readSandboxProfile()).toBe('off')
  })

  it('磁盘上的非法 sandbox 值读取时抛错，不降成 off', async () => {
    const controller = await createController()
    await writeFile(
      controller.configPath,
      `${modelBlock}
[sandbox]
profile = "devbox"
`,
      'utf8'
    )
    await expect(controller.readSandboxProfile()).rejects.toThrow(/sandbox profile 无效/)
  })

  it('损坏 toml 拒绝 sandbox 补丁', async () => {
    const controller = await createController()
    await writeFile(controller.configPath, '[[[not toml', 'utf8')
    await expect(controller.apply({ sandboxProfile: 'workspace' })).rejects.toThrow(/损坏/)
    expect(await controller.read()).toBe('[[[not toml')
  })
})
