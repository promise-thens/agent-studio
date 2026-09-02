import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AgentPlanEntry } from '../../shared/agent'
import type { TaskTimelineViewModel, TurnTimelineViewModel } from './task-timeline-reducer'
import { projectConversationTurn } from './conversation-turn-view'
import {
  PLAN_EMPTY_COPY,
  resolveConversationPlanEmptyClass,
  resolveConversationPlanEmptyCopy,
  resolvePlanChecklistEmptyCopy
} from './conversation-plan-empty'

const rendererDir = dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(join(rendererDir, 'App.vue'), 'utf8')
const conversationSource = readFileSync(
  join(rendererDir, 'components/TaskConversation.vue'),
  'utf8'
)
const conversationTurnSource = readFileSync(
  join(rendererDir, 'components/ConversationTurn.vue'),
  'utf8'
)
const planChecklistSource = readFileSync(join(rendererDir, 'components/PlanChecklist.vue'), 'utf8')
const inspectorPaneSource = readFileSync(join(rendererDir, 'components/InspectorPane.vue'), 'utf8')
const inspectorPlanSource = readFileSync(
  join(rendererDir, 'components/InspectorPlanPane.vue'),
  'utf8'
)
const timelineComposableSource = readFileSync(
  join(rendererDir, 'composables/useTaskTimeline.ts'),
  'utf8'
)
const mainCss = readFileSync(join(rendererDir, 'assets/main.css'), 'utf8')

/** 取第一个同名规则块，用来断言流式空态没有 flex:1。 */
function cssRule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`)
  expect(start).toBeGreaterThan(-1)
  const open = source.indexOf('{', start)
  const close = source.indexOf('}', open)
  return source.slice(start, close + 1)
}

const PLAN_EMPTY_COPY_TEXT = 'Grok 还没给出计划'

const mixedEntries: AgentPlanEntry[] = [
  { content: '找设置页', priority: 'high', status: 'pending' },
  { content: '加开关', priority: 'medium', status: 'in_progress' },
  { content: '补测试', priority: 'low', status: 'completed' }
]

function turn(nodes: TurnTimelineViewModel['nodes']): TurnTimelineViewModel {
  return {
    taskId: 'task-1',
    turnId: 'turn-1',
    prompt: '给设置页加一个开关',
    model: { modelId: 'model-1' },
    status: 'running',
    statusProvisional: false,
    statusConflict: false,
    createdAt: '2026-08-12T00:00:00.000Z',
    nodes,
    usage: { contextSamples: [] },
    historyTruncated: false
  }
}

function planNode(entries: AgentPlanEntry[]): TurnTimelineViewModel['nodes'][number] {
  return {
    nodeId: 'task-1:turn-1:plan',
    taskId: 'task-1',
    turnId: 'turn-1',
    source: 'agent-event',
    kind: 'plan',
    entries
  }
}

function model(nodes: TurnTimelineViewModel['nodes']): Pick<TaskTimelineViewModel, 'turns'> {
  return { turns: [turn(nodes)] }
}

describe('主列计划空态', () => {
  it('plan 模式且对话没有任何 plan entries 时出现「Grok 还没给出计划」', () => {
    expect(PLAN_EMPTY_COPY).toBe(PLAN_EMPTY_COPY_TEXT)
    expect(
      resolveConversationPlanEmptyCopy({
        planMode: 'plan',
        model: { turns: [] }
      })
    ).toBe(PLAN_EMPTY_COPY_TEXT)
    expect(
      resolveConversationPlanEmptyCopy({
        planMode: 'plan',
        model: null
      })
    ).toBe(PLAN_EMPTY_COPY_TEXT)
    expect(
      resolveConversationPlanEmptyCopy({
        planMode: 'plan',
        model: model([
          {
            nodeId: 'task-1:turn-1:user',
            taskId: 'task-1',
            turnId: 'turn-1',
            source: 'admission',
            kind: 'user-prompt',
            text: '给设置页加一个开关'
          }
        ])
      })
    ).toBe(PLAN_EMPTY_COPY_TEXT)
    expect(
      resolveConversationPlanEmptyCopy({
        planMode: 'plan',
        model: { turns: [] },
        loading: true
      })
    ).toBe('')
  })

  it('有 plan entries 或非 plan 模式时空态消失', () => {
    expect(
      resolveConversationPlanEmptyCopy({
        planMode: 'normal',
        model: { turns: [] }
      })
    ).toBe('')
    expect(
      resolveConversationPlanEmptyCopy({
        planMode: 'plan',
        model: model([planNode(mixedEntries)])
      })
    ).toBe('')
  })

  it('空 entries 的 plan 节点用同一句空态，不编造 ACP 条目', () => {
    expect(resolvePlanChecklistEmptyCopy([])).toBe(PLAN_EMPTY_COPY_TEXT)
    expect(
      resolveConversationPlanEmptyCopy({
        planMode: 'plan',
        model: model([planNode([])])
      })
    ).toBe('')

    const blocks = projectConversationTurn(turn([planNode([])]))
    const plan = blocks.find((block) => block.kind === 'plan')
    expect(plan).toMatchObject({
      kind: 'plan',
      nodeId: 'task-1:turn-1:plan',
      entries: []
    })
    if (plan?.kind !== 'plan') throw new Error('expected plan block')
    expect(plan.entries).toHaveLength(0)
    expect(plan.entries).toEqual([])
    expect(JSON.stringify(plan)).not.toContain('找设置页')
  })

  it('有 entries 时仍走 PlanChecklist 的 pending/in_progress/completed，不出现空态', () => {
    expect(resolvePlanChecklistEmptyCopy(mixedEntries)).toBe('')
    const blocks = projectConversationTurn(turn([planNode(mixedEntries)]))
    const plan = blocks.find((block) => block.kind === 'plan')
    expect(plan).toMatchObject({
      kind: 'plan',
      entries: mixedEntries
    })
    if (plan?.kind !== 'plan') throw new Error('expected plan block')
    expect(plan.entries.map((entry) => entry.status)).toEqual([
      'pending',
      'in_progress',
      'completed'
    ])
    expect(plan.entries.map((entry) => entry.content)).toEqual(['找设置页', '加开关', '补测试'])
    expect(conversationTurnSource).toContain('<PlanChecklist')
    expect(conversationTurnSource).toContain(':entries="block.entries"')
    expect(planChecklistSource).toContain('data-status')
    expect(planChecklistSource).toContain("status === 'completed'")
    expect(planChecklistSource).toContain("status === 'in_progress'")
  })
})

describe('主列计划空态接线', () => {
  it('已有 Turn 时计划空态走 conversation-plan-empty，不得再用满高 conversation-empty', () => {
    expect(resolveConversationPlanEmptyClass(false)).toBe('conversation-empty')
    expect(resolveConversationPlanEmptyClass(true)).toBe('conversation-plan-empty')
    expect(conversationSource).toContain('resolveConversationPlanEmptyClass')
    expect(conversationSource).toContain('planEmptyClass')
    expect(conversationSource).toMatch(/v-if="planEmptyCopy"[\s\S]*:class="planEmptyClass"/)
    expect(conversationSource).not.toMatch(/v-if="planEmptyCopy"[\s\S]*class="conversation-empty"/)

    const inStream = cssRule(mainCss, '.conversation-plan-empty')
    expect(inStream).not.toMatch(/flex:\s*1/)
    expect(cssRule(mainCss, '.conversation-empty')).toMatch(/flex:\s*1/)
  })

  it('App 把当前 Task 的 Plan 模式传给对话列；详情由 Timeline Inspector 复用快照', () => {
    const start = appSource.indexOf('<TaskConversation')
    const end = appSource.indexOf('/>', start)
    const conversationTag = appSource.slice(start, end + 2)
    expect(conversationTag).toContain(':plan-mode="composerPlanMode"')
    expect(conversationSource).toContain('planMode')
    expect(conversationSource).toContain('resolveConversationPlanEmptyCopy')
    expect(conversationSource).toContain('planEmptyCopy')
    expect(conversationSource).toMatch(/role="status"/)
    expect(conversationSource).not.toContain('task:append-plan')
    expect(conversationSource).not.toContain('acceptLiveEvent')
  })

  it('空 entries 不渲染空白 ol，空态容器可读屏', () => {
    expect(planChecklistSource).toContain('resolvePlanChecklistEmptyCopy')
    expect(planChecklistSource).toMatch(/role="status"/)
    expect(planChecklistSource).toMatch(/v-else[\s\S]*class="plan-checklist"/)
    expect(inspectorPaneSource).toContain('showPlanPanel')
    expect(inspectorPaneSource).toContain('<InspectorPlanPane')
  })

  it('计划点击打开现有 Inspector 的独立 Plan 标签，并由同一份 reducer 快照即时刷新', () => {
    expect(conversationTurnSource).toContain('@click="$emit(\'openPlan\', turn.turnId)"')
    expect(conversationSource).toContain('@open-plan="$emit(\'openPlan\', $event)"')
    expect(appSource).toContain('@open-plan="openPlanReview"')
    expect(appSource).toContain("inspectorTab.value = 'plan'")
    expect(inspectorPlanSource).toContain('<PlanChecklist')
    expect(inspectorPlanSource).toContain('projectInspectorPlan')
    expect(timelineComposableSource).toMatch(/event\.kind === 'plan'[\s\S]*dispatch\(event\.taskId/)
  })
})
