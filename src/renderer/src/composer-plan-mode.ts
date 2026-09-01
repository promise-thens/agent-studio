import { isPlanCommandAdvertised, type ComposerPlanMode } from '../../shared/session-plan-mode'
import type { PermissionPromptStyle, TaskPermissionMode } from '../../shared/task-takeover'

/** 真机未广告 `plan` 时开关禁用文案；禁止因此伪造 `/plan`。 */
export const PLAN_SWITCH_UNAVAILABLE_TITLE = '当前会话未提供 Plan'

/** Plan 且空闲时可写在开关旁；不要盖掉接管 HUD。 */
export const PLAN_NEXT_TURN_STATUS = '下一轮按 Plan 发送'

export interface ComposerPlanSwitchInput {
  advertisedCommands: readonly { name: string }[]
  mode: ComposerPlanMode
  modelBusy: boolean
  composerAction: 'send' | 'stop'
  hasActiveExecution: boolean
}

export interface ComposerPlanSwitchState {
  disabled: boolean
  canToggle: boolean
  title: string
  pressed: boolean
}

/**
 * 进入 Plan 必须精确广告 `name === 'plan'` 且空闲；退出 Plan 只要求空闲。
 * 广告中途消失时不得把开关卡在 pressed+disabled，否则用户回不去 Normal。
 * modelBusy、停止按钮、活动执行仍锁住双向切换，避免执行中改下一轮策略。
 */
export function resolveComposerPlanSwitch(input: ComposerPlanSwitchInput): ComposerPlanSwitchState {
  const advertised = isPlanCommandAdvertised(input.advertisedCommands)
  const executing = input.modelBusy || input.composerAction === 'stop' || input.hasActiveExecution
  const leavingPlan = input.mode === 'plan'
  const canToggle = !executing && (leavingPlan || advertised)
  const title = executing
    ? '任务执行中，暂时不能切换 Plan'
    : leavingPlan
      ? '关闭 Plan 模式'
      : !advertised
        ? PLAN_SWITCH_UNAVAILABLE_TITLE
        : '开启 Plan 模式'
  return {
    disabled: !canToggle,
    canToggle,
    title,
    pressed: leavingPlan
  }
}

/**
 * 只有用户已打开 Plan、会话空闲、且 Runtime 真的广告了 `plan` 才提示下一轮改写。
 * 无广告时即使本地仍停在 plan 也不展示，避免暗示会伪造斜杠。
 */
export function resolveComposerPlanStatusCopy(input: {
  mode: ComposerPlanMode
  idle: boolean
  hasPlanCommand: boolean
}): string | null {
  if (input.mode === 'plan' && input.idle && input.hasPlanCommand) {
    return PLAN_NEXT_TURN_STATUS
  }
  return null
}

/**
 * 打开 Plan 时若当前是接管，先回到快照里的 previous style。
 * 不走接管确认框；IPC 失败则调用方不得进入 plan。
 */
export function resolveOpenPlanPermissionChange(input: {
  permissionMode: TaskPermissionMode
  previousStyle?: PermissionPromptStyle
}): { permissionModeToSet: PermissionPromptStyle | null } {
  if (input.permissionMode !== 'takeover') {
    return { permissionModeToSet: null }
  }
  return { permissionModeToSet: input.previousStyle === 'ask' ? 'ask' : 'assist' }
}

/**
 * 开 Plan 依赖的批准模式 IPC 失败时保持 `'normal'`，禁止乐观打开。
 */
export function resolvePlanModeAfterOpenPlanIpc(input: {
  permissionChangeRequired: boolean
  ipcSucceeded: boolean
}): ComposerPlanMode {
  if (input.permissionChangeRequired && !input.ipcSucceeded) return 'normal'
  return 'plan'
}

/** 接管确认成功后退出 Plan；Plan 不是第四个批准档。 */
export function resolvePlanModeAfterTakeoverApplied(): ComposerPlanMode {
  return 'normal'
}
