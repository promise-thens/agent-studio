import { AGENT_STUDIO_MODEL_ALIAS } from './grok-acp-dialect'

const MODEL_TABLE = `model.${AGENT_STUDIO_MODEL_ALIAS}`
const SHELL_POLICY_TABLE = 'shell_environment_policy'
const TABLE_HEADER_PATTERN = /^\s*\[([^\]]+)]\s*(#.*)?$/
const SECRET_PATCH_KEYS = ['env', 'headers', 'api_key']

export class GrokConfigMergeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GrokConfigMergeError'
  }
}

export interface GrokMcpServerTomlPatch {
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
}

/** 结构化补丁。禁止传入原始 toml 字符串，也禁止夹带 env/headers Secret。 */
export interface GrokConfigPatch {
  modelBlock?: string
  memoryEnabled?: boolean
  mcpServers?: ReadonlyArray<GrokMcpServerTomlPatch>
  removeMcpServerNames?: readonly string[]
  pluginsEnabled?: string[]
  pluginsDisabled?: string[]
}

export interface TomlTableBlock {
  name: string
  raw: string
}

export interface TomlDocumentParts {
  preamble: string
  blocks: TomlTableBlock[]
}

export function splitTomlTables(text: string): TomlDocumentParts {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const preambleLines: string[] = []
  const blocks: TomlTableBlock[] = []
  let current: TomlTableBlock | null = null
  let seenTable = false

  const flush = (): void => {
    if (!current) return
    blocks.push(current)
    current = null
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const header = TABLE_HEADER_PATTERN.exec(line)
    const isLast = index === lines.length - 1
    const withNewline = isLast && !normalized.endsWith('\n') ? line : `${line}\n`

    if (header) {
      seenTable = true
      flush()
      current = { name: header[1].trim(), raw: withNewline }
      continue
    }
    if (!seenTable) {
      preambleLines.push(withNewline)
      continue
    }
    if (current) current.raw += withNewline
  }
  flush()
  return { preamble: preambleLines.join(''), blocks }
}

export function joinTomlTables(parts: TomlDocumentParts): string {
  const body = `${parts.preamble}${parts.blocks.map((block) => block.raw).join('')}`
  return body.endsWith('\n') || body.length === 0 ? body : `${body}\n`
}

function isSecretBearingPatch(patch: GrokConfigPatch): boolean {
  const record = patch as unknown as Record<string, unknown>
  if (SECRET_PATCH_KEYS.some((key) => key in record && record[key] !== undefined)) return true
  for (const server of patch.mcpServers ?? []) {
    const serverRecord = server as unknown as Record<string, unknown>
    if (SECRET_PATCH_KEYS.some((key) => key in serverRecord && serverRecord[key] !== undefined)) {
      return true
    }
  }
  return false
}

function upsertBareKey(tableRaw: string, key: string, valueLine: string): string {
  const lines = tableRaw.replace(/\n$/, '').split('\n')
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`)
  let replaced = false
  const next = lines.map((line, index) => {
    if (index === 0) return line
    if (!replaced && keyPattern.test(line) && !line.trimStart().startsWith('#')) {
      replaced = true
      const indent = /^\s*/.exec(line)?.[0] ?? ''
      return `${indent}${valueLine}`
    }
    return line
  })
  if (!replaced) next.push(valueLine)
  return `${next.join('\n')}\n`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`
}

function renderMcpServerTable(server: GrokMcpServerTomlPatch): string {
  const lines = [`[mcp_servers.${server.name}]`]
  if (server.transport === 'stdio') {
    if (!server.command) {
      throw new GrokConfigMergeError('stdio MCP 缺少 command。')
    }
    lines.push(`command = ${tomlString(server.command)}`)
    lines.push(`args = ${tomlStringArray(server.args ?? [])}`)
  } else {
    if (!server.url) {
      throw new GrokConfigMergeError('http MCP 缺少 url。')
    }
    lines.push(`url = ${tomlString(server.url)}`)
  }
  lines.push(`enabled = ${server.enabled ? 'true' : 'false'}`)
  lines.push('')
  return `${lines.join('\n')}`
}

function removeTables(blocks: TomlTableBlock[], predicate: (name: string) => boolean): void {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (predicate(blocks[index].name)) blocks.splice(index, 1)
  }
}

function isMcpServerTable(tableName: string, serverName: string): boolean {
  return (
    tableName === `mcp_servers.${serverName}` || tableName.startsWith(`mcp_servers.${serverName}.`)
  )
}

function findInsertIndex(blocks: TomlTableBlock[], predicate: (name: string) => boolean): number {
  const index = blocks.findIndex((block) => predicate(block.name))
  return index === -1 ? blocks.length : index
}

/**
 * 按表合并 App grok-home/config.toml。
 * 只替换补丁点名的表，其它表（含 Grok 自写段和注释）尽量原样保留。
 */
export function mergeGrokConfigToml(existing: string, patch: GrokConfigPatch): string {
  if (isSecretBearingPatch(patch)) {
    throw new GrokConfigMergeError('配置补丁不能包含 env、headers 或 api_key。')
  }

  const parts = splitTomlTables(existing)

  if (patch.modelBlock !== undefined) {
    const insertAt = findInsertIndex(
      parts.blocks,
      (name) => name === MODEL_TABLE || name === SHELL_POLICY_TABLE
    )
    removeTables(parts.blocks, (name) => name === MODEL_TABLE || name === SHELL_POLICY_TABLE)
    const modelBlock = patch.modelBlock.endsWith('\n') ? patch.modelBlock : `${patch.modelBlock}\n`
    parts.blocks.splice(insertAt, 0, { name: MODEL_TABLE, raw: modelBlock })
  }

  if (patch.memoryEnabled !== undefined) {
    const memoryIndex = parts.blocks.findIndex((block) => block.name === 'memory')
    const enabledLine = `enabled = ${patch.memoryEnabled ? 'true' : 'false'}`
    if (memoryIndex === -1) {
      parts.blocks.push({ name: 'memory', raw: `[memory]\n${enabledLine}\n` })
    } else {
      parts.blocks[memoryIndex] = {
        name: 'memory',
        raw: upsertBareKey(parts.blocks[memoryIndex].raw, 'enabled', enabledLine)
      }
    }
  }

  const mcpNamesToRewrite = new Set<string>()
  for (const server of patch.mcpServers ?? []) mcpNamesToRewrite.add(server.name)
  for (const name of patch.removeMcpServerNames ?? []) mcpNamesToRewrite.add(name)

  if (mcpNamesToRewrite.size > 0) {
    removeTables(parts.blocks, (name) =>
      [...mcpNamesToRewrite].some((serverName) => isMcpServerTable(name, serverName))
    )
    for (const server of patch.mcpServers ?? []) {
      parts.blocks.push({
        name: `mcp_servers.${server.name}`,
        raw: renderMcpServerTable(server)
      })
    }
  }

  if (patch.pluginsEnabled !== undefined || patch.pluginsDisabled !== undefined) {
    const pluginsIndex = parts.blocks.findIndex((block) => block.name === 'plugins')
    let raw = pluginsIndex === -1 ? '[plugins]\n' : parts.blocks[pluginsIndex].raw
    if (patch.pluginsEnabled !== undefined) {
      raw = upsertBareKey(raw, 'enabled', `enabled = ${tomlStringArray(patch.pluginsEnabled)}`)
    }
    if (patch.pluginsDisabled !== undefined) {
      raw = upsertBareKey(raw, 'disabled', `disabled = ${tomlStringArray(patch.pluginsDisabled)}`)
    }
    const next = { name: 'plugins', raw }
    if (pluginsIndex === -1) parts.blocks.push(next)
    else parts.blocks[pluginsIndex] = next
  }

  return joinTomlTables(parts)
}

export function hasTomlTable(text: string, tableName: string): boolean {
  return splitTomlTables(text).blocks.some((block) => block.name === tableName)
}
