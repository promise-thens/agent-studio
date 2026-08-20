import type { AgentPermissionResolutionReason, AgentRuntimeId } from '../../shared/agent'
import type { PermissionAuditRecord } from '../../shared/task-history'
import type {
  TaskTimelineViewModel,
  TimelinePlanNode,
  TimelineToolNode,
  TurnTimelineViewModel
} from './task-timeline-reducer'

/** 检查器顶层标签；后续 P0-12/13/15 只填内容，不改这组 id。 */
export type InspectorTab = 'timeline' | 'changes' | 'terminal' | 'artifacts'

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
/** 主列仍是侧栏+对话两列；检查器 overlay 覆盖右侧，不改栅格。 */
export const WORKSPACE_PRIMARY_COLUMNS = ['sidebar', 'conversation'] as const
export const WORKSPACE_INSPECTOR_PLACEMENT = 'overlay' as const

export interface InspectorTimelineSummary {
  empty: boolean
  turnCount: number
  statusLabel: string
  /** 只读一行缩略，不是计划主副本，不含 entries。 */
  planLine: string | null
  toolCount: number
}

export const INSPECTOR_TABS: readonly InspectorTabDefinition[] = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'changes', label: 'Changes' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'artifacts', label: 'Artifacts' }
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
  'internal-error': '内部执行失败'
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
 * 未实现标签的诚实占位。
 * Terminal 只声明 P0-15 用户交互终端，不把 P0-11 命令证据缺失说成终端没接上。
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
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const plan = [...turns[index].nodes]
      .reverse()
      .find((node): node is TimelinePlanNode => node.kind === 'plan')
    if (!plan || plan.entries.length === 0) continue
    const completed = plan.entries.filter((entry) => entry.status === 'completed').length
    return `计划 · ${completed}/${plan.entries.length}`
  }
  return null
}

/**
 * Timeline 标签只给只读摘要，方便 P0-12/13/15 挂内容；计划条目仍只活在主列。
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
      total + turn.nodes.filter((node): node is TimelineToolNode => node.kind === 'tool').length,
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
  if (tab === 'changes') {
    return {
      heading: '尚未实现 · P0-12 Git Review',
      detail: '项目变更审阅将挂在这个标签，不会再改顶层导航。'
    }
  }
  if (tab === 'terminal') {
    return {
      heading: '尚未实现 · P0-15 用户交互终端',
      detail: '这里将接入用户可输入的 Task 终端，不是命令证据查看器。'
    }
  }
  return {
    heading: '尚未实现 · P0-13',
    detail: 'Task Artifact 将挂在这个标签，不会再改顶层导航。'
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
