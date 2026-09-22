<script setup lang="ts">
/**
 * 现代 Agent 过程胶囊卡片（Activity Capsule）。
 * 用于将思考、工具调用与静默权限审计聚合成紧凑高聚合的卡片：
 * 默认收起为圆润 Pill 胶囊（高度 32px），展开时提供平滑的无噪音内联列表，
 * 彻底消除过去竖直糖葫芦轨道与一排排重复的“已完成”标签。
 */

import { computed, nextTick, ref, watch } from 'vue'
import {
  findCapsuleItemForNode,
  resolveActivityCapsuleExpansion,
  type CapsuleInnerBlock,
  type ConversationActivityCapsuleBlock
} from '../conversation-activity-capsule'

const props = defineProps<{
  capsule: ConversationActivityCapsuleBlock
  /** 当前轮次是否处于活跃执行中 */
  active?: boolean
  /** Inspector 反向定位时只接受真实 Timeline nodeId。 */
  focusNodeId?: string | null
  /** 同一节点允许重复触发定位。 */
  focusRequestId?: number
}>()

const emit = defineEmits<{
  openTool: [nodeId: string]
}>()

const root = ref<HTMLElement | null>(null)
// null 表示跟随执行状态；用户点过后保留其明确选择。
const userExpanded = ref<boolean | null>(null)
const isOpen = computed(() =>
  resolveActivityCapsuleExpansion(props.capsule.status, userExpanded.value)
)
const focusedItem = computed(() => findCapsuleItemForNode(props.capsule.items, props.focusNodeId))

// 跟踪展开查看详情的单项节点 ID 集合（例如长命令的参数或输出）
const expandedItemKeys = ref<Set<string>>(new Set())

/** 切换胶囊主体的展开/收起状态 */
function toggleOpen(): void {
  userExpanded.value = !isOpen.value
}

/** 切换具体某一步骤的详细信息（参数、标准输出、长正则等） */
function toggleItemDetail(nodeId: string): void {
  if (expandedItemKeys.value.has(nodeId)) {
    expandedItemKeys.value.delete(nodeId)
  } else {
    expandedItemKeys.value.add(nodeId)
  }
}

/** 提取合并读取的真实节点与文件路径，定位时不能丢掉 nodeId。 */
function getMergedFiles(item: CapsuleInnerBlock): readonly { nodeId: string; label: string }[] {
  if (item.kind !== 'tool' || !item.mergedReadCount || item.mergedReadCount < 2) return []
  return item.tools.map((tool) => ({
    nodeId: tool.nodeId,
    label: tool.title.replace(/^(?:读取|读了|读文件[:：]?\s*)/, '')
  }))
}

/** Inspector 可重复请求同一节点；先展开胶囊，再把真实所属项带回视野。 */
watch(
  () => [props.focusNodeId, props.focusRequestId, props.capsule.nodeId] as const,
  async () => {
    const item = focusedItem.value
    if (!item) return
    userExpanded.value = true
    await nextTick()
    const target = Array.from(
      root.value?.querySelectorAll<HTMLElement>('[data-capsule-item-node-id]') ?? []
    ).find((element) => element.dataset.capsuleItemNodeId === item.nodeId)
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'center', behavior: 'instant' })
  },
  { immediate: true }
)
</script>

<template>
  <div
    ref="root"
    class="activity-capsule"
    :data-status="capsule.status"
    :data-expanded="isOpen ? 'true' : undefined"
  >
    <!-- 胶囊头部触发栏：高度锁定在 32px 紧凑高度 -->
    <div
      class="activity-capsule-header"
      role="button"
      :aria-expanded="isOpen"
      tabindex="0"
      @click="toggleOpen"
      @keydown.enter.prevent="toggleOpen"
      @keydown.space.prevent="toggleOpen"
    >
      <!-- 左侧微图标区：进行中转圈，完成态微勾选，失败态红点 -->
      <div class="activity-capsule-icon-wrap" aria-hidden="true">
        <span v-if="capsule.status === 'in_progress'" class="activity-capsule-spinner" />
        <svg
          v-else-if="capsule.status === 'completed'"
          class="activity-capsule-check-icon"
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            d="M3.5 8.5L6.5 11.5L12.5 4.5"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span v-else-if="capsule.status === 'failed'" class="activity-capsule-dot failed" />
        <span v-else class="activity-capsule-dot neutral" />
      </div>

      <!-- 核心文案区：进行中显示当前动作，完成态展示精炼汇总 -->
      <div class="activity-capsule-text">
        <template v-if="capsule.status === 'in_progress'">
          <span class="activity-capsule-active-title">
            {{ capsule.activeStepLabel || '正在执行操作…' }}
          </span>
          <span class="activity-capsule-badge">进行中</span>
        </template>
        <template v-else>
          <span class="activity-capsule-title">
            {{
              capsule.status === 'failed'
                ? '执行失败'
                : capsule.status === 'cancelled'
                  ? '已停止'
                  : `已执行 ${capsule.totalCount} 项操作`
            }}
            <span v-if="capsule.actionsSummary.length" class="activity-capsule-subtitle">
              （{{ capsule.actionsSummary.join('、') }}）
            </span>
          </span>
          <span v-if="capsule.durationLabel" class="activity-capsule-duration">
            · 耗时 {{ capsule.durationLabel }}
          </span>
        </template>
      </div>

      <!-- 右侧展开收起轻量微箭头 -->
      <span class="activity-capsule-caret" aria-hidden="true" />
    </div>

    <!-- 展开后的内联列表：彻底消除刷屏的“已完成”文字与粗重的轨道线 -->
    <div v-if="isOpen" class="activity-capsule-body">
      <ul class="activity-capsule-list">
        <li
          v-for="item in capsule.items"
          :key="item.nodeId"
          class="activity-capsule-item"
          :data-kind="item.kind"
          :data-capsule-item-node-id="item.nodeId"
          :data-conversation-node-id="item.nodeId"
          :data-focused="focusedItem === item ? 'true' : undefined"
          tabindex="-1"
        >
          <!-- 合并工具额外保留每个真实节点锚点，外层定位无需猜标题。 -->
          <template v-if="item.kind === 'tool'">
            <span
              v-for="tool in item.tools"
              :key="`anchor:${tool.nodeId}`"
              class="activity-capsule-node-anchor"
              :data-conversation-node-id="tool.nodeId"
              aria-hidden="true"
            />
          </template>
          <!-- 极简浅灰微圆点（4px） -->
          <span class="activity-capsule-item-bullet" aria-hidden="true" />

          <!-- 步骤主要内容区 -->
          <div class="activity-capsule-item-content">
            <!-- 1. 思考过程 -->
            <template v-if="item.kind === 'thought'">
              <div
                class="activity-capsule-item-main"
                role="button"
                tabindex="0"
                @click="toggleItemDetail(item.nodeId)"
                @keydown.enter.prevent="toggleItemDetail(item.nodeId)"
                @keydown.space.prevent="toggleItemDetail(item.nodeId)"
              >
                <span class="activity-capsule-item-label">{{ item.summary }}</span>
                <span class="activity-capsule-item-view-hint">
                  {{ expandedItemKeys.has(item.nodeId) ? '收起思考' : '查看思考' }}
                </span>
              </div>
              <p v-if="expandedItemKeys.has(item.nodeId)" class="activity-capsule-detail-text">
                {{ item.text }}
              </p>
            </template>

            <!-- 2. 静默权限审计 -->
            <template v-else-if="item.kind === 'permission-audit'">
              <div class="activity-capsule-item-main">
                <span class="activity-capsule-item-label">{{ item.summary }}</span>
              </div>
            </template>

            <!-- 3. 工具执行节点 -->
            <template v-else-if="item.kind === 'tool'">
              <div
                class="activity-capsule-item-main"
                :class="{ 'has-detail': Boolean(item.detail || getMergedFiles(item).length) }"
                role="button"
                tabindex="0"
                @click="toggleItemDetail(item.nodeId)"
                @keydown.enter.prevent="toggleItemDetail(item.nodeId)"
                @keydown.space.prevent="toggleItemDetail(item.nodeId)"
              >
                <span class="activity-capsule-item-label">{{ item.label }}</span>
                <span v-if="item.warning" class="activity-capsule-item-warning">{{
                  item.warning
                }}</span>
                <span v-if="item.execution === 'background'" class="activity-capsule-tag"
                  >后台</span
                >

                <!-- 仅在失败或执行中时显示状态，成功态完全静默，绝不刷屏写“已完成”！ -->
                <span v-if="item.status === 'failed'" class="activity-capsule-item-failed"
                  >失败</span
                >
                <span v-if="item.status === 'in_progress'" class="activity-capsule-item-running"
                  >执行中</span
                >

                <span
                  v-if="
                    (item.detail || getMergedFiles(item).length) &&
                    !expandedItemKeys.has(item.nodeId)
                  "
                  class="activity-capsule-item-view-hint"
                >
                  详情
                </span>
              </div>
              <button
                type="button"
                class="activity-capsule-item-open"
                title="在检查器中查看此工具"
                :aria-label="`在检查器中查看：${item.label}`"
                @click="emit('openTool', item.nodeId)"
              >
                检查器
              </button>

              <!-- 合并读取文件列表 -->
              <ul
                v-if="getMergedFiles(item).length && expandedItemKeys.has(item.nodeId)"
                class="activity-capsule-files-list"
              >
                <li v-for="file in getMergedFiles(item)" :key="file.nodeId">
                  <button
                    type="button"
                    :title="`在检查器中查看：${file.label}`"
                    @click="emit('openTool', file.nodeId)"
                  >
                    {{ file.label }}
                  </button>
                </li>
              </ul>

              <!-- 长命令、入参或详细输出展开块 -->
              <pre
                v-else-if="item.detail && expandedItemKeys.has(item.nodeId)"
                class="activity-capsule-detail-code"
                >{{ item.detail }}</pre>
            </template>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.activity-capsule-item[data-focused='true'] {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  outline: 1px solid color-mix(in srgb, var(--accent) 48%, transparent);
  outline-offset: 2px;
}

.activity-capsule-node-anchor {
  display: none;
}

.activity-capsule-item-open,
.activity-capsule-files-list button {
  border: 0;
  color: var(--text-3);
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.activity-capsule-item-open {
  display: block;
  margin: 2px 0 0 auto;
  padding: 2px 4px;
  border-radius: 6px;
  font-size: var(--text-xs);
}

.activity-capsule-item-open:hover,
.activity-capsule-item-open:focus-visible,
.activity-capsule-files-list button:hover,
.activity-capsule-files-list button:focus-visible {
  color: var(--text-1);
  background: var(--surface-3);
  outline: 1px solid var(--border-strong);
}

.activity-capsule-files-list button {
  width: 100%;
  padding: 2px 4px;
  text-align: left;
}
</style>
