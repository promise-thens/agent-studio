import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ProviderRuntimeConfig } from './provider-config-store'

export const AGENT_STUDIO_MODEL_ALIAS = 'agent-studio-default'
export const AGENT_STUDIO_MODEL_API_KEY_ENV = 'AGENT_STUDIO_MODEL_API_KEY'

/** 返回 Agent Studio 独立管理的 Grok Home，避免修改用户自己的 ~/.grok。 */
export function getManagedGrokHome(userDataPath: string): string {
  return join(userDataPath, 'grok-home')
}

/**
 * 生成不包含明文 Key 的 Grok 配置。
 * JSON 字符串字面量与 TOML basic string 兼容，可安全转义引号和换行。
 */
export function buildGrokProviderConfig(config: ProviderRuntimeConfig): string {
  const displayName = config.modelDisplayName?.trim() || config.modelId
  const lines = [
    `[model.${AGENT_STUDIO_MODEL_ALIAS}]`,
    `model = ${tomlString(config.modelId)}`,
    `base_url = ${tomlString(config.baseUrl)}`,
    `name = ${tomlString(displayName)}`,
    ...(config.authMode === 'bearer'
      ? [`env_key = ${tomlString(AGENT_STUDIO_MODEL_API_KEY_ENV)}`]
      : []),
    'api_backend = "chat_completions"',
    'context_window = 32768',
    '',
    '[shell_environment_policy]',
    'inherit = "core"',
    'ignore_default_excludes = false',
    `exclude = [${[AGENT_STUDIO_MODEL_API_KEY_ENV, 'XAI_API_KEY', 'GROK_CODE_XAI_API_KEY']
      .map(tomlString)
      .join(', ')}]`,
    ''
  ]

  return lines.join('\n')
}

/** 原子写入 App 专属 config.toml，并尽量收紧目录和文件权限。 */
export async function writeGrokProviderConfig(
  userDataPath: string,
  config: ProviderRuntimeConfig
): Promise<string> {
  const grokHome = getManagedGrokHome(userDataPath)
  const configPath = join(grokHome, 'config.toml')
  const temporaryPath = join(grokHome, `config.toml.tmp-${process.pid}-${Date.now()}`)

  await fs.mkdir(grokHome, { recursive: true, mode: 0o700 })
  await chmodBestEffort(grokHome, 0o700)

  try {
    await fs.writeFile(temporaryPath, buildGrokProviderConfig(config), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    await fs.rename(temporaryPath, configPath)
    await chmodBestEffort(configPath, 0o600)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }

  return grokHome
}

/** 清除已生成的 Provider 配置；用户自己的 Grok 配置不受影响。 */
export async function clearGrokProviderConfig(userDataPath: string): Promise<void> {
  await fs.rm(join(getManagedGrokHome(userDataPath), 'config.toml'), { force: true })
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

async function chmodBestEffort(path: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return
  await fs.chmod(path, mode).catch(() => undefined)
}
