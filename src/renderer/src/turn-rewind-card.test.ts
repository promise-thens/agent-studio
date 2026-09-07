import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const rendererDir = dirname(fileURLToPath(import.meta.url))
const sharedDir = join(rendererDir, '../../shared')

describe('回退上一轮两行卡源码约束', () => {
  it('Changes 恢复区换成两行卡，对话 checkbox 与文件按钮绑定 disabled', () => {
    const card = readFileSync(join(rendererDir, 'components/TurnRewindCard.vue'), 'utf8')
    const panel = readFileSync(join(rendererDir, 'components/TaskChangesPanel.vue'), 'utf8')
    const changeCard = readFileSync(join(rendererDir, 'components/TaskChangeCard.vue'), 'utf8')
    const app = readFileSync(join(rendererDir, 'App.vue'), 'utf8')
    const inspector = readFileSync(join(rendererDir, 'components/TaskInspector.vue'), 'utf8')
    const pane = readFileSync(join(rendererDir, 'components/InspectorPane.vue'), 'utf8')
    const grid = readFileSync(join(rendererDir, 'components/InspectorPaneGrid.vue'), 'utf8')
    const css = readFileSync(join(rendererDir, 'assets/main.css'), 'utf8')
    const shared = readFileSync(join(sharedDir, 'turn-rewind-preview.ts'), 'utf8')
    const palette = readFileSync(join(rendererDir, 'slash-command-palette.ts'), 'utf8')

    expect(panel).toContain('TurnRewindCard')
    expect(panel).toContain('confirmRestore')
    expect(panel).toContain('openRestorePreview')
    expect(panel).not.toContain('撤销')
    expect(panel).not.toMatch(/startTurn\(/)
    expect(panel).not.toContain('/rewind')
    expect(panel).not.toContain('继续任务')

    expect(card).toContain('type="checkbox"')
    expect(card).toContain('conversationCheckboxDisabled')
    expect(card).toContain('filesButtonDisabled')
    expect(card).toContain('presentTurnRewindCard')
    expect(card).toContain('nextTurnRewindSelection')
    expect(card).not.toMatch(/watch\([\s\S]*selection\.value = defaultTurnRewindSelection/)
    expect(card).toContain('对话回退')
    expect(card).toContain('文件恢复')
    expect(card).toContain('只影响 Grok 上下文，不改磁盘')
    expect(card).toContain('当前会话未提供 rewind')
    expect(card).toContain('title=')
    expect(card).toContain('aria-label')
    expect(card).not.toMatch(/startTurn\(/)
    expect(card).not.toContain('/rewind')
    expect(card).not.toContain('allowUnadvertised')
    expect(card).not.toContain('撤销')

    expect(changeCard).toContain('回退上一轮')
    expect(changeCard).toContain('审核')
    expect(changeCard).not.toContain('撤销')
    expect(changeCard).not.toContain('继续任务')
    expect(changeCard).not.toMatch(/startTurn\(/)

    expect(app).toContain('isTurnRewindBusy')
    expect(app).toContain('runtimeSlashCommands')
    expect(app).toContain(':advertised-commands')
    expect(app).toContain(':rewind-busy')
    expect(app).not.toMatch(/startTurn\([^)]*\/rewind/)
    expect(app).not.toMatch(/startTurn\([^)]*\/undo/)
    expect(app).not.toContain("startTurn(taskId, '/rewind'")
    expect(app).not.toContain('allowUnadvertisedRewind')

    expect(inspector).toContain('advertisedCommands')
    expect(inspector).toContain('rewindBusy')
    expect(grid).toContain('advertisedCommands')
    expect(grid).toContain('rewindBusy')
    expect(pane).toContain('advertised-commands')
    expect(pane).toContain('rewind-busy')

    expect(css).toContain('.turn-rewind-card')
    expect(css).toContain('.turn-rewind-row')

    expect(shared).toContain('name === GROK_REWIND_SLASH_COMMAND')
    expect(shared).toContain('name === GROK_UNDO_SLASH_COMMAND')
    expect(shared).not.toContain('allowUnadvertised')
    expect(shared).not.toMatch(/startTurn\(/)

    expect(palette).not.toContain("name: 'rewind'")
    expect(palette).not.toContain("name: 'undo'")
  })
})
