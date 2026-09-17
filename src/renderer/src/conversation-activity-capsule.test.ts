import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ConversationBlock,
  ConversationPermissionAuditBlock,
  ConversationPlanBlock,
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

function makeAuditBlock(id: string, summary: string): ConversationPermissionAuditBlock {
  return {
    kind: 'permission-audit',
    nodeId: `audit-${id}`,
    summary,
    count: 1
  }
}

function makePlanBlock(): ConversationPlanBlock {
  return {
    kind: 'plan',
    nodeId: 'plan-1',
    entries: [{ content: '补测试', status: 'pending', priority: 'medium' }],
    defaultExpanded: true,
    summary: '计划',
    completedCount: 0
  }
}

describe('conversation-activity-capsule 聚合逻辑', () => {
  it('识别过程节点与非过程节点', () => {
    expect(isCapsuleProcessBlock(makeToolBlock('1', '点击页面'))).toBe(true)
    expect(isCapsuleProcessBlock(makeThoughtBlock('1'))).toBe(true)
    expect(
      isCapsuleProcessBlock({
        ...makeToolBlock('edit', '写入 src/auth.ts'),
        editDiffs: [
          {
            path: 'src/auth.ts',
            added: 1,
            deleted: 1,
            hunks: [[{ kind: 'add', text: 'new', newLine: 1 }]]
          }
        ]
      })
    ).toBe(false)
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

  it('带本次编辑 hunk 的工具卡不进胶囊，夹在读取过程中间时把胶囊切开', () => {
    const editBlock: ConversationToolBlock = {
      ...makeToolBlock('edit', '写入 src/auth.ts'),
      editDiffs: [
        {
          path: 'src/auth.ts',
          added: 1,
          deleted: 1,
          hunks: [[{ kind: 'add', text: 'new', newLine: 1 }]]
        }
      ]
    }
    const grouped = groupConversationBlocks([
      makeThoughtBlock('1'),
      makeToolBlock('read', '读了 src/auth.ts', 'completed', 1),
      editBlock,
      makeToolBlock('read-2', '读了 src/main.ts', 'completed', 1)
    ])

    expect(grouped.map((block) => block.kind)).toEqual([
      'activity-capsule',
      'tool',
      'activity-capsule'
    ])
    expect(grouped[1]).toMatchObject({ kind: 'tool', nodeId: 'tool-edit' })
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

    const grouped = groupConversationBlocks(blocks, { isTurnActive: true, turnStatus: 'running' })
    const capsule = grouped[0] as ConversationActivityCapsuleBlock
    expect(capsule.status).toBe('in_progress')
    expect(capsule.activeStepLabel).toBe('正在操作 · 打开网页')
  })

  it('停止中或已取消时，末尾胶囊不得再显示进行中', () => {
    const completedTools: ConversationBlock[] = [
      makeToolBlock('1', '点击页面', 'completed'),
      makeToolBlock('2', '打开网页', 'completed')
    ]
    const leftoverRunning: ConversationBlock[] = [
      makeToolBlock('1', '点击页面', 'completed'),
      makeToolBlock('2', 'Get task output: abc', 'in_progress'),
      makeAuditBlock('1', '已自动允许 4 次未知操作')
    ]

    const cancelling = groupConversationBlocks(completedTools, {
      isTurnActive: true,
      turnStatus: 'cancelling'
    })[0] as ConversationActivityCapsuleBlock
    const cancelled = groupConversationBlocks(leftoverRunning, {
      isTurnActive: false,
      turnStatus: 'cancelled'
    })[0] as ConversationActivityCapsuleBlock

    expect(cancelling.status).toBe('cancelled')
    expect(cancelling.activeStepLabel).toBeUndefined()
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.activeStepLabel).toBeUndefined()
  })

  it('末尾只剩静默授权或计划后的审计时，不得把胶囊钉在进行中', () => {
    const auditTail = groupConversationBlocks(
      [
        makeToolBlock('1', '打开网页', 'completed'),
        makeAuditBlock('1', '已自动允许 4 次未知操作'),
        makeAuditBlock('2', '已自动允许 3 次浏览器')
      ],
      { isTurnActive: true, turnStatus: 'running' }
    )[0] as ConversationActivityCapsuleBlock

    const afterPlan = groupConversationBlocks(
      [
        makeToolBlock('1', '打开网页', 'completed'),
        makePlanBlock(),
        makeAuditBlock('1', '已自动允许 3 次浏览器')
      ],
      { isTurnActive: true, turnStatus: 'running' }
    )

    expect(auditTail.status).toBe('completed')
    expect(auditTail.activeStepLabel).toBeUndefined()
    expect(afterPlan.map((block) => block.kind)).toEqual([
      'activity-capsule',
      'plan',
      'activity-capsule'
    ])
    const lastCapsule = afterPlan[2] as ConversationActivityCapsuleBlock
    expect(lastCapsule.status).toBe('completed')
    expect(lastCapsule.activeStepLabel).toBeUndefined()
  })

  it('等待确认时已完成的过程胶囊收成完成态，真实还在跑的工具除外', () => {
    const waiting = groupConversationBlocks(
      [makeToolBlock('1', '打开网页', 'completed'), makeAuditBlock('1', '已自动允许 1 次读取')],
      { isTurnActive: true, turnStatus: 'waiting-permission', waitingForUser: true }
    )[0] as ConversationActivityCapsuleBlock
    const stillRunning = groupConversationBlocks([makeToolBlock('1', '打开网页', 'in_progress')], {
      isTurnActive: true,
      turnStatus: 'running'
    })[0] as ConversationActivityCapsuleBlock
    const runningWithAudit = groupConversationBlocks(
      [
        makeToolBlock('1', 'Get task output: abc', 'in_progress'),
        makeAuditBlock('1', '已自动允许 4 次未知操作')
      ],
      { isTurnActive: true, turnStatus: 'running' }
    )[0] as ConversationActivityCapsuleBlock

    expect(waiting.status).toBe('completed')
    expect(stillRunning.status).toBe('in_progress')
    expect(stillRunning.activeStepLabel).toBe('正在操作 · 打开网页')
    expect(runningWithAudit.status).toBe('in_progress')
    expect(runningWithAudit.activeStepLabel).toBe('正在操作 · Get task output: abc')
  })

  it('ConversationTurn 把 Turn 状态和等待用户传给胶囊聚合', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'components/ConversationTurn.vue'),
      'utf8'
    )
    expect(source).toContain('turnStatus: props.turn.status')
    expect(source).toContain('waitingForUser:')
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
