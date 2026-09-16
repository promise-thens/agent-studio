/**
 * 对话流执行过程胶囊卡片（Activity Capsule）模型与聚合算法。
 * 负责将主对话流中连续密集的思考、工具调用与静默审计聚合成现代优雅的紧凑胶囊，
 * 彻底消除垂直糖葫芦串与重复刷屏的“已完成”标签。
 */

import type {
  ConversationBlock,
  ConversationPermissionAuditBlock,
  ConversationThoughtBlock,
  ConversationToolBlock
} from './conversation-turn-view'

/** 胶囊内部容纳的中间过程项类型 */
export type CapsuleInnerBlock =
  ConversationThoughtBlock | ConversationToolBlock | ConversationPermissionAuditBlock

/** 胶囊生命周期状态 */
export type CapsuleStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

/** 聚合后的胶囊卡片渲染块 */
export interface ConversationActivityCapsuleBlock {
  kind: 'activity-capsule'
  /** 稳定 ID，由内部首尾节点的 ID 派生，确保在 Vue 渲染流中稳定追踪 */
  nodeId: string
  /** 胶囊综合执行状态 */
  status: CapsuleStatus
  /** 胶囊内包含的所有具体步骤节点 */
  items: CapsuleInnerBlock[]
  /** 综合摘要文案，例如："已执行 6 项操作（点击页面、页面快照、搜索）" */
  summary: string
  /** 进行中态的实时动作短文案，例如："正在操作 · 点击页面..." */
  activeStepLabel?: string
  /** 耗时文案，例如："3s" */
  durationLabel?: string
  /** 提取并去重后的核心操作动作列表，例如：["点击页面", "页面快照", "搜索"] */
  actionsSummary: string[]
  /** 实际发生的操作总次数（包含合并读取的文件数） */
  totalCount: number
}

/** 提供给视图层最终渲染的块联合类型 */
export type GroupedConversationBlock =
  Exclude<ConversationBlock, CapsuleInnerBlock> | ConversationActivityCapsuleBlock

/**
 * 判断是否属于应当收入胶囊的中间执行过程节点。
 * 包含思考、工具执行、静默权限审计等过程节点；正文消息、计划看板、独立子任务与审批卡保持顶级展现。
 */
export function isCapsuleProcessBlock(block: ConversationBlock): block is CapsuleInnerBlock {
  return block.kind === 'thought' || block.kind === 'tool' || block.kind === 'permission-audit'
}

/**
 * 从步骤节点提取短小精悍的核心动词标签。
 */
export function extractCapsuleActionVerb(block: CapsuleInnerBlock): string {
  if (block.kind === 'thought') return '思考'
  if (block.kind === 'permission-audit') return '授权'

  const label = block.label
  if (label.startsWith('读了') || block.mergedReadCount) return '读取文件'
  if (label.startsWith('写入') || label.startsWith('编辑')) return '修改文件'
  if (label.includes('搜索') || label.includes('grep')) return '搜索'
  if (label.includes('列目录') || label.includes('list')) return '列目录'
  if (label.includes('跑了命令') || label.includes('执行')) return '跑了命令'
  if (label.includes('点击') || label.includes('click')) return '点击页面'
  if (label.includes('快照') || label.includes('snapshot')) return '页面快照'
  if (label.includes('截图') || label.includes('screenshot')) return '页面截图'
  if (label.includes('网页') || label.includes('navigate')) return '打开网页'

  return label.length > 6 ? label.slice(0, 6) : label
}

/**
 * 将连续相邻的中间执行过程节点打包聚合成一个 Activity Capsule 胶囊卡片。
 * 保持原有 user、message、plan、subagent、permission 等核心业务块的顺序与独立性。
 */
export function groupConversationBlocks(
  blocks: readonly ConversationBlock[],
  options?: { isTurnActive?: boolean; clockTick?: number }
): GroupedConversationBlock[] {
  const result: GroupedConversationBlock[] = []
  let currentRun: CapsuleInnerBlock[] = []

  function flushRun(isLastRun: boolean): void {
    if (!currentRun.length) return
    result.push(buildActivityCapsule(currentRun, { ...options, isLastRun }))
    currentRun = []
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (isCapsuleProcessBlock(block)) {
      currentRun.push(block)
    } else {
      flushRun(false)
      result.push(block)
    }
  }
  flushRun(true)

  return result
}

/**
 * 根据收集到的连续过程节点构建胶囊实体。
 */
function buildActivityCapsule(
  items: CapsuleInnerBlock[],
  options?: { isTurnActive?: boolean; clockTick?: number; isLastRun?: boolean }
): ConversationActivityCapsuleBlock {
  const first = items[0]
  const last = items[items.length - 1]
  const nodeId = `capsule:${first.nodeId}:${last.nodeId}`

  // 1. 综合状态判定
  let status: CapsuleStatus = 'completed'
  const hasFailed = items.some((item) => item.kind === 'tool' && item.status === 'failed')
  const hasRunning = items.some(
    (item) => item.kind === 'tool' && (item.status === 'in_progress' || item.status === 'pending')
  )
  const hasCancelled = items.some((item) => item.kind === 'tool' && item.status === 'cancelled')

  if (hasFailed) {
    status = 'failed'
  } else if (hasRunning || (options?.isTurnActive && options.isLastRun)) {
    status = 'in_progress'
  } else if (hasCancelled) {
    status = 'cancelled'
  }

  // 2. 统计实际操作总次数与核心动作去重
  let totalCount = 0
  const actionsSet = new Set<string>()
  for (const item of items) {
    if (item.kind === 'tool') {
      totalCount += item.mergedReadCount || 1
    } else {
      totalCount += 1
    }
    actionsSet.add(extractCapsuleActionVerb(item))
  }
  const actionsSummary = Array.from(actionsSet)

  // 3. 动作摘要文案预览
  const actionsPreview =
    actionsSummary.length > 3
      ? `${actionsSummary.slice(0, 3).join('、')} 等`
      : actionsSummary.join('、')

  // 4. 耗时计算
  let durationLabel: string | undefined
  const firstTime = items[0].kind === 'tool' ? items[0].tools[0]?.firstObservedAt : undefined
  const lastTime =
    last.kind === 'tool' ? last.tools[last.tools.length - 1]?.lastObservedAt : undefined
  if (firstTime && lastTime) {
    const diffMs = Date.parse(lastTime) - Date.parse(firstTime)
    if (!Number.isNaN(diffMs) && diffMs > 0) {
      const diffSec = Math.max(1, Math.round(diffMs / 1000))
      durationLabel = `${diffSec}s`
    }
  }

  // 5. 汇总主文案
  const durationSuffix = durationLabel ? ` · 耗时 ${durationLabel}` : ''
  const summary = `已执行 ${totalCount} 项操作（${actionsPreview}）${durationSuffix}`

  // 6. 进行中短文案
  let activeStepLabel: string | undefined
  if (status === 'in_progress') {
    if (last.kind === 'thought') {
      activeStepLabel = '正在思考...'
    } else if (last.kind === 'tool') {
      activeStepLabel = `正在操作 · ${last.label}`
    } else {
      activeStepLabel = '正在执行操作...'
    }
  }

  return {
    kind: 'activity-capsule',
    nodeId,
    status,
    items,
    summary,
    activeStepLabel,
    durationLabel,
    actionsSummary,
    totalCount
  }
}
