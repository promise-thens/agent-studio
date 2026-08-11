import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue'
import type {
  AgentCapability,
  AgentCapabilityId,
  AgentRuntimeCapabilitySnapshot,
  AgentRuntimeStatus
} from '../../../shared/agent'

export interface RuntimeCapabilityResolution {
  capabilityId: AgentCapabilityId
  available: boolean
  reason?: string
  notice?: string
  capability?: AgentCapability
}

export interface RuntimeCapabilitiesController {
  capabilitySnapshot: ComputedRef<AgentRuntimeCapabilitySnapshot | undefined>
  resolveCapability: (
    capabilityId: AgentCapabilityId,
    actionLabel: string
  ) => RuntimeCapabilityResolution
  isAvailable: (capabilityId: AgentCapabilityId) => boolean
}

const UNVERIFIED_REASON = '当前 Runtime 尚未验证此能力。'

/**
 * 把主进程提供的能力快照转换为 Renderer 可直接使用的门禁结论。
 * 此处只读取当前状态，不缓存旧连接快照，也不会根据 UI 已收到的事件反向修改能力事实。
 */
export function useRuntimeCapabilities(
  status: MaybeRefOrGetter<AgentRuntimeStatus>
): RuntimeCapabilitiesController {
  const capabilitySnapshot = computed(() => toValue(status).capabilitySnapshot)

  /** 解析单项能力，并为降级、实验性或不可用状态生成可展示说明。 */
  function resolveCapability(
    capabilityId: AgentCapabilityId,
    actionLabel: string
  ): RuntimeCapabilityResolution {
    const capability = capabilitySnapshot.value?.capabilities[capabilityId]

    if (!capability) {
      return {
        capabilityId,
        available: false,
        reason: UNVERIFIED_REASON
      }
    }

    if (capability.support === 'unknown') {
      return {
        capabilityId,
        available: false,
        reason: capability.reason || UNVERIFIED_REASON,
        capability
      }
    }

    if (capability.support === 'unsupported') {
      return {
        capabilityId,
        available: false,
        reason: capability.reason || `当前 Runtime 不支持${actionLabel}。`,
        capability
      }
    }

    const notices: string[] = []
    if (capability.support === 'simulated') {
      notices.push(`模拟能力：${capability.reason || `${actionLabel}由 Agent Studio 模拟提供。`}`)
    }
    if (capability.maturity === 'experimental') {
      notices.push(`实验性能力：${capability.reason || `${actionLabel}的行为仍可能变化。`}`)
    }

    return {
      capabilityId,
      available: true,
      ...(notices.length > 0 ? { notice: notices.join('；') } : {}),
      capability
    }
  }

  /** 供 disabled、键盘发送等布尔门禁复用，避免不同入口产生不一致判断。 */
  function isAvailable(capabilityId: AgentCapabilityId): boolean {
    return resolveCapability(capabilityId, '此操作').available
  }

  return {
    capabilitySnapshot,
    resolveCapability,
    isAvailable
  }
}
