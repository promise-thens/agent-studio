import { describe, expect, it } from 'vitest'
import { GrokConfigMergeError, mergeGrokConfigToml } from './grok-config-merge'

const modelBlock = `[model.agent-studio-default]
model = "model-1"
base_url = "https://api.example.com/v1"
name = "Model One"
env_key = "AGENT_STUDIO_MODEL_API_KEY"
api_backend = "chat_completions"
context_window = 32768

[shell_environment_policy]
inherit = "core"
ignore_default_excludes = false
exclude = ["AGENT_STUDIO_MODEL_API_KEY"]
`

describe('mergeGrokConfigToml', () => {
  it('已有 [memory] enabled = true 时重写模型段，enabled 仍在', () => {
    const existing = `[memory]
enabled = true

${modelBlock}`
    const next = mergeGrokConfigToml(existing, {
      modelBlock: modelBlock.replace('model-1', 'model-2')
    })
    expect(next).toContain('[memory]')
    expect(next).toContain('enabled = true')
    expect(next).toContain('model = "model-2"')
  })

  it('空文件写入模型块 + memoryEnabled true，磁盘 toml 含 [memory]', () => {
    const next = mergeGrokConfigToml('', { modelBlock, memoryEnabled: true })
    expect(next).toContain('[memory]')
    expect(next).toContain('enabled = true')
    expect(next).toContain('[model.agent-studio-default]')
  })

  it('merge 进一个 stdio MCP 后 toml 有表且不含 sk-', () => {
    const next = mergeGrokConfigToml(modelBlock, {
      mcpServers: [
        {
          name: 'github',
          enabled: true,
          transport: 'stdio',
          command: '/usr/bin/false',
          args: ['--help']
        }
      ]
    })
    expect(next).toContain('[mcp_servers.github]')
    expect(next).toContain('command = "/usr/bin/false"')
    expect(next).not.toContain('sk-')
    expect(next).not.toContain('env =')
    expect(next).not.toContain('[mcp_servers.github.env]')
  })

  it('传入带 env 的 patch 抛错且调用方可保持原文件', () => {
    const existing = '[memory]\nenabled = true\n'
    expect(() =>
      mergeGrokConfigToml(existing, {
        mcpServers: [
          {
            name: 'github',
            enabled: true,
            transport: 'stdio',
            command: '/usr/bin/false',
            env: { API_KEY: 'sk-test-not-real' }
          } as never
        ]
      })
    ).toThrow(GrokConfigMergeError)
    expect(existing).toContain('enabled = true')
  })
})
