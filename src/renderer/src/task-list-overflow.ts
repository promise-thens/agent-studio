/** 取出精确选择器块，避免吃到 `.task-row.live` 这类派生规则。 */
export function extractCssRuleBlock(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`))
  return match?.[1] ?? ''
}

/**
 * 行内 ⋯ 菜单会顶出约 32px 行高。
 * 行上任何 overflow 裁剪（含 hidden/auto/scroll/clip，以及只写 overflow-x）都会把菜单剪掉。
 */
export function taskRowOverflowAllowsMenu(source: string): boolean {
  const block = extractCssRuleBlock(source, '.task-row')
  if (!block.trim()) return false
  return !/(?:^|;)\s*overflow(?:-x|-y)?\s*:\s*(hidden|auto|scroll|clip)\b/m.test(block)
}

/** 列表自身有 overflow-y:auto，菜单必须脱离行文档流，否则会被后一行和滚动容器裁掉。 */
export function taskMenuEscapesListOverflow(source: string): boolean {
  const block = extractCssRuleBlock(source, '.task-menu')
  return /(?:^|;)\s*position\s*:\s*fixed\b/m.test(block)
}

export interface TaskMenuAnchorRect {
  top: number
  left: number
  right: number
  bottom: number
}

export interface TaskMenuViewport {
  width: number
  height: number
}

export type TaskMenuPlacement = 'left' | 'right'

/**
 * 优先在 ⋯ 右侧弹出，盖到对话列而不是标题。
 * 右侧不够再翻到左侧；垂直贴按钮顶，并夹在视口内。
 */
export function resolveTaskMenuPosition(
  button: TaskMenuAnchorRect,
  menu: { width: number; height: number },
  viewport: TaskMenuViewport,
  gap = 6
): { top: number; left: number; placement: TaskMenuPlacement } {
  const margin = 8
  const fitsRight = button.right + gap + menu.width <= viewport.width - margin
  const placement: TaskMenuPlacement = fitsRight ? 'right' : 'left'
  const unclampedLeft = placement === 'right' ? button.right + gap : button.left - gap - menu.width
  const maxLeft = Math.max(margin, viewport.width - menu.width - margin)
  const maxTop = Math.max(margin, viewport.height - menu.height - margin)
  return {
    placement,
    top: Math.min(Math.max(margin, button.top), maxTop),
    left: Math.min(Math.max(margin, unclampedLeft), maxLeft)
  }
}

/**
 * 点菜单内部或当前已展开的 ⋯ 不关。
 * 后者交给 click toggle，避免 pointerdown 先关、click 又打开。
 */
export function shouldCloseTaskMenuOnPointerDown(input: {
  open: boolean
  insideMenu: boolean
  onExpandedMenuButton: boolean
}): boolean {
  if (!input.open) return false
  if (input.insideMenu) return false
  if (input.onExpandedMenuButton) return false
  return true
}
