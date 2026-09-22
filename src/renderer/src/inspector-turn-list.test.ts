import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { projectInspectorTurns } from './inspector-turn-list'
import type { TurnTimelineViewModel } from './task-timeline-reducer'

const timelinePaneSource = readFileSync(
  new URL('./components/InspectorTimelinePane.vue', import.meta.url),
  'utf8'
)

/** 用只含公开字段的轮次夹具验证 Inspector 不复制或改写执行事实。 */
function turn(overrides: Partial<TurnTimelineViewModel> = {}): TurnTimelineViewModel {
  return {
    taskId: 'task-test',
    turnId: 'turn-test',
    prompt: '检查页面',
    model: { modelId: 'mock-model' },
    status: 'completed',
    statusProvisional: false,
    statusConflict: false,
    createdAt: '2026-09-20T00:00:00.000Z',
    nodes: [],
    usage: { contextSamples: [] },
    historyTruncated: false,
    ...overrides
  }
}

describe('Inspector 轮次导航投影', () => {
  it('空任务无虚构轮次，真实 ID 与提示文字保持一致', () => {
    expect(projectInspectorTurns(null)).toEqual([])
    const source = turn()
    expect(projectInspectorTurns({ turns: [source] })).toEqual([
      {
        turnId: 'turn-test',
        title: '检查页面',
        statusLabel: '已完成',
        active: false,
        tools: []
      }
    ])
    expect(source.prompt).toBe('检查页面')
  })

  it('保留历史顺序和运行状态，不按最后一条强行改变选择', () => {
    const items = projectInspectorTurns({
      turns: [
        turn({ turnId: 'older', prompt: '' }),
        turn({ turnId: 'active', status: 'waiting-permission' })
      ]
    })
    expect(items.map((item) => item.turnId)).toEqual(['older', 'active'])
    expect(items[0].title).toBe('第 1 轮')
    expect(items[1]).toMatchObject({ active: true, statusLabel: '待审批' })
  })

  it('结构化子工具纳入当前轮，普通文本不会被猜成工具', () => {
    const source = turn({
      nodes: [
        {
          nodeId: 'message',
          taskId: 'task-test',
          turnId: 'turn-test',
          source: 'agent-event',
          kind: 'message',
          text: '执行任务'
        },
        {
          nodeId: 'group',
          taskId: 'task-test',
          turnId: 'turn-test',
          source: 'agent-event',
          kind: 'agent-group',
          toolCallId: 'group-tool',
          title: '检查',
          status: 'completed',
          children: [
            {
              nodeId: 'child',
              taskId: 'task-test',
              turnId: 'turn-test',
              source: 'agent-event',
              kind: 'tool',
              toolCallId: 'child-tool',
              title: '读取文件',
              status: 'completed'
            }
          ]
        }
      ]
    })
    expect(projectInspectorTurns({ turns: [source] })[0].tools.map((tool) => tool.nodeId)).toEqual([
      'group',
      'child'
    ])
  })

  it('重复定位会先展开用户收起的工具组，再聚焦并滚动目标节点', () => {
    const openDetails = timelinePaneSource.indexOf('details.open = true')
    const focusTarget = timelinePaneSource.indexOf('target.focus({ preventScroll: true })')
    const scrollTarget = timelinePaneSource.indexOf(
      "target.scrollIntoView({ block: 'center', behavior: 'instant' })"
    )

    expect(timelinePaneSource).toContain(
      "target.closest<HTMLDetailsElement>('details.inspector-turn-tools')"
    )
    expect(openDetails).toBeGreaterThan(-1)
    expect(focusTarget).toBeGreaterThan(openDetails)
    expect(scrollTarget).toBeGreaterThan(focusTarget)
  })
})
