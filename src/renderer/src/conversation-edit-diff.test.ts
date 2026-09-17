import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  conversationEditHunkGap,
  conversationEditLineNumber,
  formatConversationEditHeader,
  presentConversationEditCard
} from './conversation-edit-diff'

describe('conversation-edit-diff', () => {
  it('标题在人话标签里没有路径时补上路径', () => {
    expect(formatConversationEditHeader('写入文件', 'src/auth.ts', 1)).toBe('写入文件 src/auth.ts')
    expect(formatConversationEditHeader('写入 src/auth.ts', 'src/auth.ts', 1)).toBe(
      '写入 src/auth.ts'
    )
  })

  it('删行用旧行号，增行和上下文用新行号', () => {
    expect(conversationEditLineNumber({ kind: 'del', text: 'old', oldLine: 10 })).toBe(10)
    expect(conversationEditLineNumber({ kind: 'add', text: 'new', newLine: 11 })).toBe(11)
    expect(conversationEditLineNumber({ kind: 'ctx', text: 'keep', oldLine: 9, newLine: 9 })).toBe(
      9
    )
  })

  it('相邻 hunk 能算出中间未修改行数', () => {
    expect(
      conversationEditHunkGap(
        [{ kind: 'add', text: 'a', newLine: 2 }],
        [{ kind: 'add', text: 'b', newLine: 8 }]
      )
    ).toBe(5)
  })

  it('卡片视图带 +N/-M 和 hunk 行', () => {
    const view = presentConversationEditCard({
      label: '写入文件',
      status: 'completed',
      edits: [
        {
          path: 'src/auth.ts',
          added: 1,
          deleted: 1,
          hunks: [
            [
              { kind: 'del', text: 'old', oldLine: 1 },
              { kind: 'add', text: 'new', newLine: 1 }
            ]
          ]
        }
      ]
    })

    expect(view.header).toBe('写入文件 src/auth.ts')
    expect(view.added).toBe(1)
    expect(view.deleted).toBe(1)
    expect(view.files[0]?.hunks[0]?.lines).toEqual([
      { kind: 'del', text: 'old', lineNumber: 1 },
      { kind: 'add', text: 'new', lineNumber: 1 }
    ])
  })

  it('ConversationEditDiff 用对话专用标记渲染 hunk', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'components/ConversationEditDiff.vue'),
      'utf8'
    )
    expect(source).toContain('data-kind="edit-diff"')
    expect(source).toContain('conversation-edit-line')
  })

  it('主对话 Turn 对有 hunk 的工具卡走 ConversationEditDiff，而不是普通 ToolRow', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'components/ConversationTurn.vue'),
      'utf8'
    )
    expect(source).toContain('ConversationEditDiff')
    expect(source).toContain('block.editDiffs?.length')
  })
})
