import { describe, expect, it } from 'vitest'
import { isAbsoluteMcpCommand, isMcpServerName, parseMcpServerSummary } from './mcp-server-config'

describe('MCP 配置契约', () => {
  it('名称与绝对 command 规则', () => {
    expect(isMcpServerName('github')).toBe(true)
    expect(isMcpServerName('my-docs_1')).toBe(true)
    expect(isMcpServerName('')).toBe(false)
    expect(isMcpServerName('../escape')).toBe(false)
    expect(isAbsoluteMcpCommand('/usr/bin/false')).toBe(true)
    expect(isAbsoluteMcpCommand('C:\\Windows\\System32\\cmd.exe')).toBe(true)
    expect(isAbsoluteMcpCommand('npx')).toBe(false)
    expect(isAbsoluteMcpCommand('./server')).toBe(false)
  })

  it('list DTO 丢掉 env/headers 明文', () => {
    expect(
      parseMcpServerSummary({
        name: 'github',
        enabled: true,
        transport: 'stdio',
        origin: 'user',
        hasSecret: true,
        command: '/usr/bin/false',
        env: { API_KEY: 'sk-test-not-real' }
      })
    ).toBeNull()
    expect(
      parseMcpServerSummary({
        name: 'github',
        enabled: true,
        transport: 'stdio',
        origin: 'user',
        hasSecret: true,
        command: '/usr/bin/false'
      })
    ).toMatchObject({ name: 'github', hasSecret: true })
  })
})
