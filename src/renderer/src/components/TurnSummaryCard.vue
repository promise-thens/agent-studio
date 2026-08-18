<script setup lang="ts">
import type { TurnTimelineViewModel } from '../task-timeline-reducer'

defineProps<{
  turn: TurnTimelineViewModel
  hasMoreEvents?: boolean
  loadingMoreEvents?: boolean
}>()
defineEmits<{ loadMoreEvents: [turnId: string] }>()
</script>

<template>
  <article class="timeline-turn" :data-turn-id="turn.turnId" :data-status="turn.status">
    <header class="timeline-turn-header">
      <span class="timeline-turn-status">{{ turn.status }}</span>
      <span v-if="turn.statusConflict" class="timeline-warning">状态冲突</span>
      <span v-if="turn.historyTruncated" class="timeline-warning">历史已截断</span>
    </header>
    <p class="timeline-prompt">{{ turn.prompt }}</p>
    <div class="timeline-nodes">
      <template v-for="node in turn.nodes" :key="node.nodeId">
        <!-- 用户指令已在卡片顶部展示，避免同一内容重复朗读。 -->
        <details v-if="node.kind === 'thought'" class="timeline-thought">
          <summary>推理过程</summary>
          <p>{{ node.text }}</p>
        </details>
        <div v-else-if="node.kind !== 'user-prompt'" class="timeline-node" :data-kind="node.kind">
          <template v-if="node.kind === 'message' || node.kind === 'error'">
            <strong v-if="node.kind !== 'message'">{{ node.kind }}</strong>
            <span v-if="node.kind === 'error'">{{ node.message }}</span>
            <span v-else>{{ node.text }}</span>
          </template>
          <template v-else-if="node.kind === 'tool'">
            <strong>Tool</strong><span>{{ node.title }} · {{ node.status }}</span>
          </template>
          <template v-else-if="node.kind === 'plan'">
            <strong>Plan</strong><span>{{ node.entries.length }} 项</span>
          </template>
          <template v-else-if="node.kind === 'permission-audit'">
            <strong>Permission</strong><span>{{ node.audit.reason }}</span>
          </template>
          <template v-else-if="node.kind === 'diff-reference'">
            <strong>Diff</strong><span>不可用 · {{ node.changedPathCount }} 个路径</span>
          </template>
          <template v-else-if="node.kind === 'usage'">
            <strong>Usage</strong><span>{{ node.usage.scope }}</span>
          </template>
          <template v-else-if="node.kind === 'turn-complete'">
            <strong>完成</strong><span>{{ node.outcome }}</span>
          </template>
          <template v-else-if="node.kind === 'availability'">
            <strong>提示</strong><span>{{ node.message }}</span>
          </template>
        </div>
      </template>
    </div>
    <button
      v-if="hasMoreEvents"
      class="history-load-more"
      type="button"
      :disabled="loadingMoreEvents"
      :aria-busy="loadingMoreEvents"
      @click="$emit('loadMoreEvents', turn.turnId)"
    >
      {{ loadingMoreEvents ? '正在加载…' : '加载本轮更多事件' }}
    </button>
  </article>
</template>
