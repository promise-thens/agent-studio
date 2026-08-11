import type { AgentRuntimeStatus } from '../../shared/agent'

export interface RebuildRuntimeSessionOptions {
  status: AgentRuntimeStatus
  workspace: string
  chooseWorkspace: () => Promise<string | null>
  connect: (workspace: string) => Promise<AgentRuntimeStatus>
  disconnect: () => Promise<AgentRuntimeStatus>
}

export interface RebuildRuntimeSessionResult {
  workspace: string
  status: AgentRuntimeStatus & { state: 'ready'; runtimeSessionId: string }
}

/**
 * 通过断开并重新连接创建真实 Runtime session；只有新会话确认 ready 后才允许上层清空界面。
 */
export async function rebuildRuntimeSession(
  options: RebuildRuntimeSessionOptions
): Promise<RebuildRuntimeSessionResult | null> {
  if (options.status.state === 'busy' || options.status.state === 'connecting') {
    throw new Error('Runtime 正在执行或连接中，暂时不能创建新对话。')
  }

  const workspace = options.workspace || (await options.chooseWorkspace())
  if (!workspace) return null

  if (options.status.state === 'ready') {
    await options.disconnect()
  }

  const nextStatus = await options.connect(workspace)
  if (nextStatus.state !== 'ready' || !nextStatus.runtimeSessionId) {
    throw new Error('Runtime 未返回可用的新会话，旧对话记录已保留。')
  }

  return {
    workspace,
    status: { ...nextStatus, state: 'ready', runtimeSessionId: nextStatus.runtimeSessionId }
  }
}

/** 发送按钮和键盘 Enter 共用同一判断，避免键盘路径绕过能力门禁。 */
export function canSendRuntimePrompt(
  prompt: string,
  status: AgentRuntimeStatus,
  promptCapabilityAvailable: boolean
): boolean {
  return Boolean(prompt.trim()) && status.state === 'ready' && promptCapabilityAvailable
}
