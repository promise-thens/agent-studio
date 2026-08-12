import type { AgentRuntimeStatus } from '../../shared/agent'

/**
 * 创建一个异步单飞门禁；锁会在回调首次 await 前同步生效，避免 Enter 与点击重复启动同一操作。
 */
export function createAsyncSingleFlight(
  onPendingChange: (pending: boolean) => void = () => undefined
): (action: () => Promise<void>) => Promise<boolean> {
  let pending = false

  return async (action): Promise<boolean> => {
    if (pending) return false

    pending = true
    try {
      onPendingChange(true)
      await action()
      return true
    } finally {
      pending = false
      onPendingChange(false)
    }
  }
}

/**
 * 目录选择只允许从 idle 状态开始；Picker 等待期间若进入 busy，则丢弃结果，禁止切换当前 Task。
 */
export async function chooseWorkspaceWhenIdle<T>(
  isBusy: () => boolean,
  chooseWorkspace: () => Promise<T | null>
): Promise<T | null> {
  if (isBusy()) return null

  const selected = await chooseWorkspace()
  return isBusy() ? null : selected
}

/** 发送按钮和键盘 Enter 共用同一判断，避免键盘路径绕过能力门禁。 */
export function canSendRuntimePrompt(
  prompt: string,
  status: AgentRuntimeStatus,
  promptCapabilityAvailable: boolean
): boolean {
  return Boolean(prompt.trim()) && status.state === 'ready' && promptCapabilityAvailable
}

/**
 * 判断 Project 是否需要发起 Runtime 连接。
 * 只有 Provider、Project 和当前交互状态都允许时才连接；同目录已 ready 时避免重复重启会话。
 */
export function shouldConnectProject(
  status: AgentRuntimeStatus,
  targetWorkspace: string,
  providerConfigured: boolean,
  projectExecutable: boolean,
  blocked: boolean
): boolean {
  if (!targetWorkspace || !providerConfigured || !projectExecutable || blocked) return false
  return status.state !== 'ready' || status.workspace !== targetWorkspace
}
