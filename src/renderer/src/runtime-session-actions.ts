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
export async function chooseWorkspaceWhenIdle(
  isBusy: () => boolean,
  chooseWorkspace: () => Promise<string | null>
): Promise<string | null> {
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
