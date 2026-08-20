/** 取出精确选择器块，避免吃到 `.task-row.live` 这类派生规则。 */
export function extractCssRuleBlock(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`))
  return match?.[1] ?? ''
}

/**
 * 行内 ⋯ 菜单是 absolute 且顶出约 32px 行高。
 * 行上任何 overflow 裁剪（含 hidden/auto/scroll/clip，以及只写 overflow-x）都会把菜单剪掉。
 */
export function taskRowOverflowAllowsMenu(source: string): boolean {
  const block = extractCssRuleBlock(source, '.task-row')
  if (!block.trim()) return false
  return !/(?:^|;)\s*overflow(?:-x|-y)?\s*:\s*(hidden|auto|scroll|clip)\b/m.test(block)
}
