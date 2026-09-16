import { describe, expect, it } from 'vitest'
import type {
  ConversationBlock,
  ConversationThoughtBlock,
  ConversationToolBlock,
  ConversationUserBlock,
  ConversationMessageBlock
} from './conversation-turn-view'
import {
  extractCapsuleActionVerb,
  groupConversationBlocks,
  isCapsuleProcessBlock,
  type ConversationActivityCapsuleBlock
} from './conversation-activity-capsule'

function makeToolBlock(
  id: string,
  label: string,
  status: ConversationToolBlock['status'] = 'completed',
  mergedReadCount?: number
): ConversationToolBlock {
  return {
    kind: 'tool',
    nodeId: `tool-${id}`,
    label,
    status,
    tools: [],
    ...(mergedReadCount ? { mergedReadCount } : {})
  }
}

function makeThoughtBlock(id: string, text = '考虑实现方案'): ConversationThoughtBlock {
  return {
    kind: 'thought',
    nodeId: `thought-${id}`,
    text,
    defaultCollapsed: true,
    summary: '思考过程'
  }
}

describe('conversation-activity-capsule 聚合逻辑', () => {
  it('识别过程节点与非过程节点', () => {
    expect(isCapsuleProcessBlock(makeToolBlock('1', '点击页面'))).toBe(true)
    expect(isCapsuleProcessBlock(makeThoughtBlock('1'))).toBe(true)
    expect(
      isCapsuleProcessBlock({
        kind: 'user',
        nodeId: 'user-1',
        text: '你好'
      } as ConversationUserBlock)
    ).toBe(false)
    expect(
      isCapsuleProcessBlock({
        kind: 'message',
        nodeId: 'msg-1',
        text: '结果如下',
        render: 'markdown'
      } as ConversationMessageBlock)
    ).toBe(false)
  })

  it('连续的过程节点自动合并为一个胶囊块，正文消息保持独立', () => {
    const blocks: ConversationBlock[] = [
      { kind: 'user', nodeId: 'u1', text: '查询表格' },
      makeToolBlock('1', '点击页面'),
      makeToolBlock('2', '页面快照'),
      makeThoughtBlock('1'),
      makeToolBlock('3', '搜索 "表单"'),
      { kind: 'message', nodeId: 'm1', text: '找到表单了', render: 'markdown' },
      makeToolBlock('4', '跑了命令'),
      { kind: 'message', nodeId: 'm2', text: '处理完成', render: 'markdown' }
    ]

    const grouped = groupConversationBlocks(blocks)

    // 应为：user -> capsule 1 -> message 1 -> capsule 2 -> message 2
    expect(grouped).toHaveLength(5)
    expect(grouped[0].kind).toBe('user')
    expect(grouped[1].kind).toBe('activity-capsule')
    expect(grouped[2].kind).toBe('message')
    expect(grouped[3].kind).toBe('activity-capsule')
    expect(grouped[4].kind).toBe('message')

    const firstCapsule = grouped[1] as ConversationActivityCapsuleBlock
    expect(firstCapsule.items).toHaveLength(4)
    expect(firstCapsule.totalCount).toBe(4)
    expect(firstCapsule.actionsSummary).toContain('点击页面')
    expect(firstCapsule.actionsSummary).toContain('页面快照')
    expect(firstCapsule.actionsSummary).toContain('思考')
    expect(firstCapsule.actionsSummary).toContain('搜索')
    expect(firstCapsule.summary).toContain('已执行 4 项操作')
    expect(firstCapsule.status).toBe('completed')
  })

  it('正确累计合并读取的文件数量', () => {
    const blocks: ConversationBlock[] = [
      makeToolBlock('read', '读了 5 个文件', 'completed', 5),
      makeToolBlock('click', '点击页面')
    ]

    const grouped = groupConversationBlocks(blocks)
    expect(grouped).toHaveLength(1)
    const capsule = grouped[0] as ConversationActivityCapsuleBlock
    expect(capsule.totalCount).toBe(6) // 5 + 1
    expect(capsule.summary).toContain('已执行 6 项操作')
  })

  it('失败状态优先生效', () => {
    const blocks: ConversationBlock[] = [
      makeToolBlock('1', '点击页面', 'completed'),
      makeToolBlock('2', '页面截图', 'failed'),
      makeToolBlock('3', '搜索', 'completed')
    ]

    const grouped = groupConversationBlocks(blocks)
    const capsule = grouped[0] as ConversationActivityCapsuleBlock
    expect(capsule.status).toBe('failed')
  })

  it('活跃轮次在末尾过程节点判定为 in_progress 并输出正在操作提示', () => {
    const blocks: ConversationBlock[] = [
      makeToolBlock('1', '点击页面', 'completed'),
      makeToolBlock('2', '打开网页', 'completed')
    ]

    const grouped = groupConversationBlocks(blocks, { isTurnActive: true })
    const capsule = grouped[0] as ConversationActivityCapsuleBlock
    expect(capsule.status).toBe('in_progress')
    expect(capsule.activeStepLabel).toBe('正在操作 · 打开网页')
  })

  it('核心动词提取人话化', () => {
    expect(extractCapsuleActionVerb(makeThoughtBlock('1'))).toBe('思考')
    expect(extractCapsuleActionVerb(makeToolBlock('1', '点击页面'))).toBe('点击页面')
    expect(extractCapsuleActionVerb(makeToolBlock('2', '页面快照'))).toBe('页面快照')
    expect(extractCapsuleActionVerb(makeToolBlock('3', '页面截图'))).toBe('页面截图')
    expect(extractCapsuleActionVerb(makeToolBlock('4', '读了 package.json'))).toBe('读取文件')
    expect(extractCapsuleActionVerb(makeToolBlock('5', '写入 config.json'))).toBe('修改文件')
    expect(extractCapsuleActionVerb(makeToolBlock('6', '搜索 "token"'))).toBe('搜索')
  })
})
