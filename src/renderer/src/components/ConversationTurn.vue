<script setup lang="ts">
import { computed } from 'vue'
import type { AgentPermissionDecision, AgentPermissionRequest } from '../../../shared/agent'
import { flattenSubagentToolsToRows, shouldMountSubagentCard } from '../conversation-subagent-view'
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
    active?: boolean
    hasMoreEvents?: boolean
    loadingMoreEvents?: boolean
  }>(),
  {
    variant: 'conversation',
    permission: null,
    permissionPending: false,
    permissionTaskTitle: '',
    active: false,
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
      block.kind !== 'attachment' &&
      block.kind !== 'permission' &&
      block.kind !== 'plan'
  )
})

/** 只为非终态 Turn 提供明确尾标，避免用户只能从顶部状态猜 Runtime 是否仍在工作。 */
const activityLabel = computed(() => {
  if (props.variant !== 'conversation' || !props.active) return ''
  switch (props.turn.status) {
    case 'pending':
    case 'queued':
      return '等待执行'
    case 'running':
      return '正在运行'
    case 'waiting-permission':
      return '等待你的确认'
    case 'cancelling':
      return '正在停止'
    default:
      return ''
  }
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
          variant="user"
        />
      </div>

      <div
        v-else-if="block.kind === 'attachment'"
        class="conversation-assistant-media"
        data-kind="attachment"
      >
        <ConversationMedia
          :task-id="block.taskId"
          :attachment-ids="block.attachmentIds"
          variant="assistant"
        />
      </div>

      <details
        v-else-if="block.kind === 'thought'"
        class="conversation-thought conversation-process-step"
        data-kind="thought"
        data-process-kind="thought"
      >
        <summary>
          <span class="conversation-process-caret" aria-hidden="true" />
          <span class="conversation-process-label">{{ block.summary }}</span>
        </summary>
        <p class="conversation-thought-body">{{ block.text }}</p>
      </details>

      <details
        v-else-if="block.kind === 'plan'"
        class="conversation-plan conversation-process-step"
        data-kind="plan"
        data-process-kind="plan"
        :open="block.defaultExpanded"
      >
        <summary>
          <span class="conversation-process-caret" aria-hidden="true" />
          <span class="conversation-process-label">{{ block.summary }}</span>
        </summary>
        <PlanChecklist :entries="block.entries" :active="block.defaultExpanded" />
      </details>

      <ToolRow
        v-else-if="block.kind === 'tool'"
        class="conversation-process-step"
        data-process-kind="tool"
        :label="block.label"
        :status="block.status"
        :files="mergedReadFiles(block)"
        :detail="block.detail"
        :warning="block.warning"
      />

      <SubagentCard
        v-else-if="block.kind === 'subagent' && shouldMountSubagentCard(block)"
        class="conversation-process-step"
        data-process-kind="subagent"
        :name="block.name"
        :status="block.status"
        :tools="flattenSubagentToolsToRows(block.tools)"
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

      <div
        v-else-if="block.kind === 'permission-audit'"
        class="conversation-permission-audit conversation-process-step"
        data-kind="permission-audit"
        data-process-kind="permission-audit"
      >
        <span class="conversation-process-label">{{ block.summary }}</span>
      </div>

      <PermissionPrompt
        v-else-if="block.kind === 'permission'"
        :request="block.request"
        :pending="permissionPending"
        :task-title="permissionTaskTitle"
        @respond="$emit('respondPermission', $event)"
        @cancel-turn="$emit('cancelTurn')"
      />

      <details
        v-else-if="block.kind === 'usage'"
        class="conversation-usage conversation-process-step"
        data-kind="usage"
        data-process-kind="usage"
      >
        <summary>
          <span class="conversation-process-caret" aria-hidden="true" />
          <span class="conversation-process-label">{{ block.summary }}</span>
        </summary>
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

    <div
      v-if="activityLabel"
      class="conversation-run-indicator"
      :data-status="turn.status"
      role="status"
      aria-live="polite"
    >
      <span class="conversation-run-orbit" aria-hidden="true" />
      <span class="conversation-run-copy">{{ activityLabel }}</span>
      <span class="conversation-run-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  </div>
</template>
