import { isGrokSandboxProfile, type GrokSandboxProfile } from '../../shared/grok-sandbox-profile'

export interface GrokSandboxOptionCopy {
  profile: GrokSandboxProfile
  label: string
  description: string
}

/** 设置页标题：Grok 进程内核限制，不是 Electron sandbox。 */
export const GROK_SANDBOX_TITLE = 'Grok 沙箱'

export const GROK_SANDBOX_INTRO =
  '这是 Grok 进程的内核限制，不是 Electron webPreferences.sandbox，也不是 Permission Broker 的替代。Permission Broker 仍然审批。改档会重启 Runtime；已有 Grok 会话若以不同档位创建，恢复可能失败。只读和严格档按 Grok 档位，不承诺挡住记忆 junction 写入 ~/.grok/memory。'

export const GROK_SANDBOX_BUSY_TITLE = '任务执行中，结束后才能改 Grok 沙箱'

export const GROK_SANDBOX_SAVING_TITLE = '正在应用 Grok 沙箱…'

export const GROK_SANDBOX_APPLIED_MESSAGE = 'Grok 沙箱已应用。'

export const GROK_SANDBOX_NOT_APPLIED_MESSAGE =
  'Grok 沙箱尚未应用到 Runtime。选择器已回到上一确认档。'

/** 选择器只提供这四档；顺序按日常到关闭，禁止自由文本。 */
export const GROK_SANDBOX_OPTIONS: readonly GrokSandboxOptionCopy[] = [
  {
    profile: 'workspace',
    label: '日常',
    description: '可读各处，可写 CWD；按 Grok 档位。Broker 仍然审批。'
  },
  {
    profile: 'read-only',
    label: '以读为主',
    description: '项目文件不可写；按 Grok 档位。Broker 仍然审批。'
  },
  {
    profile: 'strict',
    label: '更窄读',
    description: '主要可读 CWD + 系统路径；按 Grok 档位。Broker 仍然审批。'
  },
  {
    profile: 'off',
    label: '关闭',
    description: '无 Grok 内核限制。Broker 仍然审批。'
  }
]

/**
 * 只有主进程明确 applied: true 且档位合法时才接受新档。
 * pending / applied: false / 非法 profile 一律回到上一确认档，禁止乐观显示。
 */
export function resolveConfirmedSandboxProfile(
  previous: GrokSandboxProfile | null,
  result: { profile: unknown; applied: unknown } | null | undefined
): GrokSandboxProfile | null {
  if (result?.applied === true && isGrokSandboxProfile(result.profile)) {
    return result.profile
  }
  return previous
}

/**
 * 选择器 value 只允许四档字面量。非法字符串（含 devbox）返回 null，不得写进 UI。
 */
export function resolveSandboxSelectValue(value: unknown): GrokSandboxProfile | null {
  return isGrokSandboxProfile(value) ? value : null
}
