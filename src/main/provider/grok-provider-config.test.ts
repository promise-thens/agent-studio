import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_STUDIO_MODEL_API_KEY_ENV,
  buildGrokProviderConfig,
  clearGrokProviderConfig,
  getManagedGrokHome,
  writeGrokProviderConfig
} from './grok-provider-config'
import type { ProviderRuntimeConfig } from './provider-config-store'

const baseConfig: ProviderRuntimeConfig = {
  baseUrl: 'https://api.example.com/v1',
  authMode: 'bearer',
  apiKey: 'test-secret-key',
  modelId: 'model-1',
  modelDisplayName: 'Model One',
  updatedAt: '2026-08-07T00:00:00.000Z'
}

describe('buildGrokProviderConfig', () => {
  it('只写入模型元数据和环境变量名，不写入明文 Key', () => {
    const result = buildGrokProviderConfig(baseConfig)

    expect(result).toContain('model = "model-1"')
    expect(result).toContain('name = "Model One"')
    expect(result).toContain(`env_key = "${AGENT_STUDIO_MODEL_API_KEY_ENV}"`)
    expect(result).not.toContain('test-secret-key')
  })

  it('无认证服务不生成 env_key', () => {
    const result = buildGrokProviderConfig({
      ...baseConfig,
      authMode: 'none',
      apiKey: undefined
    })

    expect(result).not.toContain('env_key =')
  })

  it('过滤工具环境中的模型凭据并安全转义 TOML 字符串', () => {
    const result = buildGrokProviderConfig({
      ...baseConfig,
      modelId: 'model"quoted',
      modelDisplayName: undefined
    })

    expect(result).toContain('model = "model\\"quoted"')
    expect(result).toContain(`"${AGENT_STUDIO_MODEL_API_KEY_ENV}"`)
    expect(result).toContain('ignore_default_excludes = false')
  })

  it('不写死 context_window，窗口交给 Grok 原生配置', () => {
    const result = buildGrokProviderConfig(baseConfig)

    expect(result).not.toContain('context_window')
  })
})

describe('writeGrokProviderConfig', () => {
  const dirs: string[] = []

  afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('合并写入且不修改假 ~/.grok/config.toml', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grok-provider-write-'))
    dirs.push(root)
    const userGrok = join(root, '.grok')
    await mkdir(userGrok, { recursive: true })
    const userConfig = join(userGrok, 'config.toml')
    await writeFile(userConfig, '[ui]\nvim_mode = true\n', 'utf8')
    const grokHome = await writeGrokProviderConfig(root, baseConfig, {
      userMemoryDir: join(userGrok, 'memory')
    })
    const appToml = await readFile(join(grokHome, 'config.toml'), 'utf8')
    expect(appToml).toContain('[model.agent-studio-default]')
    expect(appToml).toContain('[memory]')
    expect(appToml).not.toContain('test-secret-key')
    expect(appToml).not.toContain('context_window')
    expect(await readFile(userConfig, 'utf8')).toBe('[ui]\nvim_mode = true\n')
  })

  it('重写供应商绑定时保留用户在 Grok 配置里写的 context_window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grok-provider-preserve-window-'))
    dirs.push(root)
    const userMemoryDir = join(root, '.grok', 'memory')
    const grokHome = await writeGrokProviderConfig(root, baseConfig, { userMemoryDir })
    const appConfig = join(grokHome, 'config.toml')
    const seeded = await readFile(appConfig, 'utf8')
    await writeFile(
      appConfig,
      seeded.replace(
        'api_backend = "chat_completions"',
        'api_backend = "chat_completions"\ncontext_window = 500000'
      ),
      'utf8'
    )

    await writeGrokProviderConfig(
      root,
      { ...baseConfig, modelId: 'model-2', modelDisplayName: 'Model Two' },
      { userMemoryDir }
    )

    const next = await readFile(appConfig, 'utf8')
    expect(next).toContain('model = "model-2"')
    expect(next).toContain('name = "Model Two"')
    expect(next).toContain('context_window = 500000')
    expect(next).not.toContain('context_window = 32768')
  })

  it('重写模型表时丢掉明文 api_key，不把密钥写回 Grok 配置', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grok-provider-drop-key-'))
    dirs.push(root)
    const userMemoryDir = join(root, '.grok', 'memory')
    const grokHome = await writeGrokProviderConfig(root, baseConfig, { userMemoryDir })
    const appConfig = join(grokHome, 'config.toml')
    const seeded = await readFile(appConfig, 'utf8')
    await writeFile(
      appConfig,
      seeded.replace(
        'api_backend = "chat_completions"',
        'api_backend = "chat_completions"\napi_key = "sk-test-not-real"'
      ),
      'utf8'
    )

    await writeGrokProviderConfig(root, baseConfig, { userMemoryDir })

    const next = await readFile(appConfig, 'utf8')
    expect(next).not.toContain('api_key')
    expect(next).not.toContain('sk-test-not-real')
  })
})

describe('clearGrokProviderConfig', () => {
  const dirs: string[] = []

  afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('只删除 App grok-home/config.toml，不碰假 ~/.grok/config.toml', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grok-provider-clear-'))
    dirs.push(root)
    const userGrok = join(root, '.grok')
    await mkdir(userGrok, { recursive: true })
    const userConfig = join(userGrok, 'config.toml')
    await writeFile(userConfig, '[ui]\nvim_mode = true\n', 'utf8')

    const grokHome = await writeGrokProviderConfig(root, baseConfig, {
      userMemoryDir: join(userGrok, 'memory')
    })
    expect(grokHome).toBe(getManagedGrokHome(root))
    const appConfig = join(grokHome, 'config.toml')
    await expect(readFile(appConfig, 'utf8')).resolves.toContain('[model.agent-studio-default]')

    await clearGrokProviderConfig(root)

    await expect(readFile(appConfig, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(userConfig, 'utf8')).toBe('[ui]\nvim_mode = true\n')
  })
})
