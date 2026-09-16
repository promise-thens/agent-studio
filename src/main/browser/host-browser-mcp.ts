import type { AgentRuntimeMcpServer } from '../agent/agent-runtime-adapter'

export const HOST_BROWSER_MCP_SERVER_NAME = 'agent-studio-browser'

export interface HostBrowserMcpInjection {
  execPath: string
  scriptPath: string
  socketPath: string
  token: string
  pathEnv?: string
}

/**
 * 把宿主浏览器 MCP 接到 session 的 mcpServers 列表末尾。
 * 用户项撞名时丢掉用户项并报 conflict，禁止把用户 command/env 留在同名项里。
 */
export function appendHostBrowserMcpServer(
  userServers: readonly AgentRuntimeMcpServer[],
  injection: HostBrowserMcpInjection | null
): { servers: AgentRuntimeMcpServer[]; conflict: boolean } {
  if (!injection) return { servers: [...userServers], conflict: false }
  const conflict = userServers.some((server) => server.name === HOST_BROWSER_MCP_SERVER_NAME)
  const retained = userServers.filter((server) => server.name !== HOST_BROWSER_MCP_SERVER_NAME)
  return {
    conflict,
    servers: [...retained, createHostBrowserMcpServer(injection)]
  }
}

function createHostBrowserMcpServer(injection: HostBrowserMcpInjection): AgentRuntimeMcpServer {
  const env: { name: string; value: string }[] = [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'AGENT_STUDIO_BROWSER_SOCKET', value: injection.socketPath },
    { name: 'AGENT_STUDIO_BROWSER_TOKEN', value: injection.token }
  ]
  if (injection.pathEnv) env.push({ name: 'PATH', value: injection.pathEnv })
  return {
    name: HOST_BROWSER_MCP_SERVER_NAME,
    transport: 'stdio',
    command: injection.execPath,
    args: [injection.scriptPath],
    env
  }
}
