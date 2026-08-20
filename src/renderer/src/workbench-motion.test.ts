import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractCssRuleBlock } from './task-list-overflow'
import {
  collectPrefersReducedMotionCss,
  reducedMotionDisablesExpandAnimations,
  subagentSkinMatchesToolRowDensity
} from './workbench-motion'

const cssDir = dirname(fileURLToPath(import.meta.url))
const mainCss = readFileSync(join(cssDir, 'assets/main.css'), 'utf8')
const subagentSource = readFileSync(join(cssDir, 'components/SubagentCard.vue'), 'utf8')
const conversationTurnSource = readFileSync(join(cssDir, 'components/ConversationTurn.vue'), 'utf8')

describe('子 Agent 与 ToolRow/计划卡密度', () => {
  it('字号、圆角、工具缩进与计划卡同一套，失败走危险色', () => {
    const density = subagentSkinMatchesToolRowDensity(mainCss)
    expect(extractCssRuleBlock(mainCss, '.tool-row')).toContain('font-size: 12px')
    expect(extractCssRuleBlock(mainCss, '.subagent-card')).toContain('font-size: 12px')
    expect(density.sharedFontSizePx).toBe(12)
    expect(density.sharedRadiusPx).toBe(12)
    expect(density.toolIndentPx).toBe(12)
    expect(density.failedUsesDanger).toBe(true)
    expect(subagentSource).toContain('已运行')
    expect(subagentSource).toContain('点开查看')
    expect(conversationTurnSource).toContain('shouldMountSubagentCard')
  })
})

describe('prefers-reduced-motion 关掉展开动画', () => {
  it('检查器 slide、details 展开、spinner 的 duration 为 0', () => {
    const reduced = collectPrefersReducedMotionCss(mainCss)
    expect(reduced.length).toBeGreaterThan(0)
    expect(reducedMotionDisablesExpandAnimations(mainCss)).toBe(true)
    expect(reduced).toMatch(/animation-duration:\s*0s/)
    expect(reduced).toMatch(/transition-duration:\s*0s/)
    expect(reduced).toMatch(/\.workspace-layout\s*>\s*\.task-inspector[\s\S]*animation:\s*none/)
    expect(reduced).toMatch(/\.subagent-card[\s\S]*transition-duration:\s*0s/)
    expect(reduced).toMatch(/\.conversation-spinner[\s\S]*animation:\s*none/)

    expect(reducedMotionDisablesExpandAnimations('')).toBe(false)
    expect(
      reducedMotionDisablesExpandAnimations(
        '@media (prefers-reduced-motion: reduce) {\n  * { animation-duration: 1ms; }\n}'
      )
    ).toBe(false)
  })
})
