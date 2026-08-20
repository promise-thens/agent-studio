import { describe, expect, it } from 'vitest'
import { toAcpMcpServers, toAgentRuntimeMcpServers } from './mcp-server-to-acp'

describe('MCP → ACP 映射', () => {
  it('stdio 映射为 command/args/env 数组，http 带 type 和 headers', () => {
    const runtime = toAgentRuntimeMcpServers([
      {
        name: 'github',
        enabled: true,
        transport: 'stdio',
        command: '/usr/bin/false',
        args: ['--help'],
        env: { TOKEN: 'sk-test-not-real' }
      },
      {
        name: 'docs',
        enabled: true,
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer sk-test-not-real' }
      },
      {
        name: 'off',
        enabled: false,
        transport: 'stdio',
        command: '/usr/bin/false'
      }
    ])
    expect(runtime.map((item) => item.name)).toEqual(['github', 'docs'])
    expect(toAcpMcpServers(runtime)).toEqual([
      {
        name: 'github',
        command: '/usr/bin/false',
        args: ['--help'],
        env: [{ name: 'TOKEN', value: 'sk-test-not-real' }]
      },
      {
        type: 'http',
        name: 'docs',
        url: 'https://example.com/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer sk-test-not-real' }]
      }
    ])
  })
})
