export const MCP_TRANSPORT_KINDS = ['stdio', 'http'] as const
export type McpTransportKind = (typeof MCP_TRANSPORT_KINDS)[number]

export const MCP_SERVER_ORIGINS = ['user', 'project'] as const
export type McpServerOrigin = (typeof MCP_SERVER_ORIGINS)[number]

export const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/
export const MAX_MCP_SERVERS = 32
export const MAX_MCP_ARGS = 32
export const MAX_MCP_ARG_BYTES = 4 * 1024
export const MAX_MCP_ENV_ENTRIES = 32
export const MAX_MCP_HEADER_ENTRIES = 16

/** 允许写入 MCP HTTP 请求的 header 名；值一律当 Secret，不得进 list DTO 或 App toml。 */
export const MCP_HEADER_NAME_WHITELIST = [
  'Authorization',
  'Accept',
  'Content-Type',
  'User-Agent',
  'X-Api-Key',
  'Api-Key',
  'X-Mcp-Session-Id'
] as const

const MCP_HEADER_NAME_LOOKUP = new Map(
  MCP_HEADER_NAME_WHITELIST.map((name) => [name.toLowerCase(), name])
)

export interface McpServerInput {
  name: string
  enabled: boolean
  transport: McpTransportKind
  command?: string
  args?: string[]
  url?: string
  /** 仅写入时出现；读取 DTO 不得包含。 */
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface McpServerSummary {
  name: string
  enabled: boolean
  transport: McpTransportKind
  origin: McpServerOrigin
  command?: string
  url?: string
  hasSecret: boolean
  lastError?: string
}

export function isMcpTransportKind(value: unknown): value is McpTransportKind {
  return typeof value === 'string' && (MCP_TRANSPORT_KINDS as readonly string[]).includes(value)
}

export function isMcpServerOrigin(value: unknown): value is McpServerOrigin {
  return typeof value === 'string' && (MCP_SERVER_ORIGINS as readonly string[]).includes(value)
}

export function isMcpServerName(value: unknown): value is string {
  return typeof value === 'string' && MCP_SERVER_NAME_PATTERN.test(value)
}

export function isAbsoluteMcpCommand(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('://')) return false
  if (value.startsWith('/')) return !value.includes('\\')
  return /^[A-Za-z]:[\\/]/.test(value)
}

export function normalizeMcpHeaderName(name: string): string | null {
  const canonical = MCP_HEADER_NAME_LOOKUP.get(name.trim().toLowerCase())
  return canonical ?? null
}

export function isSafeMcpEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.length <= 64
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Preload 再 parse：丢掉 env/headers 明文和未知字段。 */
export function parseMcpServerSummary(value: unknown): McpServerSummary | null {
  if (!isPlainRecord(value)) return null
  if (!isMcpServerName(value.name) || !isMcpTransportKind(value.transport)) return null
  if (typeof value.enabled !== 'boolean' || !isMcpServerOrigin(value.origin)) return null
  if (typeof value.hasSecret !== 'boolean') return null
  if ('env' in value || 'headers' in value || 'apiKey' in value) return null

  const summary: McpServerSummary = {
    name: value.name,
    enabled: value.enabled,
    transport: value.transport,
    origin: value.origin,
    hasSecret: value.hasSecret
  }
  if (typeof value.command === 'string') {
    if (!isAbsoluteMcpCommand(value.command) || value.command.length > 1024) return null
    summary.command = value.command
  }
  if (typeof value.url === 'string') {
    if (value.url.length > 2048 || value.url.includes('\0')) return null
    summary.url = value.url
  }
  if (typeof value.lastError === 'string') {
    if (value.lastError.length > 256 || value.lastError.includes('\0')) return null
    summary.lastError = value.lastError
  }
  return summary
}
