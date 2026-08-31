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
