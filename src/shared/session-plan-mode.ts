import { AVAILABLE_COMMAND_NAME_PATTERN } from './agent-available-command'

/**
 * Composer Plan 模式与 Grok `/plan` 的纯改写。
 *
 * 真机 1.0.13：`available_commands_update` 未广告 `plan`；未广告时禁止伪造斜杠。
 * 广告存在且空闲时，用一次 `session/prompt` 发送 `/plan ` + 正文，不要拆两次 prompt。
 */

/** Grok 广告的 Plan 斜杠命令 name（无前导 /）。匹配必须精确 `name === 'plan'`。 */
export const GROK_PLAN_SLASH_COMMAND = 'plan'

export type ComposerPlanMode = 'normal' | 'plan'

/**
 * 广告匹配必须精确 `name === 'plan'`；`plan-mode`、`view-plan`、`/plan` 等变体不算。
 * 当前 Grok 1.0.13 未广告该命令，调用方必须把结果当成开关禁用条件。
 */
export function isPlanCommandAdvertised(advertisedCommands: readonly { name: string }[]): boolean {
  return advertisedCommands.some((cmd) => cmd.name === GROK_PLAN_SLASH_COMMAND)
}

/**
 * 把 Composer Plan 开关落到实际 `session/prompt` 文本。
 *
 * 边界：无广告、执行中、普通模式都不改写，避免桌面伪造 `/plan`。
 * 已是 Runtime 斜杠（`/compact`、`/plan …`、`/view-plan`）不再包一层，防止双斜杠。
 * 风险：Grok 即使未广告，手工发送 `/plan` 仍可能进 plan；产品路径仍以广告为准。
 */
export function resolvePlanSubmit(input: {
  mode: ComposerPlanMode
  prompt: string
  hasPlanCommand: boolean
  idle: boolean
}): { prompt: string } {
  const { mode, prompt, hasPlanCommand, idle } = input
  if (mode !== 'plan' || !hasPlanCommand || !idle) {
    return { prompt }
  }
  if (isAlreadyRuntimeSlashPrompt(prompt)) {
    return { prompt }
  }

  const trimmed = prompt.trim()
  if (trimmed === '') {
    return { prompt: `/${GROK_PLAN_SLASH_COMMAND}` }
  }
  return { prompt: `/${GROK_PLAN_SLASH_COMMAND} ${trimmed}` }
}

/**
 * 用户已经在写 Runtime 斜杠时不要再套 `/plan`。
 * 只认 ACP 命令 name 形态，避免把普通正文里的 `/` 误判成命令。
 */
function isAlreadyRuntimeSlashPrompt(prompt: string): boolean {
  const trimmed = prompt.trim()
  if (!trimmed.startsWith('/')) return false
  const name = trimmed.slice(1).split(/\s/, 1)[0] ?? ''
  return AVAILABLE_COMMAND_NAME_PATTERN.test(name)
}
