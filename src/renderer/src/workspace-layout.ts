export type WorkspaceLayoutMode = 'conversation' | 'split' | 'browser-focus'
export const WORKSPACE_CHAT_MIN = 380
export const WORKSPACE_BROWSER_MIN = 320
export const WORKSPACE_BROWSER_DEFAULT = 480
export const WORKSPACE_FOCUS_THRESHOLD = 48

export interface WorkspaceWidthBudget {
  /** 包含侧栏的实际工作区宽度，不是 screen.width 或缓存值。 */
  workspaceWidth: number
  sidebarWidth?: number
  inspectorWidth?: number
  separatorsWidth?: number
}

/** 非有限尺寸归零；未知容器不能假造足够空间。 */
function pixels(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0
}

/** 所有入口复用实际预算；Inspector 不够放先请求收起，再决定是否隐藏浏览器。 */
export function resolveWorkspaceWidths(
  budget: WorkspaceWidthBudget,
  requestedWidth: unknown = WORKSPACE_BROWSER_DEFAULT
): {
  browserWidth: number
  chatWidth: number
  maxBrowserWidth: number
  collapseInspector: boolean
  collapseBrowser: boolean
} {
  const usable = Math.max(
    0,
    pixels(budget.workspaceWidth) - pixels(budget.sidebarWidth) - pixels(budget.separatorsWidth)
  )
  const inspector = pixels(budget.inspectorWidth)
  const collapseInspector =
    inspector > 0 && usable - inspector < WORKSPACE_CHAT_MIN + WORKSPACE_BROWSER_MIN
  const available = Math.max(0, usable - (collapseInspector ? 0 : inspector))
  const maxBrowserWidth = Math.max(0, available - WORKSPACE_CHAT_MIN)
  const collapseBrowser = maxBrowserWidth < WORKSPACE_BROWSER_MIN
  const parsed =
    typeof requestedWidth === 'string' && requestedWidth.trim()
      ? Number(requestedWidth)
      : requestedWidth
  const requested =
    typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0
      ? parsed
      : WORKSPACE_BROWSER_DEFAULT
  const browserWidth = collapseBrowser
    ? 0
    : Math.round(Math.min(maxBrowserWidth, Math.max(WORKSPACE_BROWSER_MIN, requested)))
  return {
    browserWidth,
    chatWidth: available - browserWidth,
    maxBrowserWidth,
    collapseInspector,
    collapseBrowser
  }
}

/** 只对显式拖动提供专注预览；缩窗和坏缓存不能自行切换模式。 */
export function resolveWorkspaceDrag(
  budget: WorkspaceWidthBudget,
  candidate: number
): ReturnType<typeof resolveWorkspaceWidths> & { requestFocus: boolean } {
  const widths = resolveWorkspaceWidths(budget, candidate)
  return {
    ...widths,
    requestFocus:
      Number.isFinite(candidate) && candidate >= widths.maxBrowserWidth + WORKSPACE_FOCUS_THRESHOLD
  }
}
