import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { GROK_CONFIG_MAX_BYTES } from '../../../shared/grok-config-hints'
import {
  GrokConfigMergeError,
  hasTomlTable,
  mergeGrokConfigToml,
  type GrokConfigPatch
} from './grok-config-merge'

/** 与 grok-provider-config 的 AGENT_STUDIO_MODEL_ALIAS 对齐，避免循环导入。 */
const AGENT_STUDIO_MODEL_ALIAS = 'agent-studio-default'
const SECRET_KEY_PATTERN = /(?:^|_)(api[_-]?key|token|secret|password|authorization)$/i
const SECRET_VALUE_PATTERN = /^(sk-|ghp_|github_pat_|xai-|Bearer\s+)/i

export class GrokConfigTextError extends Error {
  readonly line?: number

  constructor(message: string, line?: number) {
    super(message)
    this.name = 'GrokConfigTextError'
    this.line = line
  }
}

export interface GrokHomeConfigApplyResult {
  replacedCorruptFile?: true
}

export interface GrokPluginEnablement {
  enabled?: string[]
  disabled?: string[]
}

/**
 * 读写 App grok-home/config.toml。
 * 表单走 apply(patch)；编辑器走 writeText。两条路写同一份文件，都不整文件覆盖用户 ~/.grok。
 */
export class GrokHomeConfigController {
  readonly configPath: string

  constructor(private readonly grokHome: string) {
    this.configPath = join(grokHome, 'config.toml')
  }

  async read(): Promise<string> {
    try {
      return await fs.readFile(this.configPath, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return ''
      throw error
    }
  }

  async apply(patch: GrokConfigPatch): Promise<GrokHomeConfigApplyResult> {
    const existing = await this.read()
    const parseError = describeTomlParseError(existing)
    const needsPreserve =
      patch.memoryEnabled !== undefined ||
      patch.mcpServers !== undefined ||
      patch.removeMcpServerNames !== undefined ||
      patch.pluginsEnabled !== undefined ||
      patch.pluginsDisabled !== undefined

    if (parseError && existing.trim() && needsPreserve) {
      throw new GrokConfigMergeError('Grok 配置已损坏，拒绝合并记忆、MCP 或插件补丁。')
    }

    let next: string
    let replacedCorruptFile: true | undefined
    if (parseError && existing.trim() && patch.modelBlock) {
      next = mergeGrokConfigToml('', patch)
      replacedCorruptFile = true
    } else {
      next = mergeGrokConfigToml(existing, patch)
    }
    await this.writeAtomic(next)
    return replacedCorruptFile ? { replacedCorruptFile } : {}
  }

  /**
   * 编辑器保存：必须能解析为 TOML，超限、NUL 或明文 Secret 则拒绝，保留用户注释（原文直写）。
   */
  async writeText(text: string): Promise<void> {
    validateGrokConfigText(text)
    await this.writeAtomic(text)
  }

  async readMemoryEnabled(): Promise<boolean> {
    const text = await this.read()
    if (!text.trim()) return true
    const parsed = tryParseToml(text)
    if (!parsed) return true
    const memory = asRecord(parsed.memory)
    return memory?.enabled !== false
  }

  async readPluginEnablement(): Promise<GrokPluginEnablement> {
    const parsed = tryParseToml(await this.read())
    if (!parsed) return {}
    const plugins = asRecord(parsed.plugins)
    if (!plugins) return {}
    return {
      ...(Array.isArray(plugins.enabled)
        ? { enabled: plugins.enabled.filter((item): item is string => typeof item === 'string') }
        : {}),
      ...(Array.isArray(plugins.disabled)
        ? { disabled: plugins.disabled.filter((item): item is string => typeof item === 'string') }
        : {})
    }
  }

  private async writeAtomic(text: string): Promise<void> {
    await fs.mkdir(this.grokHome, { recursive: true, mode: 0o700 })
    await chmodBestEffort(this.grokHome, 0o700)
    const temporaryPath = join(
      this.grokHome,
      `config.toml.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    )
    try {
      await fs.writeFile(temporaryPath, text.endsWith('\n') ? text : `${text}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
      await fs.rename(temporaryPath, this.configPath)
      await chmodBestEffort(this.configPath, 0o600)
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

export function validateGrokConfigText(text: string): void {
  if (text.includes('\0')) {
    throw new GrokConfigTextError('配置不能包含 NUL。')
  }
  if (Buffer.byteLength(text, 'utf8') > GROK_CONFIG_MAX_BYTES) {
    throw new GrokConfigTextError('配置超过 128 KiB 上限。')
  }
  let parsed: Record<string, unknown>
  try {
    parsed = parseToml(text) as Record<string, unknown>
  } catch (error) {
    throw toTomlTextError(error)
  }
  assertNoPlaintextSecrets(parsed)
  if (!hasModelBinding(parsed)) {
    throw new GrokConfigTextError('不能删除 [model.agent-studio-default]，模型绑定由供应商页管理。')
  }
  const model = asRecord(asRecord(parsed.model)?.[AGENT_STUDIO_MODEL_ALIAS])
  const envKey = model?.env_key
  if (typeof envKey === 'string' && SECRET_VALUE_PATTERN.test(envKey)) {
    throw new GrokConfigTextError('env_key 不能改成明文 Key。')
  }
}

export { hasTomlTable }

function hasModelBinding(parsed: Record<string, unknown>): boolean {
  const model = asRecord(parsed.model)
  return Boolean(asRecord(model?.[AGENT_STUDIO_MODEL_ALIAS]))
}

function assertNoPlaintextSecrets(value: unknown, path: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPlaintextSecrets(item, [...path, String(index)]))
    return
  }
  const record = asRecord(value)
  if (!record) {
    if (typeof value === 'string' && SECRET_VALUE_PATTERN.test(value)) {
      throw new GrokConfigTextError('配置不能包含明文密钥。')
    }
    return
  }
  for (const [key, child] of Object.entries(record)) {
    if (SECRET_KEY_PATTERN.test(key) && typeof child === 'string' && child.trim()) {
      throw new GrokConfigTextError(`不能把 ${key} 写成明文。`)
    }
    if (typeof child === 'string' && SECRET_VALUE_PATTERN.test(child)) {
      throw new GrokConfigTextError('配置不能包含明文密钥。')
    }
    assertNoPlaintextSecrets(child, [...path, key])
  }
}

function describeTomlParseError(text: string): string | null {
  if (!text.trim()) return null
  try {
    parseToml(text)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : '无法解析 TOML。'
  }
}

function tryParseToml(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null
  try {
    return parseToml(text) as Record<string, unknown>
  } catch {
    return null
  }
}

function toTomlTextError(error: unknown): GrokConfigTextError {
  if (error && typeof error === 'object' && 'line' in error) {
    const line = Number((error as { line?: unknown }).line)
    const message = error instanceof Error ? error.message : '无法解析 TOML。'
    return new GrokConfigTextError(
      `无法解析 TOML：${message}`,
      Number.isFinite(line) ? line : undefined
    )
  }
  const message = error instanceof Error ? error.message : '无法解析 TOML。'
  const lineMatch = /at line (\d+)/i.exec(message)
  return new GrokConfigTextError(
    `无法解析：${message}`,
    lineMatch ? Number(lineMatch[1]) : undefined
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

async function chmodBestEffort(path: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return
  await fs.chmod(path, mode).catch(() => undefined)
}
