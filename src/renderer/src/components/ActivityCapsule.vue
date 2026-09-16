<script setup lang="ts">
/**
 * 现代 Agent 过程胶囊卡片（Activity Capsule）。
 * 用于将思考、工具调用与静默权限审计聚合成紧凑高聚合的卡片：
 * 默认收起为圆润 Pill 胶囊（高度 32px），展开时提供平滑的无噪音内联列表，
 * 彻底消除过去竖直糖葫芦轨道与一排排重复的“已完成”标签。
 */

import { ref } from 'vue'
import type {
  CapsuleInnerBlock,
  ConversationActivityCapsuleBlock
} from '../conversation-activity-capsule'

const props = defineProps<{
  capsule: ConversationActivityCapsuleBlock
  /** 当前轮次是否处于活跃执行中 */
  active?: boolean
}>()

// 完成态默认收起，进行中态默认展开以便用户直观感知当前执行进度
const isOpen = ref(props.capsule.status === 'in_progress')

// 跟踪展开查看详情的单项节点 ID 集合（例如长命令的参数或输出）
const expandedItemKeys = ref<Set<string>>(new Set())

/** 切换胶囊主体的展开/收起状态 */
function toggleOpen(): void {
  isOpen.value = !isOpen.value
}

/** 切换具体某一步骤的详细信息（参数、标准输出、长正则等） */
function toggleItemDetail(nodeId: string): void {
  if (expandedItemKeys.value.has(nodeId)) {
    expandedItemKeys.value.delete(nodeId)
  } else {
    expandedItemKeys.value.add(nodeId)
  }
}

/** 提取合并读取的文件路径列表 */
function getMergedFileList(item: CapsuleInnerBlock): readonly string[] {
  if (item.kind !== 'tool' || !item.mergedReadCount || item.mergedReadCount < 2) return []
  return item.tools.map((t) => t.title.replace(/^(?:读取|读了|读文件[:：]?\s*)/, ''))
}
</script>

<template>
  <div
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
            已执行 {{ capsule.totalCount }} 项操作
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
        >
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
                :class="{ 'has-detail': Boolean(item.detail || getMergedFileList(item).length) }"
                role="button"
                tabindex="0"
                @click="toggleItemDetail(item.nodeId)"
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
                    (item.detail || getMergedFileList(item).length) &&
                    !expandedItemKeys.has(item.nodeId)
                  "
                  class="activity-capsule-item-view-hint"
                >
                  详情
                </span>
              </div>

              <!-- 合并读取文件列表 -->
              <ul
                v-if="getMergedFileList(item).length && expandedItemKeys.has(item.nodeId)"
                class="activity-capsule-files-list"
              >
                <li v-for="file in getMergedFileList(item)" :key="file">{{ file }}</li>
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
