<script setup lang="ts">
import { computed } from 'vue'
import type { AgentPermissionDecision, AgentPermissionRequest } from '../../../shared/agent'
import { shouldMountSubagentCard, toSubagentToolRows } from '../conversation-subagent-view'
import {
  formatToolVerbPhrase,
  projectConversationTurn,
  type ConversationToolBlock
} from '../conversation-turn-view'
import type { TurnTimelineViewModel } from '../task-timeline-reducer'
import AssistantMarkdown from './AssistantMarkdown.vue'
import ConversationMedia from './ConversationMedia.vue'
import PermissionPrompt from './PermissionPrompt.vue'
import PlanChecklist from './PlanChecklist.vue'
import SubagentCard from './SubagentCard.vue'
import ToolRow from './ToolRow.vue'

const props = withDefaults(
  defineProps<{
    turn: TurnTimelineViewModel
    variant?: 'conversation' | 'inspector'
    permission?: AgentPermissionRequest | null
    permissionPending?: boolean
    permissionTaskTitle?: string
    hasMoreEvents?: boolean
    loadingMoreEvents?: boolean
  }>(),
  {
    variant: 'conversation',
    permission: null,
    permissionPending: false,
    permissionTaskTitle: '',
    hasMoreEvents: false,
    loadingMoreEvents: false
  }
)

defineEmits<{
  respondPermission: [decision: AgentPermissionDecision]
  cancelTurn: []
  loadMoreEvents: [turnId: string]
}>()

/** 主列走完整对话块；检查器只留过程缩略，避免再当主界面。 */
const blocks = computed(() => {
  const projected = projectConversationTurn(props.turn, {
    pendingPermission: props.variant === 'conversation' ? props.permission : null
  })
  if (props.variant !== 'inspector') return projected
  return projected.filter(
    (block) =>
      block.kind !== 'user' &&
      block.kind !== 'message' &&
      block.kind !== 'permission' &&
      block.kind !== 'plan'
  )
})

function mergedReadFiles(block: ConversationToolBlock): string[] {
  if (!block.mergedReadCount || block.mergedReadCount < 2) return []
  return block.tools.map((item) => formatToolVerbPhrase(item.title).replace(/^读了\s+/, ''))
}
</script>

<template>
  <div class="conversation-blocks" :data-variant="variant">
    <template v-for="block in blocks" :key="block.nodeId">
      <div v-if="block.kind === 'user'" class="conversation-user" data-kind="user">
        <p v-if="block.text">{{ block.text }}</p>
        <ConversationMedia
          v-if="block.taskId && block.attachmentIds?.length"
          :task-id="block.taskId"
          :attachment-ids="block.attachmentIds"
        />
      </div>

      <details
        v-else-if="block.kind === 'thought'"
        class="conversation-thought"
        data-kind="thought"
      >
        <summary>{{ block.summary }}</summary>
        <p class="conversation-thought-body">{{ block.text }}</p>
      </details>

      <details
        v-else-if="block.kind === 'plan'"
        class="conversation-plan"
        data-kind="plan"
        :open="block.defaultExpanded"
      >
        <summary>{{ block.summary }}</summary>
        <PlanChecklist :entries="block.entries" :active="block.defaultExpanded" />
      </details>

      <ToolRow
        v-else-if="block.kind === 'tool'"
        :label="block.label"
        :status="block.status"
        :files="mergedReadFiles(block)"
        :detail="block.detail"
        :warning="block.warning"
      />

      <SubagentCard
        v-else-if="block.kind === 'subagent' && shouldMountSubagentCard(block)"
        :name="block.name"
        :status="block.status"
        :tools="toSubagentToolRows(block.tools)"
      />

      <div v-else-if="block.kind === 'message'" class="conversation-assistant" data-kind="message">
        <AssistantMarkdown :text="block.text" />
      </div>

      <p
        v-else-if="block.kind === 'error'"
        class="conversation-error"
        data-kind="error"
        role="status"
      >
        {{ block.message }}
      </p>

      <PermissionPrompt
        v-else-if="block.kind === 'permission'"
        :request="block.request"
        :pending="permissionPending"
        :task-title="permissionTaskTitle"
        @respond="$emit('respondPermission', $event)"
        @cancel-turn="$emit('cancelTurn')"
      />

      <details v-else-if="block.kind === 'usage'" class="conversation-usage" data-kind="usage">
        <summary>{{ block.summary }}</summary>
      </details>

      <p
        v-else-if="block.kind === 'availability'"
        class="conversation-availability"
        data-kind="availability"
        role="status"
      >
        {{ block.message }}
      </p>
    </template>

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
  </div>
</template>
