import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractCssRuleBlock, taskRowOverflowAllowsMenu } from './task-list-overflow'

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
})
