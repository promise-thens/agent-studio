import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ProviderRuntimeConfig } from './provider-config-store'
import { AGENT_STUDIO_MODEL_ALIAS } from '../runtime/grok/grok-acp-dialect'
import { GrokHomeConfigController, hasTomlTable } from '../runtime/grok/grok-home-config-controller'
import { splitTomlTables } from '../runtime/grok/grok-config-merge'
import { ensureSharedGrokMemory, getUserGrokMemoryDir } from '../runtime/grok/grok-shared-memory'

/** 方言模块为 source of truth；此处 re-export 保持既有 Provider 导入路径。 */
export { AGENT_STUDIO_MODEL_ALIAS } from '../runtime/grok/grok-acp-dialect'
export const AGENT_STUDIO_MODEL_API_KEY_ENV = 'AGENT_STUDIO_MODEL_API_KEY'

/** 供应商页负责的绑定字段；其余 Grok 原生键留给用户 toml。 */
const PROVIDER_MANAGED_MODEL_KEYS = new Set(['model', 'base_url', 'name', 'env_key', 'api_backend'])

/** 模型表里禁止从旧文件带过来的密钥或请求头，避免写回明文。 */
const FORBIDDEN_MODEL_KEYS = new Set([
  'api_key',
  'extra_headers',
  'env_http_headers',
  'query_params',
  'env',
  'headers'
])

const SECRET_MODEL_KEY_PATTERN = /(?:^|_)(api[_-]?key|token|secret|password|authorization)$/i

/** 返回 Agent Studio 独立管理的 Grok Home，避免修改用户自己的 ~/.grok。 */
export function getManagedGrokHome(userDataPath: string): string {
  return join(userDataPath, 'grok-home')
}

/**
 * 生成不包含明文 Key 的 Grok 配置。
 * JSON 字符串字面量与 TOML basic string 兼容，可安全转义引号和换行。
 * 不写死 context_window：那是 Grok 原生字段，由用户在 App config.toml 里改。
 */
export function buildGrokProviderConfig(
  config: ProviderRuntimeConfig,
  options: { userModelLines?: readonly string[] } = {}
): string {
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
    ...sanitizeUserModelLines(options.userModelLines),
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

/** 合并写入 App 专属 config.toml，并连接共享记忆目录。不得整文件覆盖。 */
export async function writeGrokProviderConfig(
  userDataPath: string,
  config: ProviderRuntimeConfig,
  options: { userMemoryDir?: string } = {}
): Promise<string> {
  const grokHome = getManagedGrokHome(userDataPath)
  await fs.mkdir(grokHome, { recursive: true, mode: 0o700 })
  await chmodBestEffort(grokHome, 0o700)
  await ensureSharedGrokMemory({
    grokHome,
    userMemoryDir: options.userMemoryDir ?? getUserGrokMemoryDir()
  })

  const controller = new GrokHomeConfigController(grokHome)
  const existing = await controller.read()
  await controller.apply({
    modelBlock: buildGrokProviderConfig(config, {
      userModelLines: extractUserOwnedModelLines(existing)
    }),
    ...(!hasTomlTable(existing, 'memory') ? { memoryEnabled: true } : {})
  })
  return grokHome
}

/**
 * 从已有 [model.agent-studio-default] 抽出用户改过的 Grok 字段。
 * 供应商绑定键和密钥键丢弃，context_window 等原生配置原样保留。
 */
function extractUserOwnedModelLines(existing: string): string[] {
  if (!existing.trim()) return []
  const block = splitTomlTables(existing).blocks.find(
    (item) => item.name === `model.${AGENT_STUDIO_MODEL_ALIAS}`
  )
  if (!block) return []
  return sanitizeUserModelLines(block.raw.replace(/\n$/, '').split('\n').slice(1))
}

function sanitizeUserModelLines(lines: readonly string[] | undefined): string[] {
  if (!lines?.length) return []
  const kept: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      kept.push(line)
      continue
    }
    const keyMatch = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)
    if (!keyMatch) {
      kept.push(line)
      continue
    }
    if (isUserOwnedModelKey(keyMatch[1])) kept.push(line)
  }
  while (kept.length > 0 && kept[0].trim() === '') kept.shift()
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
  return kept
}

function isUserOwnedModelKey(key: string): boolean {
  if (PROVIDER_MANAGED_MODEL_KEYS.has(key) || FORBIDDEN_MODEL_KEYS.has(key)) return false
  return !SECRET_MODEL_KEY_PATTERN.test(key)
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
