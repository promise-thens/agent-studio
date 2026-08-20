import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractCssRuleBlock } from './task-list-overflow'
import { collectPrefersReducedMotionCss } from './workbench-motion'

const sidebarSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'components/ProjectSidebar.vue'),
  'utf8'
)
const taskListSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'components/TaskList.vue'),
  'utf8'
)

describe('侧栏项目平铺', () => {
  it('新建项目在顶栏，项目全部列出且可折叠，不再用下拉切换', () => {
    expect(sidebarSource).toContain('新建项目')
    expect(sidebarSource).toContain('class="project-header"')
    expect(sidebarSource).toContain('class="project-tree"')
    expect(sidebarSource).toContain('resolveProjectAccordionToggle')
    expect(sidebarSource).not.toContain('aria-haspopup="listbox"')
    expect(sidebarSource).not.toContain('选择目录')
  })

  it('插件入口在项目树上方，运行点仍画在任务行', () => {
    const pluginsIndex = sidebarSource.indexOf('aria-label="插件"')
    const treeIndex = sidebarSource.indexOf('class="project-tree"')
    expect(pluginsIndex).toBeGreaterThan(0)
    expect(treeIndex).toBeGreaterThan(pluginsIndex)
    expect(sidebarSource).toContain('title="插件"')
    expect(sidebarSource).toContain(
      `:aria-current="primaryView === 'plugins' ? 'page' : undefined"`
    )
    expect(sidebarSource).toContain("emit('openPlugins')")
    const pluginsButton = sidebarSource.match(/class="plugins-nav"[\s\S]*?<\/button>/)?.[0] ?? ''
    expect(pluginsButton).toContain('aria-label="插件"')
    expect(pluginsButton).not.toContain('run-count')
  })

  it('新对话仍是可点按钮，当前项目头保留 project-current 给 e2e', () => {
    expect(sidebarSource).toContain('aria-label="新对话"')
    expect(sidebarSource).toContain("'project-current'")
  })

  it('项目行用文件夹图标分层，⋯ 菜单能打开目录', () => {
    expect(sidebarSource).toContain('PhFolder')
    expect(sidebarSource).toContain('打开文件夹')
    expect(sidebarSource).toContain('openProjectFolder')
  })

  it('展开项目按内容长高，不把后续项目顶到侧栏底部', () => {
    const expanded = extractCssRuleBlock(sidebarSource, '.project-block.is-expanded')
    expect(expanded).toMatch(/flex:\s*0\s+1\s+auto/)
    expect(expanded).not.toMatch(/flex:\s*1\s*;/)
    expect(expanded).toMatch(/overflow:\s*hidden/)
  })

  it('折叠项目只占标题行，标题行本身也不收缩', () => {
    expect(extractCssRuleBlock(sidebarSource, '.project-block')).toMatch(/flex:\s*0\s+0\s+auto/)
    expect(extractCssRuleBlock(sidebarSource, '.project-header-row')).toMatch(
      /flex:\s*0\s+0\s+auto/
    )
  })

  it('对话列表按内容长高，父级被压缩时才把滚动交给行列表', () => {
    expect(extractCssRuleBlock(taskListSource, '.task-list')).toMatch(/flex:\s*1\s+1\s+auto/)
  })

  it('点目录只浏览列表，不走 selectProject；对话列表按展开项渲染', () => {
    expect(sidebarSource).toContain('shouldBrowse')
    expect(sidebarSource).toContain("emit('browseProject'")
    expect(sidebarSource).toContain('tasksForExpandedProject')
    expect(sidebarSource).toMatch(/v-if="isExpanded\(project\.projectId\)"/)
    expect(sidebarSource).not.toContain(
      'v-if="isExpanded(project.projectId) && isCurrent(project.projectId)"'
    )
  })

  it('展开目录用高度折叠动画，减少动效时关掉', () => {
    expect(sidebarSource).toContain('name="project-fold"')
    expect(sidebarSource).toMatch(/grid-template-rows:\s*0fr/)
    expect(sidebarSource).toMatch(/grid-template-rows:\s*1fr/)
    expect(sidebarSource).toMatch(/\.project-fold-enter-active[\s\S]*transition:/)
    const reduced = collectPrefersReducedMotionCss(sidebarSource)
    expect(reduced).toMatch(/\.project-fold-enter-active[\s\S]*transition:\s*none/)
  })
})
