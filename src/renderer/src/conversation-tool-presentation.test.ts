import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SUBAGENT_STOP_COPY } from './conversation-subagent-view'
import { presentToolTitle, resolveToolRowChrome } from './conversation-tool-presentation'

const root = dirname(fileURLToPath(import.meta.url))
const toolRowSource = readFileSync(join(root, 'components/ToolRow.vue'), 'utf8')
const conversationTurnSource = readFileSync(join(root, 'components/ConversationTurn.vue'), 'utf8')
const subagentCardSource = readFileSync(join(root, 'components/SubagentCard.vue'), 'utf8')
const appSource = readFileSync(join(root, 'App.vue'), 'utf8')
const composerSource = readFileSync(join(root, 'components/TaskComposer.vue'), 'utf8')
const permissionPromptSource = readFileSync(join(root, 'components/PermissionPrompt.vue'), 'utf8')
const composerActionsSource = readFileSync(join(root, 'task-composer-actions.ts'), 'utf8')

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
    expect(conversationTurnSource).toContain(':warning="block.warning"')
    expect(subagentCardSource).toContain(':detail="tool.detail"')
  })

  it('当前 Turn 事件默认完整展示，不再提供手动加载按钮', () => {
    expect(conversationTurnSource).not.toContain('加载本轮更多事件')
  })

  it('折叠态 summary/line 可见后台徽章，无 execution 时不得渲染该字', () => {
    expect(toolRowSource).toContain("execution?: 'background'")
    expect(toolRowSource).toContain('data-execution')
    expect(toolRowSource).toContain('tool-row-execution')
    expect(toolRowSource).toMatch(/v-if="isBackground"/)
    expect(toolRowSource).toContain('后台')
    expect(conversationTurnSource).toContain(':execution="block.execution"')
    expect(subagentCardSource).toContain(':execution="tool.execution"')

    const summaries = [...toolRowSource.matchAll(/<summary>[\s\S]*?<\/summary>/g)].map(
      (match) => match[0]
    )
    expect(summaries.length).toBeGreaterThan(0)
    for (const summary of summaries) {
      expect(summary).toContain('tool-row-execution')
      expect(summary).toContain('后台')
      expect(summary).toContain('tool-row-status')
    }
    const line = toolRowSource.match(/<div v-else class="tool-row-line">[\s\S]*?<\/div>/)?.[0]
    expect(line).toContain('tool-row-execution')
    expect(line).toContain('后台')
    expect(line).toContain('tool-row-status')
  })

  it('进行中保留 spinner 与「进行中」，徽章只跟在明确 background 之后', () => {
    expect(toolRowSource).toContain('conversation-spinner')
    expect(toolRowSource).toContain('resolveToolRowChrome')
    expect(toolRowSource).toMatch(/accessibleLabel[\s\S]*后台/)
    expect(toolRowSource).not.toMatch(/status === 'in_progress'[\s\S]{0,80}后台/)
  })
})

describe('折叠 ToolRow 后台走查', () => {
  it('execution=background 且 in_progress 时可见「后台」+「进行中」', () => {
    const chrome = resolveToolRowChrome({ status: 'in_progress', execution: 'background' })
    expect(chrome).toMatchObject({
      busy: true,
      isBackground: true,
      statusLabel: '进行中'
    })
    expect(chrome.visibleLabels).toEqual(['后台', '进行中'])
  })

  it('取消后「后台」可保留，状态不是「进行中」', () => {
    const chrome = resolveToolRowChrome({ status: 'cancelled', execution: 'background' })
    expect(chrome).toMatchObject({
      busy: false,
      isBackground: true,
      statusLabel: '已取消'
    })
    expect(chrome.visibleLabels).toEqual(['后台', '已取消'])
    expect(chrome.visibleLabels).not.toContain('进行中')
  })

  it('无 execution 的普通工具没有「后台」', () => {
    const chrome = resolveToolRowChrome({ status: 'in_progress' })
    expect(chrome.isBackground).toBe(false)
    expect(chrome.visibleLabels).toEqual(['进行中'])
    expect(chrome.visibleLabels).not.toContain('后台')
    expect(JSON.stringify(chrome)).not.toContain('foreground')
  })
})

describe('停止仍走整场 Turn，不碰用户 PTY', () => {
  it('Composer / 工作台停止调用 window.agent.cancelTurn，源码不含 PTY 或轮询', () => {
    expect(appSource).toContain('window.agent.cancelTurn')
    expect(appSource).toContain('@stop="cancelTurn"')
    expect(appSource).toContain('@cancel-turn="cancelTurn"')
    expect(composerSource).toContain("emit('stop')")
    expect(composerSource).toContain('data-composer-stop')
    expect(permissionPromptSource).toContain("emit('cancelTurn')")
    expect(composerActionsSource).toContain('export function resolveCancelTurnRequest')

    for (const source of [
      appSource,
      composerSource,
      permissionPromptSource,
      composerActionsSource,
      toolRowSource
    ]) {
      expect(source).not.toContain('get_command_or_subagent_output')
      expect(source).not.toContain('agent:kill-background')
      expect(source).not.toMatch(/Ctrl\+C/)
      expect(source).not.toContain('\\x03')
    }
  })

  it('没有「停这一条后台命令」按钮，SUBAGENT_STOP_COPY 仍是整场 Turn', () => {
    expect(SUBAGENT_STOP_COPY).toBe('停止会结束整场 Turn，不能只停这张卡。')
    expect(subagentCardSource).toContain('SUBAGENT_STOP_COPY')
    expect(toolRowSource).not.toContain('停这一条')
    expect(toolRowSource).not.toContain('kill-background')
    expect(composerSource).not.toContain('停这一条后台')
    expect(appSource).not.toContain('停这一条后台')
  })
})
