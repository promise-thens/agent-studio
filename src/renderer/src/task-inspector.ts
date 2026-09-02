import type {
  AgentPermissionResolutionReason,
  AgentPlanEntry,
  AgentRuntimeId
} from '../../shared/agent'
import type { PermissionAuditRecord } from '../../shared/task-history'
import type {
  TaskTimelineViewModel,
  TimelinePlanNode,
  TurnTimelineViewModel
} from './task-timeline-reducer'

/** 检查器只保留全局审阅域；Turn 内子任务留在对话主列。 */
export type InspectorTab = 'timeline' | 'plan' | 'changes' | 'terminal' | 'artifacts'

export interface InspectorTabDefinition {
  id: InspectorTab
  label: string
}

export interface InspectorPlaceholderCopy {
  heading: string
  detail: string
}

/** 抽屉默认关上，避免常驻 310px 挤占对话列。 */
export const INSPECTOR_DEFAULT_OPEN = false
export const INSPECTOR_DEFAULT_TAB: InspectorTab = 'timeline'
/** 默认仍是侧栏+对话两列；用户吸附后由 App 临时切到第三列。 */
export const WORKSPACE_PRIMARY_COLUMNS = ['sidebar', 'conversation'] as const
/** 默认打开方式保持 overlay，docked 只作为当前工作区的临时布局状态。 */
export const WORKSPACE_INSPECTOR_PLACEMENT = 'overlay' as const

/** 对话卡「审核」只打开 Changes，不切 Timeline。 */
export function openChangesReview(): { open: true; tab: 'changes' } {
  return { open: true, tab: 'changes' }
}

/** 变更、产物加宽成审阅工作区；时间线/终端保持普通悬浮卡。 */
export function inspectorReviewWorkspaceClass(tab: InspectorTab): string {
  const resolved = resolveInspectorTab(tab)
  return resolved === 'changes' || resolved === 'artifacts' ? 'is-review-workspace' : ''
}

export const INSPECTOR_CARD_MARGIN = 12

export interface InspectorCardRect {
  left: number
  top: number
  width: number
  height: number
}

/** 把卡片夹在工作区内，避免拖出窗口后找不到。 */
export function clampInspectorCardRect(input: {
  left: number
  top: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
}): InspectorCardRect {
  const maxWidth = Math.max(1, input.viewportWidth - INSPECTOR_CARD_MARGIN * 2)
  const maxHeight = Math.max(1, input.viewportHeight - INSPECTOR_CARD_MARGIN * 2)
  const width = Math.min(Math.max(1, input.width), maxWidth)
  const height = Math.min(Math.max(1, input.height), maxHeight)
  const maxLeft = input.viewportWidth - width - INSPECTOR_CARD_MARGIN
  const maxTop = input.viewportHeight - height - INSPECTOR_CARD_MARGIN
  return {
    left: clampNumber(input.left, INSPECTOR_CARD_MARGIN, Math.max(INSPECTOR_CARD_MARGIN, maxLeft)),
    top: clampNumber(input.top, INSPECTOR_CARD_MARGIN, Math.max(INSPECTOR_CARD_MARGIN, maxTop)),
    width,
    height
  }
}

/** 默认右上角；放大时铺满工作区边距内。 */
export function defaultInspectorCardRect(input: {
  viewportWidth: number
  viewportHeight: number
  width: number
  height: number
  expanded?: boolean
}): InspectorCardRect {
  if (input.expanded) {
    return clampInspectorCardRect({
      left: INSPECTOR_CARD_MARGIN,
      top: INSPECTOR_CARD_MARGIN,
      width: input.viewportWidth - INSPECTOR_CARD_MARGIN * 2,
      height: input.viewportHeight - INSPECTOR_CARD_MARGIN * 2,
      viewportWidth: input.viewportWidth,
      viewportHeight: input.viewportHeight
    })
  }
  return clampInspectorCardRect({
    left: input.viewportWidth - input.width - INSPECTOR_CARD_MARGIN,
    top: INSPECTOR_CARD_MARGIN,
    width: input.width,
    height: input.height,
    viewportWidth: input.viewportWidth,
    viewportHeight: input.viewportHeight
  })
}

/** 按指针位移移动卡片，并再次夹回工作区。 */
export function moveInspectorCardRect(
  rect: InspectorCardRect,
  deltaX: number,
  deltaY: number,
  viewport: { viewportWidth: number; viewportHeight: number }
): InspectorCardRect {
  return clampInspectorCardRect({
    ...rect,
    left: rect.left + deltaX,
    top: rect.top + deltaY,
    ...viewport
  })
}

/**
 * 只有拖动手柄空白处才能开始拖卡片。
 * 标签、关闭、放大按钮必须继续可点，不能被拖拽抢走。
 */
export function isInspectorCardDragSource(target: unknown): boolean {
  if (!hasClosest(target)) return false
  if (target.closest('button, input, textarea, a, [role="tab"]')) return false
  return Boolean(target.closest('[data-inspector-drag-handle]'))
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function hasClosest(value: unknown): value is { closest: (selector: string) => unknown } {
  return Boolean(value) && typeof (value as { closest?: unknown }).closest === 'function'
}

export interface InspectorTimelineSummary {
  empty: boolean
  turnCount: number
  statusLabel: string
  /** 只读一行缩略，不是计划主副本，不含 entries。 */
  planLine: string | null
  toolCount: number
}

/** Inspector Plan 标签展示的当前计划快照；来源始终是同一份 Timeline reducer 事实。 */
export interface InspectorPlanView {
  entries: AgentPlanEntry[]
  completedCount: number
}

export const INSPECTOR_TABS: readonly InspectorTabDefinition[] = [
  { id: 'timeline', label: '时间线' },
  { id: 'plan', label: '计划' },
  { id: 'changes', label: '变更' },
  { id: 'terminal', label: '终端' },
  { id: 'artifacts', label: '产物' }
]

const INSPECTOR_TAB_IDS = INSPECTOR_TABS.map((tab) => tab.id)

const PERMISSION_AUDIT_REASON_LABELS: Record<AgentPermissionResolutionReason, string> = {
  'auto-allowed': '策略自动允许',
  'grant-reused': '复用当前 Task 授权',
  'user-allowed': '用户允许',
  'user-denied': '用户拒绝',
  cancelled: '请求已取消',
  expired: '审批已过期',
  'invalid-target': '目标无效',
  unsupported: '能力不支持',
  'internal-error': '内部执行失败',
  'takeover-toggled': '任务接管已切换'
}

/** 标题栏按钮文案随开合变化，保持 aria-pressed 与可见 title 一致。 */
export function inspectorToggleLabel(open: boolean): string {
  return open ? '关闭检查器' : '打开检查器'
}

export function toggleInspectorOpen(open: boolean): boolean {
  return !open
}

export function isInspectorTab(value: unknown): value is InspectorTab {
  return typeof value === 'string' && INSPECTOR_TAB_IDS.includes(value as InspectorTab)
}

/** 非法或过期标签一律回到 Timeline，避免抽屉空白。 */
export function resolveInspectorTab(value: unknown): InspectorTab {
  return isInspectorTab(value) ? value : INSPECTOR_DEFAULT_TAB
}

export function nextInspectorTab(current: InspectorTab, delta: -1 | 1): InspectorTab {
  const index = INSPECTOR_TAB_IDS.indexOf(resolveInspectorTab(current))
  const next = (index + delta + INSPECTOR_TAB_IDS.length) % INSPECTOR_TAB_IDS.length
  return INSPECTOR_TAB_IDS[next]
}

/**
 * 未选 Task 或尚未实现标签的诚实占位。
 * Changes 已实现，无 Task 时只提示选择；Terminal 仍只声明 P0-15 用户交互终端。
 */
function inspectorTurnStatusLabel(status: TurnTimelineViewModel['status']): string {
  if (status === 'waiting-permission') return '待审批'
  if (status === 'failed') return '失败'
  if (status === 'cancelled' || status === 'interrupted') return '已停止'
  if (status === 'completed') return '已完成'
  if (status === 'pending') return '等待中'
  return '执行中'
}

function latestPlanLine(turns: readonly TurnTimelineViewModel[]): string | null {
  const plan = latestPlanNode(turns)
  if (!plan || plan.entries.length === 0) return null
  const completed = plan.entries.filter((entry) => entry.status === 'completed').length
  return `计划 · ${completed}/${plan.entries.length}`
}

/** 从最新 Turn 取最后一张 Plan 快照，避免维护第二份会滞后的 plan state。 */
export function latestPlanNode(turns: readonly TurnTimelineViewModel[]): TimelinePlanNode | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const plan = [...turns[index].nodes]
      .reverse()
      .find((node): node is TimelinePlanNode => node.kind === 'plan')
    if (plan) return plan
  }
  return null
}

/** 供 Inspector 直接渲染完整清单，同时把条目复制成只读视图。 */
export function projectInspectorPlan(
  timeline: Pick<TaskTimelineViewModel, 'turns'> | null | undefined,
  focusTurnId?: string | null
): InspectorPlanView | null {
  const turns = timeline?.turns ?? []
  const focusedTurn = focusTurnId ? turns.find((turn) => turn.turnId === focusTurnId) : undefined
  const plan = latestPlanNode(focusedTurn ? [focusedTurn] : turns)
  if (!plan) return null
  const entries = plan.entries.map((entry) => ({ ...entry }))
  return {
    entries,
    completedCount: entries.filter((entry) => entry.status === 'completed').length
  }
}

/**
 * Timeline 标签承载执行摘要与同一份计划快照，方便长对话之外稳定回看；不维护第二份计划状态。
 */
export function projectInspectorTimelineSummary(
  timeline: Pick<TaskTimelineViewModel, 'turns'> | null | undefined
): InspectorTimelineSummary {
  const turns = timeline?.turns ?? []
  if (turns.length === 0) {
    return {
      empty: true,
      turnCount: 0,
      statusLabel: '暂无执行记录',
      planLine: null,
      toolCount: 0
    }
  }
  const latest = turns[turns.length - 1]
  const toolCount = turns.reduce(
    (total, turn) =>
      total +
      turn.nodes.reduce((count, node) => {
        if (node.kind === 'tool') return count + 1
        if (node.kind === 'agent-group') return count + 1 + node.children.length
        return count
      }, 0),
    0
  )
  return {
    empty: false,
    turnCount: turns.length,
    statusLabel: inspectorTurnStatusLabel(latest.status),
    planLine: latestPlanLine(turns),
    toolCount
  }
}

export function inspectorPlaceholderCopy(
  tab: Exclude<InspectorTab, 'timeline'>
): InspectorPlaceholderCopy {
  if (tab === 'plan') {
    return {
      heading: '暂无计划',
      detail: '当前 Task 还没有收到 Runtime 的 Plan 快照。'
    }
  }
  if (tab === 'changes') {
    return {
      heading: '选择一个 Task',
      detail: '选中 Task 后可审阅 Git 基线、文件变更和受限 Diff。'
    }
  }
  if (tab === 'terminal') {
    return {
      heading: '尚未实现 · P0-15 用户交互终端',
      detail: '这里将接入用户可输入的 Task 终端，不是命令证据查看器。'
    }
  }
  return {
    heading: '选择一个 Task',
    detail: '选中 Task 后可审阅文本、Markdown、图片和 Diff 产物。'
  }
}

export function permissionAuditReasonLabel(reason: AgentPermissionResolutionReason): string {
  return PERMISSION_AUDIT_REASON_LABELS[reason]
}

export function permissionAuditScopeLabel(scope: PermissionAuditRecord['scope']): string {
  if (scope === 'task') return '当前 Task'
  if (scope === 'once') return '仅本次'
  return '未授予范围'
}

export function permissionAuditInitiatorLabel(audit: {
  initiator: PermissionAuditRecord['initiator']
  runtimeId?: AgentRuntimeId
  appService?: PermissionAuditRecord['appService']
}): string {
  if (audit.initiator === 'runtime') {
    if (audit.runtimeId === 'grok') return 'Grok Build'
    if (audit.runtimeId === 'codex') return 'Codex'
    return 'Agent Runtime'
  }
  const labels: Record<NonNullable<PermissionAuditRecord['appService']>, string> = {
    'command-runner': 'Command Runner',
    git: 'Git',
    worktree: 'Worktree',
    other: 'Agent Studio'
  }
  return audit.appService ? labels[audit.appService] : 'Agent Studio'
}
