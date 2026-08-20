import { extractCssRuleBlock } from './task-list-overflow'

export interface WorkbenchWalkthroughFacts {
  titlebarHeight: string
  workspaceColumns: string
  conversationMaxWidth: string
  toolLooksLikeLog: boolean
  hasContinueTask: boolean
  historyAllowsTyping: boolean
  stopReachableWhileExecuting: boolean
  permissionBlocksConversation: boolean
  subagentMountedWithoutParent: boolean
  twoSubagentsShareTools: boolean
  enterSendsWithImeGuard: boolean
}

/**
 * 用源码和投影夹具对照大修前后的信息架构。
 * 不把「换了圆角」当成完成；也不假装跑过 Electron GUI。
 */
export function collectWorkbenchWalkthroughFacts(input: {
  baseCss: string
  mainCss: string
  conversationTurnSource: string
  toolRowSource: string
  permissionSource: string
  composerSource: string
  blocks: readonly { kind: string; label?: string }[]
  historyCanSend: boolean
  permissionPresentation: { variant: string; role: string }
  subagentOwnership: { sharedToolNodeIds: readonly string[] }
}): WorkbenchWalkthroughFacts {
  const joinedUi = [
    input.conversationTurnSource,
    input.toolRowSource,
    input.permissionSource,
    input.composerSource
  ].join('\n')
  const toolLabels = input.blocks
    .map((block) => ('label' in block && typeof block.label === 'string' ? block.label : ''))
    .join('\n')

  return {
    titlebarHeight: readCssValue(input.baseCss, '--titlebar-height'),
    workspaceColumns: normalizeColumns(
      readCssValue(extractCssRuleBlock(input.mainCss, '.workspace-layout'), 'grid-template-columns')
    ),
    conversationMaxWidth: readMinWidthPx(extractCssRuleBlock(input.mainCss, '.conversation-turn')),
    toolLooksLikeLog: looksLikeToolLog(input.toolRowSource, toolLabels),
    hasContinueTask: joinedUi.includes('继续任务'),
    historyAllowsTyping: input.historyCanSend,
    stopReachableWhileExecuting:
      input.composerSource.includes('stop-button') && input.composerSource.includes('focusStop'),
    permissionBlocksConversation:
      input.permissionPresentation.role === 'dialog' ||
      input.permissionPresentation.variant === 'modal' ||
      /role="dialog"/.test(input.permissionSource),
    subagentMountedWithoutParent: input.blocks.some((block) => block.kind === 'subagent'),
    twoSubagentsShareTools: input.subagentOwnership.sharedToolNodeIds.length > 0,
    enterSendsWithImeGuard:
      input.composerSource.includes('isComposing') && input.composerSource.includes('229')
  }
}

function readCssValue(source: string, property: string): string {
  const match = source.match(new RegExp(`${property}\\s*:\\s*([^;]+);`))
  return match?.[1].trim() ?? ''
}

function normalizeColumns(value: string): string {
  return value.replace(/minmax\(\s*0\s*,\s*1fr\s*\)/g, '1fr')
}

function readMinWidthPx(block: string): string {
  const match = block.match(/min\(\s*100%\s*,\s*(\d+px)\s*\)/)
  return match?.[1] ?? ''
}

function looksLikeToolLog(toolRowSource: string, toolLabels: string): boolean {
  if (!toolRowSource.includes('▸')) return true
  if (/Tool\s{2,}/.test(toolRowSource)) return true
  if (/(?:^|\n)Tool\s+/.test(toolLabels)) return true
  return /·\s*(?:in_progress|completed|failed)/.test(toolLabels)
}
