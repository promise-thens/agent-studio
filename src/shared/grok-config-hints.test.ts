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

  it('sandbox 提示区分 Grok 内核沙箱与 Electron sandbox，starter 不默认写该表', () => {
    const profileHint = matchGrokConfigHint('sandbox', 'profile')
    expect(profileHint?.title).toBe('sandbox.profile')
    expect(profileHint?.meaning).toContain('Grok')
    expect(profileHint?.meaning).toContain('Electron')
    expect(profileHint?.meaning).toContain('webPreferences.sandbox')
    expect(profileHint?.meaning).toContain('Permission Broker')
    expect(profileHint?.values).toContain('off')
    expect(profileHint?.values).toContain('workspace')
    expect(profileHint?.values).toContain('read-only')
    expect(profileHint?.values).toContain('strict')
    expect(profileHint?.studioNote).toContain('Broker')
    expect(profileHint?.studioNote).toContain('按 Grok 档位')
    expect(profileHint?.studioNote).toContain('~/.grok/memory')
    expect(profileHint?.studioNote).toContain('不承诺挡住记忆')
    expect(profileHint?.studioNote).not.toMatch(/会挡住|保证挡住|能够挡住/)
    expect(matchGrokConfigHint('sandbox')?.title).toBe('表 sandbox')
    expect(matchGrokConfigHint('sandbox')?.meaning).toContain('缺表即 off')
    expect(GROK_CONFIG_STARTER_TOML).not.toContain('[sandbox]')
    expect(GROK_CONFIG_STARTER_TOML).not.toContain('sandbox.profile')
  })
})
