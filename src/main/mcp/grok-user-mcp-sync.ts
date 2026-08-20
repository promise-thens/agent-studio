import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import {
  isAbsoluteMcpCommand,
  isMcpServerName,
  type McpServerInput,
  type McpServerSummary,
  type McpTransportKind
} from '../../shared/mcp-server-config'
import { DesktopIpcFailure } from '../security/ipc-sender-validation'
import { isPathInside } from '../runtime/grok/grok-shared-memory'
import { joinTomlTables, splitTomlTables } from '../runtime/grok/grok-config-merge'
import type { McpServerStore } from './mcp-server-store'

export function getUserGrokConfigPath(resolveHome: () => string = homedir): string {
  return join(resolveHome(), '.grok', 'config.toml')
}

export interface ParsedUserMcpServer {
  name: string
  enabled: boolean
  transport: McpTransportKind
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
}

/**
 * 只解析 [mcp_servers.*]。解析失败由调用方决定：sync 必须失败且不动 store。
 */
export function parseUserMcpServerTables(tomlText: string): ParsedUserMcpServer[] {
  const parsed = parseToml(tomlText) as Record<string, unknown>
  const table = asRecord(parsed.mcp_servers)
  if (!table) return []
  const servers: ParsedUserMcpServer[] = []
  for (const [name, raw] of Object.entries(table)) {
    if (!isMcpServerName(name)) continue
    const record = asRecord(raw)
    if (!record) continue
    const server = toParsedServer(name, record)
    if (server) servers.push(server)
  }
  return servers
}

export function mergeUserMcpServerTable(existingToml: string, server: ParsedUserMcpServer): string {
  const parts = splitTomlTables(existingToml)
  const prefix = `mcp_servers.${server.name}`
  const remaining = parts.blocks.filter(
    (block) => block.name !== prefix && !block.name.startsWith(`${prefix}.`)
  )
  const rendered = renderUserMcpTables(server)
  return joinTomlTables({
    preamble: parts.preamble,
    blocks: [...remaining, ...rendered]
  })
}

export function removeUserMcpServerTable(existingToml: string, name: string): string {
  const parts = splitTomlTables(existingToml)
  const prefix = `mcp_servers.${name}`
  return joinTomlTables({
    preamble: parts.preamble,
    blocks: parts.blocks.filter(
      (block) => block.name !== prefix && !block.name.startsWith(`${prefix}.`)
    )
  })
}

export async function syncUserMcpFromHome(input: {
  userConfigPath: string
  store: McpServerStore
}): Promise<void> {
  let text: string
  try {
    text = await fs.readFile(input.userConfigPath, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
  let servers: ParsedUserMcpServer[]
  try {
    servers = parseUserMcpServerTables(text)
  } catch {
    throw new DesktopIpcFailure('operation-failed', '无法读取用户 Grok MCP 配置。')
  }
  for (const server of servers) {
    await input.store.importFromUserToml(toInput(server), { overwriteSecrets: false })
  }
}

export async function writeUserMcpServer(input: {
  userConfigPath: string
  server: ParsedUserMcpServer
}): Promise<void> {
  let existing = ''
  try {
    existing = await fs.readFile(input.userConfigPath, 'utf8')
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  if (existing.trim()) {
    try {
      parseToml(existing)
    } catch {
      throw new DesktopIpcFailure('operation-failed', '用户 Grok 配置已损坏，未写入 MCP。')
    }
  }
  const next = existing.trim()
    ? mergeUserMcpServerTable(existing, input.server)
    : joinTomlTables({ preamble: '', blocks: renderUserMcpTables(input.server) })
  await writeUserTomlAtomic(input.userConfigPath, next)
}

export async function removeUserMcpServer(input: {
  userConfigPath: string
  name: string
}): Promise<void> {
  let existing: string
  try {
    existing = await fs.readFile(input.userConfigPath, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
  try {
    parseToml(existing)
  } catch {
    throw new DesktopIpcFailure('operation-failed', '用户 Grok 配置已损坏，未删除 MCP。')
  }
  await writeUserTomlAtomic(input.userConfigPath, removeUserMcpServerTable(existing, input.name))
}

/**
 * 只读扫描仓库 `.grok/config.toml`。realpath 必须落在项目根内，失败则不当作用户级。
 */
export async function listProjectMcpServers(workspace: string): Promise<McpServerSummary[]> {
  if (!workspace || !isAbsolute(workspace)) return []
  const configPath = join(resolve(workspace), '.grok', 'config.toml')
  let canonical: string
  try {
    canonical = await fs.realpath(configPath)
  } catch {
    return []
  }
  if (!isPathInside(resolve(workspace), canonical)) return []
  if (relative(resolve(workspace), canonical).startsWith('..')) return []
  let text: string
  try {
    text = await fs.readFile(canonical, 'utf8')
  } catch {
    return []
  }
  try {
    return parseUserMcpServerTables(text).map((server) => ({
      name: server.name,
      enabled: server.enabled,
      transport: server.transport,
      origin: 'project' as const,
      hasSecret: Boolean(
        (server.env && Object.keys(server.env).length > 0) ||
        (server.headers && Object.keys(server.headers).length > 0)
      ),
      ...(server.command ? { command: server.command } : {}),
      ...(server.url ? { url: server.url } : {})
    }))
  } catch {
    return []
  }
}

function toParsedServer(name: string, record: Record<string, unknown>): ParsedUserMcpServer | null {
  const command = typeof record.command === 'string' ? record.command : undefined
  const url = typeof record.url === 'string' ? record.url : undefined
  const enabled = record.enabled === false ? false : true
  const args = Array.isArray(record.args)
    ? record.args.filter((item): item is string => typeof item === 'string')
    : undefined
  const env = readStringMap(record.env)
  const headers = readStringMap(record.headers)
  if (command && isAbsoluteMcpCommand(command)) {
    return {
      name,
      enabled,
      transport: 'stdio',
      command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      ...(headers ? { headers } : {})
    }
  }
  if (url) {
    return {
      name,
      enabled,
      transport: 'http',
      url,
      ...(env ? { env } : {}),
      ...(headers ? { headers } : {})
    }
  }
  // TUI 里 command 可以是 npx 相对命令；导入时仍记录为 stdio，store 会因非绝对路径拒绝。
  if (typeof command === 'string' && command.trim()) {
    return null
  }
  return null
}

function toInput(server: ParsedUserMcpServer): McpServerInput {
  return {
    name: server.name,
    enabled: server.enabled,
    transport: server.transport,
    ...(server.command ? { command: server.command } : {}),
    ...(server.args ? { args: server.args } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.env ? { env: server.env } : {}),
    ...(server.headers ? { headers: server.headers } : {})
  }
}

function renderUserMcpTables(server: ParsedUserMcpServer): Array<{ name: string; raw: string }> {
  const lines = [`[mcp_servers.${server.name}]`]
  if (server.transport === 'stdio' && server.command) {
    lines.push(`command = ${JSON.stringify(server.command)}`)
    lines.push(`args = [${(server.args ?? []).map((item) => JSON.stringify(item)).join(', ')}]`)
  } else if (server.url) {
    lines.push(`url = ${JSON.stringify(server.url)}`)
  }
  lines.push(`enabled = ${server.enabled ? 'true' : 'false'}`)
  lines.push('')
  const blocks = [{ name: `mcp_servers.${server.name}`, raw: `${lines.join('\n')}` }]
  if (server.env && Object.keys(server.env).length > 0) {
    const envLines = [`[mcp_servers.${server.name}.env]`]
    for (const [key, value] of Object.entries(server.env)) {
      envLines.push(`${key} = ${JSON.stringify(value)}`)
    }
    envLines.push('')
    blocks.push({ name: `mcp_servers.${server.name}.env`, raw: `${envLines.join('\n')}` })
  }
  if (server.headers && Object.keys(server.headers).length > 0) {
    const headerLines = [`[mcp_servers.${server.name}.headers]`]
    for (const [key, value] of Object.entries(server.headers)) {
      headerLines.push(`${JSON.stringify(key)} = ${JSON.stringify(value)}`)
    }
    headerLines.push('')
    blocks.push({ name: `mcp_servers.${server.name}.headers`, raw: `${headerLines.join('\n')}` })
  }
  return blocks
}

async function writeUserTomlAtomic(path: string, text: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    await fs.writeFile(temporaryPath, text.endsWith('\n') ? text : `${text}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    await fs.rename(temporaryPath, path)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function readStringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const next: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string' && item.length > 0) next[key] = item
  }
  return Object.keys(next).length > 0 ? next : undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
