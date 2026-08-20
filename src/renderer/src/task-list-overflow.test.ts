import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  extractCssRuleBlock,
  resolveTaskMenuPosition,
  shouldCloseTaskMenuOnPointerDown,
  taskMenuEscapesListOverflow,
  taskRowOverflowAllowsMenu
} from './task-list-overflow'

const taskListSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'components/TaskList.vue'),
  'utf8'
)

describe('侧栏任务行溢出契约', () => {
  it('能解析 .task-row 块且不误吃 .task-row.live', () => {
    const block = extractCssRuleBlock(taskListSource, '.task-row')
    expect(block).toContain('position: relative')
    expect(block).not.toContain('border-left-color')
  })

  it('.task-row 不得裁剪溢出，否则绝对定位的 ⋯ 菜单会被剪掉', () => {
    expect(taskRowOverflowAllowsMenu(taskListSource)).toBe(true)
    expect(taskRowOverflowAllowsMenu('.task-row {\n  overflow: hidden;\n}')).toBe(false)
    expect(taskRowOverflowAllowsMenu('.task-row {\n  overflow-x: hidden;\n}')).toBe(false)
    expect(taskRowOverflowAllowsMenu('.task-row {\n  min-width: 0;\n}')).toBe(true)
  })

  it('.task-menu 必须 fixed，避免被后一行和 .task-rows overflow 盖住', () => {
    expect(taskMenuEscapesListOverflow(taskListSource)).toBe(true)
    expect(taskMenuEscapesListOverflow('.task-menu {\n  position: absolute;\n}')).toBe(false)
  })

  it('对话行不再画近距横线，标题悬停也不叠一层 hover-fill', () => {
    expect(taskListSource).not.toContain('class="task-marker"')
    expect(taskListSource).toContain("from '../line-sidebar-proximity'")
    expect(extractCssRuleBlock(taskListSource, '.task-row.selected')).not.toContain(
      '--selected-fill'
    )
    const titleHover = extractCssRuleBlock(taskListSource, '.task-main:not(:disabled):hover')
    expect(titleHover).not.toContain('background:')
    expect(titleHover).not.toContain('--hover-fill')
  })

  it('不写死 Vue Bits 默认紫，也不显示序号', () => {
    expect(taskListSource).not.toContain('#A855F7')
    expect(taskListSource).not.toContain('padStart')
  })

  it('减少动效时关掉标题位移', () => {
    expect(taskListSource).toMatch(/prefers-reduced-motion:\s*reduce/)
    expect(taskListSource).toMatch(/\.task-title[\s\S]*transform:\s*none/)
  })

  it('对话 ⋯ 默认隐藏，悬停或菜单打开才出现', () => {
    expect(extractCssRuleBlock(taskListSource, '.task-menu-button')).toMatch(/opacity:\s*0/)
    expect(taskListSource).toMatch(/\.task-row:hover[\s\S]*\.task-menu-button[\s\S]*opacity:\s*1/)
    expect(taskListSource).toMatch(
      /\.task-row\.menu-open[\s\S]*\.task-menu-button[\s\S]*opacity:\s*1/
    )
  })

  it('长标题只在选中或悬停时单行滚动，减少动效时停住', () => {
    expect(taskListSource).toContain("from '../task-title-marquee'")
    expect(taskListSource).toContain('task-title-track')
    expect(taskListSource).toContain('@keyframes task-title-marquee')
    expect(taskListSource).toMatch(/\.task-row\.selected[\s\S]*task-title-marquee/)
    expect(taskListSource).toMatch(/\.task-row:hover[\s\S]*task-title-marquee/)
    expect(taskListSource).toMatch(
      /prefers-reduced-motion:\s*reduce[\s\S]*\.task-title-track[\s\S]*animation:\s*none/
    )
  })

  it('优先在 ⋯ 右侧弹出，避免盖住标题；右侧不够再翻到左侧', () => {
    expect(
      resolveTaskMenuPosition(
        { top: 80, left: 172, right: 200, bottom: 108 },
        { width: 120, height: 96 },
        { width: 1280, height: 800 }
      )
    ).toEqual({ top: 80, left: 206, placement: 'right' })
    expect(
      resolveTaskMenuPosition(
        { top: 80, left: 1160, right: 1188, bottom: 108 },
        { width: 120, height: 96 },
        { width: 1280, height: 800 }
      )
    ).toEqual({ top: 80, left: 1034, placement: 'left' })
  })

  it('贴按钮顶对齐，到底部时上移夹在视口内', () => {
    expect(
      resolveTaskMenuPosition(
        { top: 740, left: 172, right: 200, bottom: 768 },
        { width: 120, height: 96 },
        { width: 1280, height: 800 }
      )
    ).toEqual({ top: 696, left: 206, placement: 'right' })
  })

  it('点菜单内部或当前 ⋯ 不关，点列表其它地方要关', () => {
    expect(
      shouldCloseTaskMenuOnPointerDown({
        open: true,
        insideMenu: true,
        onExpandedMenuButton: false
      })
    ).toBe(false)
    expect(
      shouldCloseTaskMenuOnPointerDown({
        open: true,
        insideMenu: false,
        onExpandedMenuButton: true
      })
    ).toBe(false)
    expect(
      shouldCloseTaskMenuOnPointerDown({
        open: true,
        insideMenu: false,
        onExpandedMenuButton: false
      })
    ).toBe(true)
    expect(
      shouldCloseTaskMenuOnPointerDown({
        open: false,
        insideMenu: false,
        onExpandedMenuButton: false
      })
    ).toBe(false)
  })

  it('⋯ 菜单从按钮旁弹出并有过渡，减少动效时关掉', () => {
    expect(taskListSource).toContain('<Teleport')
    expect(extractCssRuleBlock(taskListSource, '.task-menu')).toContain('position: fixed')
    expect(taskListSource).toMatch(/transform-origin:\s*top left/)
    expect(taskListSource).toMatch(
      /prefers-reduced-motion:\s*reduce[\s\S]*\.task-menu[\s\S]*transition:\s*none/
    )
  })
})
