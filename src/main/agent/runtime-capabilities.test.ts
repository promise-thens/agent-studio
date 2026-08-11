import { describe, expect, it } from 'vitest'
import { AGENT_CAPABILITY_IDS } from '../../shared/agent'
import {
  createAgentRuntimeCapabilitySnapshot,
  normalizeAgentCapability,
  updateAgentRuntimeCapabilitySnapshot,
  type AgentCapabilityInput
} from './runtime-capabilities'

const timestamp = '2026-08-11T10:00:00.000Z'

describe('Runtime 能力矩阵归一化', () => {
  it('补齐全部固定 ID，并将缺失能力保守标记为 unknown', () => {
    const snapshot = createAgentRuntimeCapabilitySnapshot({
      runtimeId: 'grok',
      observedAt: timestamp,
      capabilities: [
        {
          capabilityId: 'runtime.connect',
          support: 'native',
          maturity: 'stable',
          verification: 'declared',
          source: 'static'
        }
      ]
    })

    expect(Object.keys(snapshot.capabilities)).toEqual(AGENT_CAPABILITY_IDS)
    expect(snapshot.capabilities['runtime.connect']).toEqual({
      capabilityId: 'runtime.connect',
      support: 'native',
      maturity: 'stable',
      verification: 'declared',
      source: 'static'
    })
    expect(snapshot.capabilities['session.resume']).toEqual({
      capabilityId: 'session.resume',
      support: 'unknown',
      verification: 'unverified',
      source: 'fallback',
      reason: '当前 Runtime 尚未验证此能力。'
    })
  })

  it.each([
    {
      name: 'native 缺少 maturity',
      input: {
        capabilityId: 'runtime.connect',
        support: 'native',
        verification: 'declared',
        source: 'static'
      }
    },
    {
      name: '未知 support 值',
      input: {
        capabilityId: 'runtime.connect',
        support: 'marketing-only',
        maturity: 'stable',
        verification: 'declared',
        source: 'static'
      }
    },
    {
      name: 'declared 使用 runtime 来源',
      input: {
        capabilityId: 'runtime.connect',
        support: 'native',
        maturity: 'stable',
        verification: 'declared',
        source: 'runtime'
      }
    },
    {
      name: 'verified 使用 protocol 来源',
      input: {
        capabilityId: 'runtime.connect',
        support: 'native',
        maturity: 'stable',
        verification: 'verified',
        source: 'protocol'
      }
    },
    {
      name: 'simulated 缺少原因',
      input: {
        capabilityId: 'session.resume',
        support: 'simulated',
        maturity: 'stable',
        verification: 'declared',
        source: 'static'
      }
    },
    {
      name: 'experimental 缺少原因',
      input: {
        capabilityId: 'usage.context',
        support: 'native',
        maturity: 'experimental',
        verification: 'declared',
        source: 'static'
      }
    },
    {
      name: 'unsupported 缺少负证据',
      input: {
        capabilityId: 'session.load',
        support: 'unsupported',
        verification: 'verified',
        source: 'runtime',
        reason: '运行时没有返回能力'
      }
    }
  ])('$name 时回退为 unknown', ({ input }) => {
    const capability = normalizeAgentCapability(input as AgentCapabilityInput)

    expect(capability).toMatchObject({
      support: 'unknown',
      verification: 'unverified',
      source: 'fallback'
    })
    expect(capability).not.toHaveProperty('maturity')
    expect(capability.reason).toBeTruthy()
  })

  it('unsupported 只保留静态或协议负证据，并移除 maturity', () => {
    expect(
      normalizeAgentCapability({
        capabilityId: 'session.load',
        support: 'unsupported',
        maturity: 'experimental',
        verification: 'unverified',
        source: 'protocol',
        reason: 'ACP 明确声明不支持加载会话'
      })
    ).toEqual({
      capabilityId: 'session.load',
      support: 'unsupported',
      verification: 'declared',
      source: 'protocol',
      reason: 'ACP 明确声明不支持加载会话'
    })
  })

  it('原因先脱敏再按 UTF-8 512 bytes 截断，不切断中文或 emoji', () => {
    const capability = normalizeAgentCapability(
      {
        capabilityId: 'usage.context',
        support: 'native',
        maturity: 'experimental',
        verification: 'declared',
        source: 'static',
        reason: `api_key=sk-fake-secret ${'你😀'.repeat(200)}`
      },
      (text) => text.replace('sk-fake-secret', '[FAKE-REDACTED]')
    )

    expect(capability.reason).toContain('[REDACTED]')
    expect(capability.reason).not.toContain('sk-fake-secret')
    expect(Buffer.byteLength(capability.reason ?? '', 'utf8')).toBeLessThanOrEqual(512)
    expect(capability.reason?.endsWith('\uFFFD')).toBe(false)
  })

  it('更新单项能力时保留完整矩阵和版本，只提升目标项', () => {
    const baseline = createAgentRuntimeCapabilitySnapshot({
      runtimeId: 'grok',
      runtimeVersion: '1.2.3',
      protocolVersion: '1',
      observedAt: timestamp
    })
    const updated = updateAgentRuntimeCapabilitySnapshot(
      baseline,
      {
        capabilityId: 'runtime.connect',
        support: 'native',
        maturity: 'stable',
        verification: 'verified',
        source: 'runtime'
      },
      { observedAt: '2026-08-11T10:01:00.000Z' }
    )

    expect(updated.runtimeVersion).toBe('1.2.3')
    expect(updated.protocolVersion).toBe('1')
    expect(updated.observedAt).toBe('2026-08-11T10:01:00.000Z')
    expect(updated.capabilities['runtime.connect'].verification).toBe('verified')
    expect(updated.capabilities['session.resume'].support).toBe('unknown')
  })

  it('只投影公开字段，忽略重复项以外的原始协议扩展，并支持克隆和 JSON 往返', () => {
    const rawCapability = {
      capabilityId: 'session.resume',
      support: 'native',
      maturity: 'stable',
      verification: 'declared',
      source: 'protocol',
      reason: 'ACP 声明支持恢复',
      _meta: { agentVersion: 'secret-version' },
      authMethods: ['secret'],
      modelState: { apiKey: 'sk-fake-secret' },
      instanceId: 'private-instance'
    } as AgentCapabilityInput
    const snapshot = createAgentRuntimeCapabilitySnapshot({
      runtimeId: 'grok',
      observedAt: timestamp,
      capabilities: [rawCapability]
    })
    const serialized = JSON.stringify(snapshot)

    expect(structuredClone(snapshot)).toEqual(snapshot)
    expect(JSON.parse(serialized)).toEqual(snapshot)
    for (const forbidden of [
      '_meta',
      'authMethods',
      'modelState',
      'instanceId',
      'secret-version'
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })
})
