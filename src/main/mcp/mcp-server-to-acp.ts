import type * as acp from '@agentclientprotocol/sdk'
import type { AgentRuntimeMcpServer } from '../agent/agent-runtime-adapter'
import type { ResolvedMcpServer } from './mcp-server-store'

export function toAgentRuntimeMcpServers(
  servers: readonly ResolvedMcpServer[]
): AgentRuntimeMcpServer[] {
  return servers.filter((server) => server.enabled).map(toAgentRuntimeMcpServer)
}

export function toAcpMcpServers(servers: readonly AgentRuntimeMcpServer[]): acp.McpServer[] {
  return servers.map(toAcpMcpServer)
}

function toAgentRuntimeMcpServer(server: ResolvedMcpServer): AgentRuntimeMcpServer {
  if (server.transport === 'http') {
    return {
      name: server.name,
      transport: 'http',
      url: server.url,
      headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value }))
    }
  }
  return {
    name: server.name,
    transport: 'stdio',
    command: server.command,
    args: server.args ?? [],
    env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value }))
  }
}

function toAcpMcpServer(server: AgentRuntimeMcpServer): acp.McpServer {
  if (server.transport === 'http') {
    return {
      type: 'http',
      name: server.name,
      url: server.url ?? '',
      headers: server.headers ?? []
    }
  }
  return {
    name: server.name,
    command: server.command ?? '',
    args: server.args ?? [],
    env: server.env ?? []
  }
}
