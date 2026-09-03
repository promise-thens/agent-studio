import { describe, expect, it } from 'vitest'
import { GROK_CONFIG_STARTER_TOML, matchGrokConfigHint } from './grok-config-hints'

describe('Grok 配置提示目录', () => {
  it('精确表+键命中，否则退到表级', () => {
    expect(matchGrokConfigHint('memory', 'enabled')?.title).toBe('memory.enabled')
    expect(matchGrokConfigHint('memory', 'unknown')?.title).toBe('表 memory')
    expect(matchGrokConfigHint('mcp_servers.github')?.table).toBe('mcp_servers')
    expect(matchGrokConfigHint('model.agent-studio-default')?.studioNote).toContain('供应商页')
    expect(
      matchGrokConfigHint('model.agent-studio-default', 'context_window')?.studioNote
    ).toContain('不会被供应商绑定覆盖')
    expect(matchGrokConfigHint('nope')).toBeNull()
  })

  it('starter 模板含记忆开关且不含密钥', () => {
    expect(GROK_CONFIG_STARTER_TOML).toContain('[memory]')
    expect(GROK_CONFIG_STARTER_TOML).toContain('enabled = true')
    expect(GROK_CONFIG_STARTER_TOML).not.toContain('sk-')
    expect(GROK_CONFIG_STARTER_TOML).not.toContain('api_key')
  })
})
