import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import {
  AGENT_STUDIO_MODEL_ALIAS,
  GROK_ACP_CLIENT_CAPABILITIES,
  GROK_ACP_CLIENT_INFO_NAME,
  GROK_ACP_CLIENT_INFO_VERSION,
  GROK_CONTROLLED_E2E_SPAWN_ARG_FLAGS,
  GROK_INITIALIZE_RESPONSE_ALLOWED_FIELDS,
  GROK_PRODUCTION_AGENT_ARGV,
  GROK_SET_MODEL_METHOD,
  assertGrokHandshakeCompat,
  buildGrokControlledE2ESpawnArgs,
  isGrokSetModelResponseValid,
  type GrokHandshakeProjectedFields
} from './grok-acp-dialect'

describe('Grok ACP 方言常量冻结', () => {
  it('生产 argv 与字面量完全一致，且嵌入模型别名', () => {
    // 备注：改 argv 必须先改本断言，禁止静默漂移。
    expect(GROK_PRODUCTION_AGENT_ARGV).toEqual([
      '--no-auto-update',
      'agent',
      '--no-leader',
      '-m',
      'agent-studio-default',
      'stdio'
    ])
    expect(AGENT_STUDIO_MODEL_ALIAS).toBe('agent-studio-default')
    expect(GROK_PRODUCTION_AGENT_ARGV).toContain(AGENT_STUDIO_MODEL_ALIAS)
  })

  it('set_model 方法名与 clientInfo 冻结值保持 GACP-01 基线', () => {
    expect(GROK_SET_MODEL_METHOD).toBe('session/set_model')
    expect(GROK_ACP_CLIENT_INFO_NAME).toBe('agent-studio')
    // 备注：本任务不改版本；任务 2 才对齐真实 app 版本。
    expect(GROK_ACP_CLIENT_INFO_VERSION).toBe('0.1.0')
    expect(GROK_ACP_CLIENT_CAPABILITIES).toEqual({})
  })

  it('initialize 允许读取字段列表锁定，其它字段不得进入产品逻辑', () => {
    expect([...GROK_INITIALIZE_RESPONSE_ALLOWED_FIELDS]).toEqual([
      'protocolVersion',
      'agentInfo.version',
      'loadSession',
      'sessionCapabilities.resume',
      'sessionCapabilities.close'
    ])
  })

  it('受控 E2E argv 与生产 argv 分离，且使用固定 flag', () => {
    expect(GROK_CONTROLLED_E2E_SPAWN_ARG_FLAGS).toEqual({
      scenario: '--scenario',
      userData: '--user-data'
    })
    const e2eArgs = buildGrokControlledE2ESpawnArgs({
      fixturePath: '/tmp/fixture.mjs',
      scenario: 'E2E:FIFO',
      userDataPath: '/tmp/user-data'
    })
    expect(e2eArgs).toEqual([
      '/tmp/fixture.mjs',
      '--scenario',
      'E2E:FIFO',
      '--user-data',
      '/tmp/user-data'
    ])
    expect(e2eArgs).not.toEqual([...GROK_PRODUCTION_AGENT_ARGV])
    expect(GROK_PRODUCTION_AGENT_ARGV).not.toContain('--scenario')
  })
})

describe('Grok ACP 握手兼容性检查', () => {
  const gacp01Projected: GrokHandshakeProjectedFields = {
    protocolVersion: 1,
    loadSession: true,
    resume: true,
    close: true
  }

  it('GACP-01 真实握手投影可通过，并记录 session/new 基线不探测', () => {
    const result = assertGrokHandshakeCompat(gacp01Projected, acp.PROTOCOL_VERSION)
    expect(result.ok).toBe(true)
    expect(result.notes.some((note) => note.includes('session/new'))).toBe(true)
  })

  it('协议版本不等立即拒绝，文案与现有 Mapper 一致', () => {
    expect(() =>
      assertGrokHandshakeCompat(
        { ...gacp01Projected, protocolVersion: acp.PROTOCOL_VERSION + 1 },
        acp.PROTOCOL_VERSION
      )
    ).toThrow(
      `ACP 协议版本不兼容：Runtime 返回 ${acp.PROTOCOL_VERSION + 1}，客户端支持 ${acp.PROTOCOL_VERSION}。`
    )
  })

  it('缺少 load/resume/close 广告不拒绝，只依赖版本检查', () => {
    const result = assertGrokHandshakeCompat(
      { protocolVersion: acp.PROTOCOL_VERSION },
      acp.PROTOCOL_VERSION
    )
    expect(result.ok).toBe(true)
    expect(result.notes.length).toBeGreaterThan(0)
  })
})

describe('Grok ACP set_model 响应守卫', () => {
  it('非 null 普通对象通过，且不把 _meta 当业务字段读', () => {
    expect(isGrokSetModelResponseValid({})).toBe(true)
    expect(isGrokSetModelResponseValid({ modelId: AGENT_STUDIO_MODEL_ALIAS })).toBe(true)
    // 备注：只认 object 形状；即使仅有 _meta 也不解析其内容。
    expect(isGrokSetModelResponseValid({ _meta: { vendor: 'x' } })).toBe(true)
  })

  it('null / 数组 / 字符串 / undefined 全部失败关闭', () => {
    expect(isGrokSetModelResponseValid(null)).toBe(false)
    expect(isGrokSetModelResponseValid(undefined)).toBe(false)
    expect(isGrokSetModelResponseValid([])).toBe(false)
    expect(isGrokSetModelResponseValid(['x'])).toBe(false)
    expect(isGrokSetModelResponseValid('ok')).toBe(false)
    expect(isGrokSetModelResponseValid(1)).toBe(false)
    expect(isGrokSetModelResponseValid(true)).toBe(false)
  })
})
