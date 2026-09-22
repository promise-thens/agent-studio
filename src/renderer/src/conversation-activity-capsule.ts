/**
 * 对话流执行过程胶囊卡片（Activity Capsule）模型与聚合算法。
 * 负责将主对话流中连续密集的思考、工具调用与静默审计聚合成现代优雅的紧凑胶囊，
 * 彻底消除垂直糖葫芦串与重复刷屏的“已完成”标签。
 */

import type { TaskExecutionState } from '../../shared/task-execution'
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

/** 聚合胶囊时需要的 Turn 级上下文；缺省按历史回放处理。 */
export interface GroupConversationBlocksOptions {
  isTurnActive?: boolean
  /** 与 Timeline Turn 状态对齐；停止/等待时不得把末尾胶囊钉在进行中。 */
  turnStatus?: TaskExecutionState | 'pending'
  /** 审批卡或问答卡贴在当前 Turn 时，过程已经停下来等用户。 */
  waitingForUser?: boolean
  clockTick?: number
}

/** 用户尚未明确选择时跟随执行状态；一旦手动展开或收起，就保留其阅读选择。 */
export function resolveActivityCapsuleExpansion(
  status: CapsuleStatus,
  userExpanded: boolean | null
): boolean {
  return userExpanded ?? status === 'in_progress'
}

/**
 * 只沿 Timeline 的真实 nodeId 定位胶囊项。
 * 合并读取仍保留每个原始工具节点，禁止使用相似标题猜测目标。
 */
export function findCapsuleItemForNode(
  items: readonly CapsuleInnerBlock[],
  nodeId: string | null | undefined
): CapsuleInnerBlock | undefined {
  if (!nodeId) return undefined
  return items.find(
    (item) =>
      item.nodeId === nodeId ||
      (item.kind === 'tool' && item.tools.some((tool) => tool.nodeId === nodeId))
  )
}

const STOPPED_TURN_STATES = new Set<TaskExecutionState | 'pending'>([
  'cancelling',
  'cancelled',
  'interrupted'
])

/**
 * 判断是否属于应当收入胶囊的中间执行过程节点。
 * 包含思考、工具执行、静默权限审计等过程节点；正文消息、计划看板、独立子任务与审批卡保持顶级展现。
 */
export function isCapsuleProcessBlock(block: ConversationBlock): block is CapsuleInnerBlock {
  if (block.kind === 'tool' && block.editDiffs?.length) return false
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
  options?: GroupConversationBlocksOptions
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
  options?: GroupConversationBlocksOptions & { isLastRun?: boolean }
): ConversationActivityCapsuleBlock {
  const first = items[0]
  const last = items[items.length - 1]
  const nodeId = `capsule:${first.nodeId}:${last.nodeId}`

  const status = resolveCapsuleStatus(items, last, options)

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

  // 6. 进行中短文案：跟真实还在跑的工具/思考，不跟尾巴上的静默授权
  const activeStepLabel = resolveCapsuleActiveStepLabel(status, items, last)

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

/**
 * 胶囊状态只跟 Turn 终态和真实还在跑的工具。
 * 停止后 ACP 可能不补工具终态；静默授权也总排在队尾——这两类都不能把卡片钉在进行中。
 */
function resolveCapsuleStatus(
  items: readonly CapsuleInnerBlock[],
  last: CapsuleInnerBlock,
  options?: GroupConversationBlocksOptions & { isLastRun?: boolean }
): CapsuleStatus {
  const hasFailed = items.some((item) => item.kind === 'tool' && item.status === 'failed')
  const hasRunning = items.some(
    (item) => item.kind === 'tool' && (item.status === 'in_progress' || item.status === 'pending')
  )
  const hasCancelled = items.some((item) => item.kind === 'tool' && item.status === 'cancelled')
  const stopped = Boolean(options?.turnStatus && STOPPED_TURN_STATES.has(options.turnStatus))
  const waiting = options?.waitingForUser === true || options?.turnStatus === 'waiting-permission'
  const live = isLiveCapsuleTurn(options)

  if (hasFailed) return 'failed'
  if (stopped) return 'cancelled'
  if (hasRunning && !waiting && live) return 'in_progress'
  if (hasCancelled) return 'cancelled'
  if (live && options?.isLastRun && !waiting && last.kind !== 'permission-audit') {
    return 'in_progress'
  }
  return 'completed'
}

/** 只有排队/运行中的 Turn 才允许胶囊保持进行中；终态和停止中一律收束。 */
function isLiveCapsuleTurn(options?: GroupConversationBlocksOptions): boolean {
  if (options?.turnStatus) {
    return options.turnStatus === 'running' || options.turnStatus === 'queued'
  }
  return options?.isTurnActive === true
}

/** 进行中文案优先取还在跑的工具；队尾审计不得覆盖成「正在执行操作...」。 */
function resolveCapsuleActiveStepLabel(
  status: CapsuleStatus,
  items: readonly CapsuleInnerBlock[],
  last: CapsuleInnerBlock
): string | undefined {
  if (status !== 'in_progress') return undefined
  const runningTool = [...items]
    .reverse()
    .find(
      (item) => item.kind === 'tool' && (item.status === 'in_progress' || item.status === 'pending')
    )
  if (runningTool?.kind === 'tool') return `正在操作 · ${runningTool.label}`
  if (last.kind === 'thought') return '正在思考...'
  if (last.kind === 'tool') return `正在操作 · ${last.label}`
  return '正在执行操作...'
}
