import { describe, expect, it } from 'vitest'
import { AGENT_STUDIO_MODEL_API_KEY_ENV, buildGrokProviderConfig } from './grok-provider-config'
import type { ProviderRuntimeConfig } from './provider-config-store'

const baseConfig: ProviderRuntimeConfig = {
  baseUrl: 'https://api.example.com/v1',
  authMode: 'bearer',
  apiKey: 'test-secret-key',
  modelId: 'model-1',
  modelDisplayName: 'Model One',
  updatedAt: '2026-08-07T00:00:00.000Z'
}

describe('buildGrokProviderConfig', () => {
  it('只写入模型元数据和环境变量名，不写入明文 Key', () => {
    const result = buildGrokProviderConfig(baseConfig)

    expect(result).toContain('model = "model-1"')
    expect(result).toContain('name = "Model One"')
    expect(result).toContain(`env_key = "${AGENT_STUDIO_MODEL_API_KEY_ENV}"`)
    expect(result).not.toContain('test-secret-key')
  })

  it('无认证服务不生成 env_key', () => {
    const result = buildGrokProviderConfig({
      ...baseConfig,
      authMode: 'none',
      apiKey: undefined
    })

    expect(result).not.toContain('env_key =')
  })

  it('过滤工具环境中的模型凭据并安全转义 TOML 字符串', () => {
    const result = buildGrokProviderConfig({
      ...baseConfig,
      modelId: 'model"quoted',
      modelDisplayName: undefined
    })

    expect(result).toContain('model = "model\\"quoted"')
    expect(result).toContain(`"${AGENT_STUDIO_MODEL_API_KEY_ENV}"`)
    expect(result).toContain('ignore_default_excludes = false')
  })
})
