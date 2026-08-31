/**
 * Task 完全接管（always-approve）的纯决策。
 *
 * 这是把工具审批交给 Grok 的 session 级 always-approve，不是 Permission Broker 沙箱。
 * 新建 session 路径只允许 `_meta.yoloMode: true` 这一键；中途开关依赖广告命令
 * `always-approve`（空闲时以 prompt 发送）。忙碌或未广告时只能 defer，禁止为了开关
 * 丢掉可恢复 session。关闭路径按文档视为同一命令再发一次（documented-toggle /
 * not live-verified-off）。产品永远不回 permission 的 `allow_always`。
 */

/** Grok 广告的接管斜杠命令 name（无前导 /）。 */
export const GROK_TAKEOVER_SLASH_COMMAND = 'always-approve'

export type TakeoverApplyReason = 'busy' | 'command-unavailable'

export type TakeoverApplyDecision =
  | { kind: 'noop' }
  | { kind: 'new-session-meta' }
  | { kind: 'send-command'; commandName: typeof GROK_TAKEOVER_SLASH_COMMAND }
  | { kind: 'defer-next-session'; reason: TakeoverApplyReason }

export interface TakeoverApplyInput {
  hasSession: boolean
  idle: boolean
  advertisedCommands: readonly { name: string }[]
  desiredEnabled: boolean
  currentlyApplied: boolean
}

/**
 * 广告匹配必须精确 `name === 'always-approve'`；`always-approve-now` 等变体不算。
 */
export function isTakeoverCommandAdvertised(
  advertisedCommands: readonly { name: string }[]
): boolean {
  return advertisedCommands.some((cmd) => cmd.name === GROK_TAKEOVER_SLASH_COMMAND)
}

/**
 * 根据 Task 当前 session / 空闲 / 广告状态，决定如何把 desired 接管落到 Grok。
 * 无 session 时打开走 new-session-meta；有 session 时只允许空闲发送斜杠命令。
 */
export function resolveTakeoverApply(input: TakeoverApplyInput): TakeoverApplyDecision {
  const { hasSession, idle, advertisedCommands, desiredEnabled, currentlyApplied } = input

  if (desiredEnabled === currentlyApplied) {
    return { kind: 'noop' }
  }

  if (!hasSession) {
    // 尚无 session：打开留给下次 createSession 写 yoloMode；关闭无需动作
    return desiredEnabled ? { kind: 'new-session-meta' } : { kind: 'noop' }
  }

  // 开关只允许空闲；忙碌时延后到下一 session，避免打断可恢复对话
  if (!idle) {
    return { kind: 'defer-next-session', reason: 'busy' }
  }

  if (!isTakeoverCommandAdvertised(advertisedCommands)) {
    return { kind: 'defer-next-session', reason: 'command-unavailable' }
  }

  return { kind: 'send-command', commandName: GROK_TAKEOVER_SLASH_COMMAND }
}

/**
 * 从 Task 快照或未知 JSON 读取接管字段。
 * 缺字段、非法类型一律 fail-closed 为未接管，不要因此把整条 Task 标 corrupt。
 * takeoverUpdatedAt 仅保留非空 ISO-8601 字符串。
 */
export function readTakeoverSnapshot(value: unknown): {
  takeoverEnabled: boolean
  takeoverUpdatedAt?: string
} {
  const record = asSnapshotRecord(value)
  const takeoverEnabled = record.takeoverEnabled === true
  const takeoverUpdatedAt =
    typeof record.takeoverUpdatedAt === 'string' &&
    record.takeoverUpdatedAt.trim() !== '' &&
    Number.isFinite(Date.parse(record.takeoverUpdatedAt))
      ? record.takeoverUpdatedAt
      : undefined
  return takeoverUpdatedAt === undefined
    ? { takeoverEnabled }
    : { takeoverEnabled, takeoverUpdatedAt }
}

/** 发给 Grok 的接管斜杠命令全文；展示与审计都只用这一字面量，不带用户 prompt。 */
export const GROK_TAKEOVER_CONTROL_PROMPT = `/${GROK_TAKEOVER_SLASH_COMMAND}` as const

/** 公开 agent:start-turn 拒绝该字面量时的提示；内部控制 turn 不走这条闸门。 */
export const PUBLIC_TAKEOVER_CONTROL_PROMPT_BLOCKED_MESSAGE =
  '请改用批准模式菜单切换完全接管，不要直接发送 /always-approve。'

/** 公开 startTurn 不得发送该字面量；内部控制 turn 用同一 prompt 但不经过 IPC 闸门。 */
export function isPublicTakeoverControlPrompt(prompt: string): boolean {
  return prompt === GROK_TAKEOVER_CONTROL_PROMPT
}

export const TASK_PERMISSION_MODES = ['ask', 'assist', 'takeover'] as const
export type TaskPermissionMode = (typeof TASK_PERMISSION_MODES)[number]

export const PERMISSION_PROMPT_STYLES = ['ask', 'assist'] as const
export type PermissionPromptStyle = (typeof PERMISSION_PROMPT_STYLES)[number]

export const TAKEOVER_HUD_COPY = {
  active: 'Grok 正在完全接管',
  pending: '接管未完全生效',
  lingering: '接管可能仍在'
} as const

export const TASK_PERMISSION_MODE_COPY: Record<
  TaskPermissionMode,
  { title: string; subtitle: string }
> = {
  ask: {
    title: '请求批准',
    subtitle: '编辑外部文件、出网和危险命令始终询问'
  },
  assist: {
    title: '帮我批准',
    subtitle: '仅对检测到的风险操作请求批准'
  },
  takeover: {
    title: '完全访问',
    subtitle: '可不受限制地访问互联网和电脑上的文件'
  }
}

export const TAKEOVER_CONFIRM_COPY = {
  title: '让 Grok 完全接管当前任务？',
  statements: [
    '将不再询问工具权限',
    '桌面看不到未上报的操作',
    '命令、改文件、出网都会自己做',
    '若已启用浏览器或 Computer Use 插件，也会自己点'
  ],
  cancel: '取消',
  confirm: '开始接管'
} as const

function asSnapshotRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * 读取询问风格。仅字面量 `'ask'` 为 ask；缺字段与非法值 fail-closed 为当前默认 assist。
 */
export function readPermissionPromptStyle(value: unknown): PermissionPromptStyle {
  return asSnapshotRecord(value).permissionPromptStyle === 'ask' ? 'ask' : 'assist'
}

/**
 * 产品三档：takeoverEnabled 为真即完全接管；否则回落 permissionPromptStyle。
 */
export function taskPermissionModeFromSnapshot(snapshot: {
  takeoverEnabled: boolean
  permissionPromptStyle: PermissionPromptStyle
}): TaskPermissionMode {
  return snapshot.takeoverEnabled ? 'takeover' : snapshot.permissionPromptStyle
}

/**
 * 把三档写回快照。进入接管时保留上次 ask/assist，关掉后才能回到原询问风格。
 */
export function permissionSnapshotFromMode(
  mode: TaskPermissionMode,
  previousStyle: PermissionPromptStyle = 'assist'
): {
  takeoverEnabled: boolean
  permissionPromptStyle: PermissionPromptStyle
} {
  if (mode === 'takeover') {
    return {
      takeoverEnabled: true,
      permissionPromptStyle: previousStyle === 'ask' ? 'ask' : 'assist'
    }
  }
  return { takeoverEnabled: false, permissionPromptStyle: mode }
}

/**
 * HUD 文案。执行中且已 applied 才写「正在完全接管」；停止后即使快照仍是接管也不再写执行态。
 * prefers-reduced-motion 下仍返回这些可见字符串，不能改成只靠动画。
 */
export function resolveTakeoverHudCopy(input: {
  takeoverEnabled: boolean
  takeoverApplied: boolean
  takeoverMayStillBeActive?: boolean
  executing?: boolean
}): string | null {
  if (input.takeoverEnabled && !input.takeoverApplied) {
    return TAKEOVER_HUD_COPY.pending
  }
  if (!input.takeoverEnabled && input.takeoverMayStillBeActive) {
    return TAKEOVER_HUD_COPY.lingering
  }
  if (input.takeoverEnabled && input.takeoverApplied && input.executing) {
    return TAKEOVER_HUD_COPY.active
  }
  return null
}

export function isTaskPermissionMode(value: unknown): value is TaskPermissionMode {
  return value === 'ask' || value === 'assist' || value === 'takeover'
}

/**
 * 菜单是否应把当前档再交给 setPermissionMode。
 * lingering 时允许重选 ask/assist 以重发关闭 toggle；takeover 未 applied 时允许重试开启。
 */
export function shouldResubmitPermissionMode(input: {
  current: TaskPermissionMode
  next: TaskPermissionMode
  takeoverApplied: boolean
  takeoverMayStillBeActive?: boolean
}): boolean {
  if (input.next !== input.current) return true
  if (input.next === 'takeover' && input.takeoverApplied !== true) return true
  return (
    input.takeoverMayStillBeActive === true && (input.next === 'ask' || input.next === 'assist')
  )
}
