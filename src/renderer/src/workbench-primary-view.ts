export const WORKBENCH_PRIMARY_VIEWS = ['conversation', 'plugins'] as const

export type WorkbenchPrimaryView = (typeof WORKBENCH_PRIMARY_VIEWS)[number]

export const DEFAULT_WORKBENCH_PRIMARY_VIEW: WorkbenchPrimaryView = 'conversation'

export type ExecutionSurfaceBannerKind = 'none' | 'running' | 'waiting-permission'

const WORKBENCH_PRIMARY_VIEW_IDS: readonly WorkbenchPrimaryView[] = WORKBENCH_PRIMARY_VIEWS

export function isWorkbenchPrimaryView(value: unknown): value is WorkbenchPrimaryView {
  return (
    typeof value === 'string' && WORKBENCH_PRIMARY_VIEW_IDS.includes(value as WorkbenchPrimaryView)
  )
}

/** 未知值一律回到对话，避免主列空白。 */
export function resolveWorkbenchPrimaryView(value: unknown): WorkbenchPrimaryView {
  return isWorkbenchPrimaryView(value) ? value : DEFAULT_WORKBENCH_PRIMARY_VIEW
}

/**
 * 插件页也要能看见后台 Task；对话页本身已展示执行态，不必再叠一条。
 * 仅 running / waiting-permission 出条，其余状态或无执行一律 none。
 */
export function resolveExecutionSurfaceBanner(input: {
  primaryView: WorkbenchPrimaryView
  activeExecution: { taskId: string; state: string } | null
}): { kind: ExecutionSurfaceBannerKind; taskId: string } | { kind: 'none' } {
  if (input.primaryView !== 'plugins') {
    return { kind: 'none' }
  }

  const execution = input.activeExecution
  if (!execution) {
    return { kind: 'none' }
  }

  if (execution.state === 'waiting-permission') {
    return { kind: 'waiting-permission', taskId: execution.taskId }
  }

  if (execution.state === 'running') {
    return { kind: 'running', taskId: execution.taskId }
  }

  return { kind: 'none' }
}

/**
 * 切到插件页时必须保持选中与运行身份。
 * activeExecutionTaskId 只作「不得取消」的见证，不得进入返回值或触发 cancel。
 */
export function applyOpenPlugins(input: {
  selectedTaskId: string
  activeExecutionTaskId: string | null
}): { primaryView: 'plugins'; selectedTaskId: string; cancelTurn: false } {
  void input.activeExecutionTaskId
  return {
    primaryView: 'plugins',
    selectedTaskId: input.selectedTaskId,
    cancelTurn: false
  }
}
