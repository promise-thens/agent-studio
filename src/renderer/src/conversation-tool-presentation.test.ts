import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { presentToolTitle } from './conversation-tool-presentation'

const root = dirname(fileURLToPath(import.meta.url))
const toolRowSource = readFileSync(join(root, 'components/ToolRow.vue'), 'utf8')
const conversationTurnSource = readFileSync(join(root, 'components/ConversationTurn.vue'), 'utf8')
const subagentCardSource = readFileSync(join(root, 'components/SubagentCard.vue'), 'utf8')

describe('工具行标题人话化', () => {
  it('List 带反引号路径时标签是「列目录」，路径进详情', () => {
    expect(presentToolTitle('List `/Users/huyaohang/Documents/agentStudioTest`')).toEqual({
      label: '列目录',
      detail: '/Users/huyaohang/Documents/agentStudioTest'
    })
  })

  it('Execute 长命令只留「跑了命令」，整段命令进详情且不出现在标签里', () => {
    const command =
      'ls -la && (test -f README.md && head -80 README.md; test -f package.json && cat package.json) 2>/dev/null; find . -maxdepth 3 -print | head -80'
    const presented = presentToolTitle(`Execute \`${command}\``)

    expect(presented).toEqual({
      label: '跑了命令',
      detail: command
    })
    expect(presented.label).not.toContain('ls -la')
    expect(presented.label.length).toBeLessThan(12)
  })

  it('Read 反引号路径仍是「读了 文件」，不额外拆详情', () => {
    expect(presentToolTitle('Read `src/auth.ts`')).toEqual({
      label: '读了 src/auth.ts'
    })
  })

  it('已有中文读取标题保持「读了 …」，短写入标题原样', () => {
    expect(presentToolTitle('读取 package.json')).toEqual({
      label: '读了 package.json'
    })
    expect(presentToolTitle('写入 src/auth.ts')).toEqual({
      label: '写入 src/auth.ts'
    })
  })

  it('无动词的长命令或搜索模式收成「工具」并折叠原文', () => {
    expect(presentToolTitle('<title>|<h1|贪吃蛇|Apple|苹果|游戏|canvas|Snake')).toEqual({
      label: '工具',
      detail: '<title>|<h1|贪吃蛇|Apple|苹果|游戏|canvas|Snake'
    })
    expect(presentToolTitle('Vitest')).toEqual({ label: 'Vitest' })
  })

  it('未闭合反引号仍能抽出命令，空载荷只留短标签', () => {
    expect(presentToolTitle('Execute `rg -n foo')).toEqual({
      label: '跑了命令',
      detail: 'rg -n foo'
    })
    expect(presentToolTitle('List')).toEqual({ label: '列目录' })
    expect(presentToolTitle('  Execute  ')).toEqual({ label: '跑了命令' })
  })

  it('中文「列出」「执行」同样收人话标签', () => {
    expect(presentToolTitle('列出 `/tmp/demo`')).toEqual({
      label: '列目录',
      detail: '/tmp/demo'
    })
    expect(presentToolTitle('执行 `rg -n foo`')).toEqual({
      label: '跑了命令',
      detail: 'rg -n foo'
    })
  })
})

describe('工具行折叠皮肤', () => {
  it('有 detail 时用默认折叠的 details，命令不进 summary', () => {
    expect(toolRowSource).toContain('v-else-if="detail"')
    expect(toolRowSource).toContain('tool-row-detail')
    expect(toolRowSource).toMatch(/<details\s+v-else-if="detail"/)
    expect(toolRowSource).not.toMatch(/<details[^>]*v-else-if="detail"[^>]*\sopen/)
    const summaries = [...toolRowSource.matchAll(/<summary>[\s\S]*?<\/summary>/g)].map(
      (match) => match[0]
    )
    expect(summaries.length).toBeGreaterThan(0)
    for (const summary of summaries) {
      expect(summary).toContain('{{ label }}')
      expect(summary).not.toContain('{{ detail }}')
    }
    expect(conversationTurnSource).toContain(':detail="block.detail"')
    expect(subagentCardSource).toContain(':detail="tool.detail"')
  })
})
