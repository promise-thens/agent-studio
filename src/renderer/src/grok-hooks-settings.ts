import type { GrokHookSummary } from '../../shared/grok-hook'

/** 展示行只消费脱敏 DTO，不得再拼 command / url。 */
export interface GrokHookRowView {
  id: string
  eventLabel: string
  enabledLabel: '已启用' | '未启用'
  targetLabel: string
  warning?: string
}

export const GROK_HOOKS_TITLE = 'Hooks'

/** 桌面是库存表面，不是 Hook 运行时；改文件仍在 App grok-home。 */
export const GROK_HOOKS_INTRO =
  '桌面不执行 Hooks，也不提供命令编辑器。要新增或修改，请编辑 App Grok 主目录里的 hooks 文件；本页只展示脱敏摘要。'

export const GROK_HOOKS_EMPTY_COPY =
  '尚未在 App Grok 主目录配置 Hooks；TUI 家里的 ~/.grok/hooks 不会自动出现'

export const GROK_HOOKS_COMMAND_TARGET_LABEL = '本地命令（已隐藏原文）'

export const GROK_HOOKS_INVALID_TARGET_LABEL = '无效'

export const GROK_HOOKS_ENABLED_LABEL = '已启用' as const

export const GROK_HOOKS_DISABLED_LABEL = '未启用' as const

export const GROK_HOOKS_LOADING_COPY = '正在读取 Hooks…'

export const GROK_HOOKS_ERROR_COPY = '读取 Hooks 失败。'

export const GROK_HOOKS_RETRY_LABEL = '重试读取 Hooks'

/** http 行缺 origin 时的视图警告：不含路径分隔符，也不编造 host。 */
export const GROK_HOOKS_HTTP_MISSING_ORIGIN_WARNING = 'HTTP 目标缺少 origin，无法展示。'

/**
 * 把库存摘要映射成只读展示行。
 * 故意逐字段抄写：即使调用方把 command / url / query 塞进对象，也不能进入 JSON。
 */
export function mapGrokHookSummaryToRowView(summary: GrokHookSummary): GrokHookRowView {
  const missingHttpOrigin = summary.targetKind === 'http' && !summary.httpOrigin
  const invalid = summary.targetKind === 'invalid' || missingHttpOrigin
  const view: GrokHookRowView = {
    id: summary.id,
    eventLabel: summary.event,
    enabledLabel: resolveEnabledLabel(summary, invalid),
    targetLabel: resolveTargetLabel(summary, invalid)
  }
  const warning = resolveWarning(summary, missingHttpOrigin)
  if (warning) view.warning = warning
  return view
}

export function mapGrokHookSummariesToRowViews(
  summaries: readonly GrokHookSummary[]
): GrokHookRowView[] {
  return summaries.map(mapGrokHookSummaryToRowView)
}

/** invalid 行永远显示未启用，避免看起来像可开关。 */
function resolveEnabledLabel(
  summary: GrokHookSummary,
  invalid: boolean
): GrokHookRowView['enabledLabel'] {
  if (invalid) return GROK_HOOKS_DISABLED_LABEL
  return summary.enabled ? GROK_HOOKS_ENABLED_LABEL : GROK_HOOKS_DISABLED_LABEL
}

/**
 * command 永远用固定中文标签，禁止插值命令原文（DTO 里本来就没有）。
 * HTTP 只展示已剥离的 origin；缺 origin 当无效，不编造 host。
 */
function resolveTargetLabel(summary: GrokHookSummary, invalid: boolean): string {
  if (invalid) return GROK_HOOKS_INVALID_TARGET_LABEL
  if (summary.targetKind === 'command') return GROK_HOOKS_COMMAND_TARGET_LABEL
  return summary.httpOrigin ?? GROK_HOOKS_INVALID_TARGET_LABEL
}

function resolveWarning(summary: GrokHookSummary, missingHttpOrigin: boolean): string | undefined {
  if (typeof summary.warning === 'string' && summary.warning.trim()) {
    return summary.warning
  }
  if (missingHttpOrigin) return GROK_HOOKS_HTTP_MISSING_ORIGIN_WARNING
  return undefined
}
