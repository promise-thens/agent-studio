import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { SafeStorageAdapter } from '../provider/provider-config-store'
import { AtomicJsonWriter } from '../storage/atomic-json-file'
import { DesktopIpcFailure } from '../security/ipc-sender-validation'
import { normalizeProviderBaseUrl } from '../provider/provider-validation'
import { GrokHomeConfigController } from '../runtime/grok/grok-home-config-controller'
import type { GrokMcpServerTomlPatch } from '../runtime/grok/grok-config-merge'
import {
  isAbsoluteMcpCommand,
  isMcpServerName,
  isMcpTransportKind,
  isSafeMcpEnvName,
  normalizeMcpHeaderName,
  MAX_MCP_ARGS,
  MAX_MCP_ARG_BYTES,
  MAX_MCP_ENV_ENTRIES,
  MAX_MCP_HEADER_ENTRIES,
  MAX_MCP_SERVERS,
  type McpServerInput,
  type McpServerOrigin,
  type McpServerSummary,
  type McpTransportKind
} from '../../shared/mcp-server-config'

const SCHEMA_VERSION = 1
const MAX_FILE_BYTES = 256 * 1024

export interface McpServerRecord {
  name: string
  enabled: boolean
  transport: McpTransportKind
  origin: McpServerOrigin
  command?: string
  args?: string[]
  url?: string
  encryptedEnv?: Record<string, string>
  encryptedHeaders?: Record<string, string>
  lastError?: string
  updatedAt: string
}

export interface ResolvedMcpServer {
  name: string
  enabled: boolean
  transport: McpTransportKind
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
}

interface PersistedMcpServersV1 {
  schemaVersion: typeof SCHEMA_VERSION
  servers: McpServerRecord[]
}

export interface McpServerStoreOptions {
  userDataPath: string
  grokHome: string
  safeStorage: SafeStorageAdapter
  platform?: NodeJS.Platform
  now?: () => Date
  writer?: AtomicJsonWriter
  config?: GrokHomeConfigController
  commandExists?: (command: string) => Promise<boolean>
}

/**
 * 用户级 MCP：json 里存密文，App toml 只写非 Secret 字段。
 * 回写 ~/.grok/config.toml 的 [mcp_servers.*] 由 grok-user-mcp-sync 负责。
 */
export class McpServerStore {
  readonly filePath: string
  private readonly writer: AtomicJsonWriter
  private readonly now: () => Date
  private readonly platform: NodeJS.Platform
  private readonly commandExists: (command: string) => Promise<boolean>
  private records: McpServerRecord[] = []
  private sessionSecrets = new Map<
    string,
    { env?: Record<string, string>; headers?: Record<string, string> }
  >()

  constructor(
    private readonly options: McpServerStoreOptions,
    readonly config = options.config ?? new GrokHomeConfigController(options.grokHome)
  ) {
    this.filePath = join(options.userDataPath, 'config', 'mcp-servers.json')
    this.writer = options.writer ?? new AtomicJsonWriter()
    this.now = options.now ?? (() => new Date())
    this.platform = options.platform ?? process.platform
    this.commandExists =
      options.commandExists ??
      (async (command: string) => {
        try {
          const stat = await fs.stat(command)
          return stat.isFile()
        } catch {
          return false
        }
      })
  }

  async initialize(): Promise<void> {
    this.records = []
    this.sessionSecrets.clear()
    try {
      const parsed = (await this.writer.read(this.filePath, MAX_FILE_BYTES)) as unknown
      const servers = parsePersisted(parsed)
      this.records = servers
    } catch {
      this.records = []
    }
  }

  list(projectServers: readonly McpServerSummary[] = []): McpServerSummary[] {
    const user = this.records.map((record) => this.toSummary(record))
    return [...user, ...projectServers]
  }

  listKnownSecrets(): string[] {
    const secrets: string[] = []
    for (const session of this.sessionSecrets.values()) {
      if (session.env) secrets.push(...Object.values(session.env))
      if (session.headers) secrets.push(...Object.values(session.headers))
    }
    return secrets.filter(Boolean)
  }

  async listEnabledResolved(): Promise<ResolvedMcpServer[]> {
    const resolved: ResolvedMcpServer[] = []
    for (const record of this.records) {
      if (!record.enabled) continue
      try {
        resolved.push(this.resolveRecord(record))
      } catch {
        record.lastError = '凭据不可用'
        continue
      }
    }
    return resolved
  }

  async upsert(input: McpServerInput): Promise<McpServerSummary> {
    const validated = await this.validateInput(input)
    if (
      this.records.length >= MAX_MCP_SERVERS &&
      !this.records.some((item) => item.name === validated.name)
    ) {
      throw new DesktopIpcFailure('invalid-input', 'MCP 服务器数量已达上限。')
    }
    const existing = this.records.find((item) => item.name === validated.name)
    const originChanged = didOriginChange(existing, validated)
    const nextSecrets = this.mergeSecrets(existing, validated, originChanged)
    const persistSecrets = this.canPersistCredentialSecurely()
    const record: McpServerRecord = {
      name: validated.name,
      enabled: validated.enabled,
      transport: validated.transport,
      origin: 'user',
      updatedAt: this.now().toISOString(),
      ...(validated.command ? { command: validated.command } : {}),
      ...(validated.args ? { args: validated.args } : {}),
      ...(validated.url ? { url: validated.url } : {}),
      ...(persistSecrets && nextSecrets.env && Object.keys(nextSecrets.env).length > 0
        ? { encryptedEnv: this.encryptMap(nextSecrets.env) }
        : {}),
      ...(persistSecrets && nextSecrets.headers && Object.keys(nextSecrets.headers).length > 0
        ? { encryptedHeaders: this.encryptMap(nextSecrets.headers) }
        : {})
    }
    this.records = [...this.records.filter((item) => item.name !== record.name), record]
    this.sessionSecrets.set(record.name, nextSecrets)
    await this.persistToml()
    await this.persistJson()
    if (!persistSecrets && this.hasSecrets(nextSecrets)) {
      // Linux basic_text：本会话可用，不得把 Secret 写进 json。
      record.encryptedEnv = undefined
      record.encryptedHeaders = undefined
    }
    return this.toSummary(record)
  }

  async delete(name: string): Promise<void> {
    if (!isMcpServerName(name)) {
      throw new DesktopIpcFailure('invalid-input', 'MCP 名称无效。')
    }
    const existed = this.records.some((item) => item.name === name)
    if (!existed) throw new DesktopIpcFailure('not-found', '未找到该 MCP 服务器。')
    this.records = this.records.filter((item) => item.name !== name)
    this.sessionSecrets.delete(name)
    await this.persistToml()
    await this.persistJson()
  }

  /** 启动导入：App 已有同名时不覆盖 Secret，只补缺失项。 */
  async importFromUserToml(
    input: McpServerInput,
    options: { overwriteSecrets?: boolean } = {}
  ): Promise<void> {
    const existing = this.records.find((item) => item.name === input.name)
    if (existing && !options.overwriteSecrets) {
      const patched: McpServerInput = {
        name: existing.name,
        enabled: existing.enabled,
        transport: existing.transport,
        command: existing.command ?? input.command,
        args: existing.args ?? input.args,
        url: existing.url ?? input.url
      }
      if (!this.toSummary(existing).hasSecret) {
        patched.env = input.env
        patched.headers = input.headers
      }
      await this.upsert(patched)
      return
    }
    await this.upsert(input)
  }

  getRecord(name: string): McpServerRecord | undefined {
    return this.records.find((item) => item.name === name)
  }

  resolveRecord(record: McpServerRecord): ResolvedMcpServer {
    const session = this.sessionSecrets.get(record.name)
    let env = session?.env
    let headers = session?.headers
    try {
      env = env ?? (record.encryptedEnv ? this.decryptMap(record.encryptedEnv) : undefined)
      headers =
        headers ?? (record.encryptedHeaders ? this.decryptMap(record.encryptedHeaders) : undefined)
    } catch {
      record.lastError = '凭据不可用'
      throw new Error('凭据不可用')
    }
    if (env || headers) this.sessionSecrets.set(record.name, { env, headers })
    return {
      name: record.name,
      enabled: record.enabled,
      transport: record.transport,
      ...(record.command ? { command: record.command } : {}),
      ...(record.args ? { args: record.args } : {}),
      ...(record.url ? { url: record.url } : {}),
      ...(env ? { env } : {}),
      ...(headers ? { headers } : {})
    }
  }

  private async persistJson(): Promise<void> {
    const payload: PersistedMcpServersV1 = {
      schemaVersion: SCHEMA_VERSION,
      servers: this.records.map((record) => {
        const copy = { ...record }
        if (!this.canPersistCredentialSecurely()) {
          delete copy.encryptedEnv
          delete copy.encryptedHeaders
        }
        return copy
      })
    }
    await this.writer.write(this.filePath, payload)
  }

  private async persistToml(): Promise<void> {
    const mcpServers: GrokMcpServerTomlPatch[] = this.records.map((record) => ({
      name: record.name,
      enabled: record.enabled,
      transport: record.transport,
      ...(record.command ? { command: record.command } : {}),
      ...(record.args ? { args: record.args } : {}),
      ...(record.url ? { url: record.url } : {})
    }))
    const existingNames = splitExistingMcpNames(await this.config.read())
    const removeMcpServerNames = existingNames.filter(
      (name) => !mcpServers.some((server) => server.name === name)
    )
    await this.config.apply({
      mcpServers,
      ...(removeMcpServerNames.length > 0 ? { removeMcpServerNames } : {})
    })
  }

  private toSummary(record: McpServerRecord): McpServerSummary {
    const session = this.sessionSecrets.get(record.name)
    const hasSecret = Boolean(
      record.encryptedEnv ||
      record.encryptedHeaders ||
      (session?.env && Object.keys(session.env).length > 0) ||
      (session?.headers && Object.keys(session.headers).length > 0)
    )
    return {
      name: record.name,
      enabled: record.enabled,
      transport: record.transport,
      origin: record.origin,
      hasSecret,
      ...(record.command ? { command: record.command } : {}),
      ...(record.url ? { url: record.url } : {}),
      ...(record.lastError ? { lastError: record.lastError } : {})
    }
  }

  private async validateInput(input: McpServerInput): Promise<McpServerInput> {
    if (!isMcpServerName(input.name) || !isMcpTransportKind(input.transport)) {
      throw new DesktopIpcFailure('invalid-input', 'MCP 配置无效。')
    }
    if (typeof input.enabled !== 'boolean') {
      throw new DesktopIpcFailure('invalid-input', 'MCP 配置无效。')
    }
    const extraKeys = Object.keys(input).filter(
      (key) =>
        !['name', 'enabled', 'transport', 'command', 'args', 'url', 'env', 'headers'].includes(key)
    )
    if (extraKeys.length > 0) {
      throw new DesktopIpcFailure('invalid-input', 'MCP 配置无效。')
    }
    if (input.transport === 'stdio') {
      if (!input.command || !isAbsoluteMcpCommand(input.command)) {
        throw new DesktopIpcFailure('invalid-input', 'stdio MCP 的 command 必须是绝对路径。')
      }
      if (!(await this.commandExists(input.command))) {
        throw new DesktopIpcFailure('invalid-input', 'stdio MCP 的可执行文件不存在。')
      }
      const args = input.args ?? []
      if (!Array.isArray(args) || args.length > MAX_MCP_ARGS) {
        throw new DesktopIpcFailure('invalid-input', 'MCP 参数过多。')
      }
      for (const arg of args) {
        if (
          typeof arg !== 'string' ||
          arg.includes('\0') ||
          Buffer.byteLength(arg, 'utf8') > MAX_MCP_ARG_BYTES
        ) {
          throw new DesktopIpcFailure('invalid-input', 'MCP 参数无效。')
        }
      }
      return {
        name: input.name,
        enabled: input.enabled,
        transport: 'stdio',
        command: input.command,
        args,
        ...(input.env ? { env: validateEnv(input.env) } : {}),
        ...(input.headers ? { headers: validateHeaders(input.headers) } : {})
      }
    }

    let url: string
    try {
      url = normalizeProviderBaseUrl(input.url)
    } catch {
      throw new DesktopIpcFailure('invalid-input', 'MCP URL 无效。')
    }
    return {
      name: input.name,
      enabled: input.enabled,
      transport: 'http',
      url,
      ...(input.env ? { env: validateEnv(input.env) } : {}),
      ...(input.headers ? { headers: validateHeaders(input.headers) } : {})
    }
  }

  private mergeSecrets(
    existing: McpServerRecord | undefined,
    input: McpServerInput,
    originChanged: boolean
  ): { env?: Record<string, string>; headers?: Record<string, string> } {
    if (originChanged) {
      this.sessionSecrets.delete(input.name)
      return {
        ...(input.env && Object.keys(input.env).length > 0 ? { env: input.env } : {}),
        ...(input.headers && Object.keys(input.headers).length > 0
          ? { headers: input.headers }
          : {})
      }
    }
    const previous = existing
      ? this.tryResolveSecrets(existing)
      : this.sessionSecrets.get(input.name)
    const env = {
      ...(previous?.env ?? {}),
      ...(input.env ?? {})
    }
    const headers = {
      ...(previous?.headers ?? {}),
      ...(input.headers ?? {})
    }
    return {
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {})
    }
  }

  private tryResolveSecrets(record: McpServerRecord): {
    env?: Record<string, string>
    headers?: Record<string, string>
  } {
    const session = this.sessionSecrets.get(record.name)
    if (session) return session
    try {
      return {
        ...(record.encryptedEnv ? { env: this.decryptMap(record.encryptedEnv) } : {}),
        ...(record.encryptedHeaders ? { headers: this.decryptMap(record.encryptedHeaders) } : {})
      }
    } catch {
      return {}
    }
  }

  private encryptMap(values: Record<string, string>): Record<string, string> {
    const encrypted: Record<string, string> = {}
    for (const [key, value] of Object.entries(values)) {
      encrypted[key] = this.options.safeStorage.encryptString(value).toString('base64')
    }
    return encrypted
  }

  private decryptMap(values: Record<string, string>): Record<string, string> {
    const decrypted: Record<string, string> = {}
    for (const [key, value] of Object.entries(values)) {
      decrypted[key] = this.options.safeStorage.decryptString(Buffer.from(value, 'base64'))
    }
    return decrypted
  }

  private canPersistCredentialSecurely(): boolean {
    try {
      if (!this.options.safeStorage.isEncryptionAvailable()) return false
      if (this.platform !== 'linux') return true
      const backend = this.options.safeStorage.getSelectedStorageBackend?.() ?? 'unknown'
      return (
        backend === 'gnome_libsecret' ||
        backend === 'kwallet' ||
        backend === 'kwallet5' ||
        backend === 'kwallet6'
      )
    } catch {
      return false
    }
  }

  private hasSecrets(secrets: {
    env?: Record<string, string>
    headers?: Record<string, string>
  }): boolean {
    return Boolean(
      (secrets.env && Object.keys(secrets.env).length > 0) ||
      (secrets.headers && Object.keys(secrets.headers).length > 0)
    )
  }
}

function didOriginChange(existing: McpServerRecord | undefined, next: McpServerInput): boolean {
  if (!existing?.url || !next.url) return false
  try {
    return new URL(existing.url).origin !== new URL(next.url).origin
  } catch {
    return true
  }
}

function validateEnv(env: Record<string, string>): Record<string, string> {
  const entries = Object.entries(env)
  if (entries.length > MAX_MCP_ENV_ENTRIES) {
    throw new DesktopIpcFailure('invalid-input', 'MCP 环境变量过多。')
  }
  const next: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (!isSafeMcpEnvName(key) || typeof value !== 'string' || value.includes('\0')) {
      throw new DesktopIpcFailure('invalid-input', 'MCP 环境变量无效。')
    }
    if (Buffer.byteLength(value, 'utf8') > 8 * 1024) {
      throw new DesktopIpcFailure('payload-too-large', 'MCP 环境变量过大。')
    }
    if (value.length > 0) next[key] = value
  }
  return next
}

function validateHeaders(headers: Record<string, string>): Record<string, string> {
  const entries = Object.entries(headers)
  if (entries.length > MAX_MCP_HEADER_ENTRIES) {
    throw new DesktopIpcFailure('invalid-input', 'MCP Header 过多。')
  }
  const next: Record<string, string> = {}
  for (const [key, value] of entries) {
    const name = normalizeMcpHeaderName(key)
    if (!name || typeof value !== 'string' || value.includes('\0')) {
      throw new DesktopIpcFailure('invalid-input', 'MCP Header 无效。')
    }
    if (Buffer.byteLength(value, 'utf8') > 8 * 1024) {
      throw new DesktopIpcFailure('payload-too-large', 'MCP Header 过大。')
    }
    if (value.length > 0) next[name] = value
  }
  return next
}

function parsePersisted(value: unknown): McpServerRecord[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const record = value as { schemaVersion?: unknown; servers?: unknown }
  if (record.schemaVersion !== SCHEMA_VERSION || !Array.isArray(record.servers)) return []
  return record.servers.filter((item): item is McpServerRecord => {
    if (!item || typeof item !== 'object') return false
    const server = item as McpServerRecord
    return isMcpServerName(server.name) && isMcpTransportKind(server.transport)
  })
}

function splitExistingMcpNames(text: string): string[] {
  const names = new Set<string>()
  const pattern = /^\s*\[mcp_servers\.([A-Za-z0-9_-]+)]\s*(#.*)?$/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    names.add(match[1])
  }
  return [...names]
}
