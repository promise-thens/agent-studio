import { extractCssRuleBlock } from './task-list-overflow'

export interface SubagentSkinDensity {
  sharedFontSizePx: number | null
  sharedRadiusPx: number | null
  toolIndentPx: number | null
  failedUsesDanger: boolean
}

/** 收集全部 prefers-reduced-motion 块，避免只断言到 stream-caret 那一段。 */
export function collectPrefersReducedMotionCss(source: string): string {
  const marker = '@media (prefers-reduced-motion: reduce)'
  const blocks: string[] = []
  let from = 0
  while (from < source.length) {
    const start = source.indexOf(marker, from)
    if (start < 0) break
    const brace = source.indexOf('{', start)
    if (brace < 0) break
    let depth = 0
    let end = brace
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1
      else if (source[end] === '}') {
        depth -= 1
        if (depth === 0) {
          blocks.push(source.slice(brace + 1, end))
          from = end + 1
          break
        }
      }
    }
    if (depth !== 0) break
  }
  return blocks.join('\n')
}

/**
 * 展开动画必须 duration: 0（检查器 slide、details/子 Agent、spinner 可改静态）。
 * 1ms 的全局兜底不算完成。
 */
export function reducedMotionDisablesExpandAnimations(source: string): boolean {
  const css = collectPrefersReducedMotionCss(source)
  if (!css.trim()) return false
  const hasZeroDuration =
    /animation-duration:\s*0s/.test(css) && /transition-duration:\s*0s/.test(css)
  const inspectorOff = /\.workspace-layout\s*>\s*\.task-inspector[\s\S]*animation:\s*none/.test(css)
  const detailsOff = /\.subagent-summary[\s\S]*transition-duration:\s*0s/.test(css)
  const spinnerOff = /\.conversation-spinner[\s\S]*animation:\s*none/.test(css)
  return hasZeroDuration && inspectorOff && detailsOff && spinnerOff
}

/** 子 Agent 卡必须和计划卡/工具行同一套密度，不能另做更花的皮。 */
export function subagentSkinMatchesToolRowDensity(css: string): SubagentSkinDensity {
  const tool = extractCssRuleBlock(css, '.tool-row')
  const card = extractCssRuleBlock(css, '.subagent-card')
  const summary = extractCssRuleBlock(css, '.subagent-summary')
  const tools = extractCssRuleBlock(css, '.subagent-tools')
  const failed = extractCssRuleBlock(css, ".subagent-card[data-status='failed'] .subagent-status")
  const toolFont = readPx(tool, 'font-size')
  const cardFont = readPx(card, 'font-size')
  const summaryRadius = readPx(summary, 'border-radius')
  return {
    sharedFontSizePx: toolFont !== null && toolFont === cardFont ? toolFont : null,
    sharedRadiusPx: summaryRadius,
    toolIndentPx: readPx(tools, 'padding-left'),
    failedUsesDanger: failed.includes('--danger')
  }
}

function readPx(block: string, property: string): number | null {
  const match = block.match(new RegExp(`${property}\\s*:\\s*(\\d+)px`))
  return match ? Number(match[1]) : null
}
