import { describe, expect, it } from 'vitest'
import { resolveWorkspaceDrag, resolveWorkspaceWidths } from './workspace-layout'

describe('工作区真实宽度预算', () => {
  it.each([980, 1180, 1440])('窗口 %ipx 扣除侧栏后仍保留发送入口', (width) => {
    const result = resolveWorkspaceWidths(
      { workspaceWidth: width, sidebarWidth: 220, separatorsWidth: 8 },
      9000
    )
    expect(result.chatWidth).toBeGreaterThanOrEqual(380)
    expect(result.browserWidth + result.chatWidth + 228).toBe(width)
  })
  it('先收起 Inspector；仍不足时收起浏览器而非压垮聊天', () => {
    expect(
      resolveWorkspaceWidths({ workspaceWidth: 980, sidebarWidth: 220, inspectorWidth: 360 })
        .collapseInspector
    ).toBe(true)
    const narrow = resolveWorkspaceWidths({ workspaceWidth: 800, sidebarWidth: 220 })
    expect(narrow.collapseBrowser).toBe(true)
    expect(narrow.browserWidth).toBe(0)
    expect(narrow.chatWidth).toBe(580)
  })
  it.each([NaN, Infinity, -2, 0, 'bad', '480oops', null, undefined])(
    '无效缓存 %s 恢复默认后夹紧',
    (cache) => {
      expect(
        resolveWorkspaceWidths({ workspaceWidth: 1440, sidebarWidth: 220 }, cache).browserWidth
      ).toBe(480)
    }
  )
  it('有效缓存和缩窗使用同一夹紧函数', () => {
    expect(
      resolveWorkspaceWidths({ workspaceWidth: 1180, sidebarWidth: 220 }, '9000').browserWidth
    ).toBe(580)
    expect(
      resolveWorkspaceWidths({ workspaceWidth: 980, sidebarWidth: 220 }, 580).browserWidth
    ).toBe(380)
  })
  it('只在显式拖过 48px 阈值时给出专注请求', () => {
    const budget = { workspaceWidth: 980, sidebarWidth: 220 }
    expect(resolveWorkspaceDrag(budget, 427).requestFocus).toBe(false)
    expect(resolveWorkspaceDrag(budget, 428).requestFocus).toBe(true)
    expect(resolveWorkspaceWidths(budget, 9000)).not.toHaveProperty('requestFocus')
  })
  it('非有限容器和负预算不产生越界宽度', () => {
    expect(resolveWorkspaceWidths({ workspaceWidth: NaN }).browserWidth).toBe(0)
    expect(resolveWorkspaceWidths({ workspaceWidth: 100, sidebarWidth: 200 }).chatWidth).toBe(0)
  })
})
