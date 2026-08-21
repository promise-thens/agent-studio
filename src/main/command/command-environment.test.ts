import { describe, expect, it } from 'vitest'
import { buildCommandEnvironment } from './command-environment'

const PLANTED_XAI_API_KEY = 'planted-xai-api-key-not-real'
const PLANTED_AUTHORIZATION = 'Bearer planted-authorization-not-real'
const PLANTED_OPENAI_KEY = 'planted-openai-api-key-not-real'
const PLANTED_ANTHROPIC_KEY = 'planted-anthropic-api-key-not-real'
const PLANTED_API_KEY = 'planted-generic-api-key-not-real'
const PLANTED_NPM_TOKEN = 'planted-npm-token-not-real'
const PLANTED_GIT_SSH = 'ssh -i /secret/id_rsa'
const PLANTED_GROK_KEY = 'planted-grok-code-xai-api-key-not-real'
const PLANTED_CODEX_KEY = 'planted-codex-api-key-not-real'

describe('buildCommandEnvironment', () => {
  it('从 allowlist 构造独立对象，不浅拷贝 process.env，也不改写入参', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/agent-studio-test',
      LANG: 'zh_CN.UTF-8',
      TMPDIR: '/tmp',
      XAI_API_KEY: PLANTED_XAI_API_KEY,
      AUTHORIZATION: PLANTED_AUTHORIZATION,
      OPENAI_API_KEY: PLANTED_OPENAI_KEY,
      ANTHROPIC_API_KEY: PLANTED_ANTHROPIC_KEY,
      API_KEY: PLANTED_API_KEY,
      NPM_TOKEN: PLANTED_NPM_TOKEN,
      GIT_SSH_COMMAND: PLANTED_GIT_SSH,
      GROK_CODE_XAI_API_KEY: PLANTED_GROK_KEY,
      CODEX_API_KEY: PLANTED_CODEX_KEY,
      AGENT_STUDIO_MODEL_API_KEY: 'planted-agent-studio-model-key'
    }
    const snapshot = { ...source }

    const environment = buildCommandEnvironment(source)

    expect(environment).not.toBe(source)
    expect(source).toEqual(snapshot)
    expect(environment.PATH).toBe('/usr/bin')
    expect(environment.HOME).toBe('/home/agent-studio-test')
    expect(environment.LANG).toBe('zh_CN.UTF-8')
    expect(environment.TMPDIR).toBe('/tmp')
    expect(environment).not.toHaveProperty('XAI_API_KEY')
    expect(environment).not.toHaveProperty('AUTHORIZATION')
    expect(environment).not.toHaveProperty('OPENAI_API_KEY')
    expect(environment).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(environment).not.toHaveProperty('API_KEY')
    expect(environment).not.toHaveProperty('NPM_TOKEN')
    expect(environment).not.toHaveProperty('GIT_SSH_COMMAND')
    expect(environment).not.toHaveProperty('GROK_CODE_XAI_API_KEY')
    expect(environment).not.toHaveProperty('CODEX_API_KEY')
    expect(environment).not.toHaveProperty('AGENT_STUDIO_MODEL_API_KEY')
    expect(JSON.stringify(environment)).not.toContain(PLANTED_XAI_API_KEY)
    expect(JSON.stringify(environment)).not.toContain(PLANTED_AUTHORIZATION)
    expect(JSON.stringify(environment)).not.toContain(PLANTED_GROK_KEY)
    expect(JSON.stringify(environment)).not.toContain(PLANTED_CODEX_KEY)
  })

  it('即使误把密钥名放进来源，子进程环境也不得出现模型凭据', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      XAI_API_KEY: PLANTED_XAI_API_KEY,
      AUTHORIZATION: PLANTED_AUTHORIZATION
    }

    const environment = buildCommandEnvironment(source)
    const names = Object.keys(environment)

    expect(names.some((name) => name.toUpperCase() === 'XAI_API_KEY')).toBe(false)
    expect(names.some((name) => name.toUpperCase() === 'AUTHORIZATION')).toBe(false)
    expect(Object.values(environment)).not.toContain(PLANTED_XAI_API_KEY)
    expect(Object.values(environment)).not.toContain(PLANTED_AUTHORIZATION)
  })
})
