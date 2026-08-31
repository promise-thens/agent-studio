import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import {
  AGENT_STUDIO_MODEL_ALIAS,
  GROK_ACP_CLIENT_CAPABILITIES,
  GROK_ACP_CLIENT_INFO_NAME,
  GROK_ACP_PRODUCT_MESSAGES,
  GROK_CONTROLLED_E2E_SPAWN_ARG_FLAGS,
  GROK_INITIALIZE_PRODUCT_READ_FIELDS,
  GROK_INITIALIZE_RESPONSE_ALLOWED_FIELDS,
  GROK_PRODUCTION_AGENT_ARGV,
  GROK_SET_MODEL_METHOD,
  assertGrokHandshakeCompat,
  buildGrokAcpClientInfo,
  buildGrokControlledE2ESpawnArgs,
  classifyGrokConnectError,
  classifyGrokSpawnProcessError,
  isGrokSetModelResponseValid,
  projectGrokHandshakeFields,
  resolveGrokAcpFailure,
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

  it('set_model 方法名与 clientInfo 名称保持 GACP-01 基线，能力仍为空', () => {
    expect(GROK_SET_MODEL_METHOD).toBe('session/set_model')
    expect(GROK_ACP_CLIENT_INFO_NAME).toBe('agent-studio')
    expect(GROK_ACP_CLIENT_CAPABILITIES).toEqual({})
  })

  it('buildGrokAcpClientInfo 接受注入版本并拒绝空/空白', () => {
    expect(buildGrokAcpClientInfo('0.1.0-test')).toEqual({
      name: 'agent-studio',
      version: '0.1.0-test'
    })
    expect(buildGrokAcpClientInfo(' 1.2.3-dev ')).toEqual({
      name: 'agent-studio',
      version: '1.2.3-dev'
    })
    expect(() => buildGrokAcpClientInfo('')).toThrow(/clientInfo\.version/)
    expect(() => buildGrokAcpClientInfo('   ')).toThrow(/clientInfo\.version/)
  })

  it('initialize 允许读取字段列表锁定，其它字段不得进入产品逻辑', () => {
    expect([...GROK_INITIALIZE_RESPONSE_ALLOWED_FIELDS]).toEqual([
      'protocolVersion',
      'agentInfo.version',
      'loadSession',
      'sessionCapabilities.resume',
      'sessionCapabilities.close',
      'promptCapabilities.image',
      'promptCapabilities.embeddedContext'
    ])
  })

  it('产品实际读取的握手字段必须是 allow-list 子集，禁止旁路读取 audio 等未声明能力', () => {
    // 备注：若 Adapter/Mapper 开始读新字段却未进 allow-list，本断言必须先红。
    const allowed = new Set<string>(GROK_INITIALIZE_RESPONSE_ALLOWED_FIELDS)
    for (const field of GROK_INITIALIZE_PRODUCT_READ_FIELDS) {
      expect(allowed.has(field)).toBe(true)
    }
    expect([...GROK_INITIALIZE_PRODUCT_READ_FIELDS]).toEqual([
      'protocolVersion',
      'agentInfo.version',
      'loadSession',
      'sessionCapabilities.resume',
      'sessionCapabilities.close',
      'promptCapabilities.image',
      'promptCapabilities.embeddedContext'
    ])
    expect(GROK_INITIALIZE_PRODUCT_READ_FIELDS).not.toContain('promptCapabilities.audio')
    expect(GROK_INITIALIZE_RESPONSE_ALLOWED_FIELDS).not.toContain('promptCapabilities.audio')
  })

  it('projectGrokHandshakeFields 只投影 allow-list，promptMedia 走 image/embeddedContext', () => {
    const projected = projectGrokHandshakeFields({
      protocolVersion: 1,
      agentInfo: { version: '1.0.5' },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {}, close: {} },
        promptCapabilities: {
          image: false,
          embeddedContext: true,
          // 备注：audio 即使出现也不得进入产品投影。
          audio: true
        }
      }
    })
    expect(projected).toEqual({
      protocolVersion: 1,
      agentInfoVersion: '1.0.5',
      loadSession: true,
      resume: true,
      close: true,
      promptImage: false,
      promptEmbeddedContext: true
    })
    expect(projected).not.toHaveProperty('promptAudio')
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
    // 备注：fixture 不得绑死生产 argv；禁止把 --no-auto-update / agent stdio 带进受控 spawn。
    expect(e2eArgs).not.toContain('--no-auto-update')
    expect(e2eArgs).not.toContain('agent')
    expect(e2eArgs).not.toContain('stdio')
    expect(e2eArgs).toContain('--scenario')
    expect(e2eArgs).toContain('--user-data')
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

describe('Grok ACP 连接失败分类', () => {
  const homePath = '/Users/tester/.grok/bin/grok'
  const fakeKey = 'sk-fake-adapter-key-for-redaction'

  it('spawn ENOENT（code 或 message）归类为 cli-missing，产品文案不含路径与 stderr 原文', () => {
    const byCode = Object.assign(new Error(`spawn ${homePath} ENOENT`), { code: 'ENOENT' })
    const byMessage = new Error(`spawn grok ENOENT\n${homePath}`)

    expect(classifyGrokSpawnProcessError(byCode)).toBe('cli-missing')
    expect(classifyGrokSpawnProcessError(byMessage)).toBe('cli-missing')

    const resolved = resolveGrokAcpFailure('cli-missing')
    expect(resolved.adapterErrorCode).toBe('runtime-unavailable')
    expect(resolved.message).toBe(GROK_ACP_PRODUCT_MESSAGES.cliMissing)
    expect(resolved.message).toBe('还没有安装 Grok Build CLI。')
    expect(resolved.message).not.toContain(homePath)
    expect(resolved.message).not.toContain('ENOENT')
    expect(resolved.message).not.toContain('spawn')
  })

  it('协议版本不兼容可被识别，且产品文案保留协议语义而不是笼统连接失败', () => {
    const error = new Error(
      `ACP 协议版本不兼容：Runtime 返回 ${acp.PROTOCOL_VERSION + 1}，客户端支持 ${acp.PROTOCOL_VERSION}。`
    )
    expect(classifyGrokConnectError(error)).toBe('protocol-incompatible')

    const resolved = resolveGrokAcpFailure('protocol-incompatible', {
      redactedDetail: error.message
    })
    expect(resolved.adapterErrorCode).toBe('operation-failed')
    expect(resolved.message).toContain('ACP 协议版本不兼容')
    expect(resolved.message).not.toMatch(/^连接失败/)
  })

  it('各类失败产品文案互相可区分，且不回传家目录 / Key / Header', () => {
    const kinds = [
      resolveGrokAcpFailure('cli-missing').message,
      resolveGrokAcpFailure('protocol-incompatible', {
        redactedDetail: 'ACP 协议版本不兼容：Runtime 返回 2，客户端支持 1。'
      }).message,
      resolveGrokAcpFailure('provider-config-missing').message,
      resolveGrokAcpFailure('set-model-failed').message,
      resolveGrokAcpFailure('process-exited', { exitCode: 1 }).message,
      resolveGrokAcpFailure('config-write-failed', {
        redactedDetail: '磁盘写入失败'
      }).message
    ] as const

    expect(new Set(kinds).size).toBe(kinds.length)
    expect(kinds[0]).toBe('还没有安装 Grok Build CLI。')
    expect(kinds[2]).toBe('模型服务配置不可用，请重新配置 URL、Key 和模型。')
    expect(kinds[3]).toContain('绑定 Agent Studio 模型失败')
    expect(kinds[4]).toBe('Grok Build 已退出，代码 1')

    const joined = kinds.join('\n')
    expect(joined).not.toContain(homePath)
    expect(joined).not.toContain(fakeKey)
    expect(joined).not.toContain('Authorization')
    expect(joined).not.toContain('Bearer')
  })

  it('缺 Provider 映射 runtime-unavailable；其它连接类失败默认 operation-failed', () => {
    expect(resolveGrokAcpFailure('provider-config-missing').adapterErrorCode).toBe(
      'runtime-unavailable'
    )
    expect(resolveGrokAcpFailure('cli-missing').adapterErrorCode).toBe('runtime-unavailable')
    expect(resolveGrokAcpFailure('set-model-failed').adapterErrorCode).toBe('operation-failed')
    expect(resolveGrokAcpFailure('process-exited', { exitCode: null }).adapterErrorCode).toBe(
      'operation-failed'
    )
    expect(resolveGrokAcpFailure('generic', { redactedDetail: 'timeout' }).message).toContain(
      '连接失败'
    )
  })
})
