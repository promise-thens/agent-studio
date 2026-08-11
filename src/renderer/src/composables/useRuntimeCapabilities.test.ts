import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import type {
  AgentCapability,
  AgentCapabilityId,
  AgentRuntimeCapabilitySnapshot,
  AgentRuntimeStatus
} from '../../../shared/agent'
import { useRuntimeCapabilities } from './useRuntimeCapabilities'

const OBSERVED_AT = '2026-08-11T08:00:00.000Z'

describe('useRuntimeCapabilities', () => {
  it('native 和 simulated 可用，并明确说明 simulated 降级', () => {
    const status = ref(
      createStatus({
        'session.prompt.text': createCapability('session.prompt.text', 'native'),
        'session.cancel': createCapability('session.cancel', 'simulated', {
          reason: '取消由 Agent Studio 收束当前 Turn。'
        })
      })
    )
    const capabilities = useRuntimeCapabilities(status)

    expect(capabilities.resolveCapability('session.prompt.text', '发送消息')).toMatchObject({
      available: true,
      capabilityId: 'session.prompt.text'
    })
    expect(capabilities.resolveCapability('session.cancel', '停止任务')).toMatchObject({
      available: true,
      notice: '模拟能力：取消由 Agent Studio 收束当前 Turn。'
    })
    expect(capabilities.isAvailable('session.cancel')).toBe(true)
  })

  it('experimental 可操作，但必须返回实验性说明', () => {
    const status = ref(
      createStatus({
        'usage.context': createCapability('usage.context', 'native', {
          maturity: 'experimental',
          reason: '不同 Runtime 版本可能缺少统计字段。'
        })
      })
    )
    const capabilities = useRuntimeCapabilities(status)

    expect(capabilities.resolveCapability('usage.context', '查看上下文用量')).toMatchObject({
      available: true,
      notice: '实验性能力：不同 Runtime 版本可能缺少统计字段。'
    })
  })

  it('unknown、unsupported 和缺失能力均不可用，并保留主进程原因', () => {
    const status = ref(
      createStatus({
        'session.load': createCapability('session.load', 'unknown', {
          reason: '连接后才能确认是否支持加载会话。'
        }),
        'session.resume': createCapability('session.resume', 'unsupported', {
          reason: '当前协议明确未声明恢复能力。'
        })
      })
    )
    const capabilities = useRuntimeCapabilities(status)

    expect(capabilities.resolveCapability('session.load', '加载会话')).toMatchObject({
      available: false,
      reason: '连接后才能确认是否支持加载会话。'
    })
    expect(capabilities.resolveCapability('session.resume', '恢复会话')).toMatchObject({
      available: false,
      reason: '当前协议明确未声明恢复能力。'
    })
    expect(capabilities.resolveCapability('event.tool', '查看工具活动')).toEqual({
      capabilityId: 'event.tool',
      available: false,
      reason: '当前 Runtime 尚未验证此能力。'
    })
  })

  it('缺少快照时采用统一未验证说明，并随状态更新实时切换', () => {
    const status = ref<AgentRuntimeStatus>({
      runtimeId: 'grok',
      state: 'idle',
      message: '尚未连接'
    })
    const capabilities = useRuntimeCapabilities(status)

    expect(capabilities.isAvailable('session.prompt.text')).toBe(false)
    expect(capabilities.resolveCapability('session.prompt.text', '发送消息').reason).toBe(
      '当前 Runtime 尚未验证此能力。'
    )

    status.value = createStatus({
      'session.prompt.text': createCapability('session.prompt.text', 'native')
    })

    expect(capabilities.capabilitySnapshot.value?.runtimeId).toBe('grok')
    expect(capabilities.isAvailable('session.prompt.text')).toBe(true)

    status.value = {
      runtimeId: 'grok',
      state: 'idle',
      message: '已断开'
    }

    expect(capabilities.capabilitySnapshot.value).toBeUndefined()
    expect(capabilities.isAvailable('session.prompt.text')).toBe(false)
  })
})

function createStatus(
  capabilities: Partial<Record<AgentCapabilityId, AgentCapability>>
): AgentRuntimeStatus {
  return {
    runtimeId: 'grok',
    state: 'ready',
    message: 'Grok Build 已连接',
    capabilitySnapshot: {
      runtimeId: 'grok',
      observedAt: OBSERVED_AT,
      capabilities: capabilities as AgentRuntimeCapabilitySnapshot['capabilities']
    }
  }
}

function createCapability(
  capabilityId: AgentCapabilityId,
  support: AgentCapability['support'],
  overrides: Partial<AgentCapability> = {}
): AgentCapability {
  const supported = support === 'native' || support === 'simulated'
  const explicitlyUnsupported = support === 'unsupported'
  return {
    capabilityId,
    support,
    verification: supported || explicitlyUnsupported ? 'declared' : 'unverified',
    source: explicitlyUnsupported ? 'protocol' : supported ? 'static' : 'fallback',
    ...(supported ? { maturity: 'stable' as const } : {}),
    ...overrides
  }
}
