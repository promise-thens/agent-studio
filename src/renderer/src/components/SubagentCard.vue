<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { PhX as X } from '@phosphor-icons/vue'
import type { AgentToolStatus } from '../../../shared/agent'
import {
  SUBAGENT_STOP_COPY,
  createSubagentPopupController,
  subagentStatusLabel
} from '../conversation-subagent-view'
import { parseSubagentSpawnTitle } from '../subagent-spawn-title'
import ToolRow from './ToolRow.vue'

const props = defineProps<{
  name: string
  status: 'running' | 'completed' | 'failed'
  tools: readonly {
    key: string
    label: string
    status: AgentToolStatus | 'unknown'
    files?: readonly string[]
    detail?: string
  }[]
  durationLabel?: string
  groupingNote?: string
}>()

const statusLabel = computed(() => subagentStatusLabel(props.status))
const spawn = computed(() => parseSubagentSpawnTitle(props.name))
const popupTitle = computed(() => spawn.value?.name || props.name)
const popup = createSubagentPopupController()
const open = ref(popup.open)

function syncOpen(): void {
  open.value = popup.open
}

function showPopup(): void {
  popup.show()
  syncOpen()
}

function hidePopup(): void {
  popup.hide()
  syncOpen()
}

function onPillClick(): void {
  showPopup()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !open.value) return
  event.preventDefault()
  hidePopup()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <!-- 对话只留药丸；点开 Teleport 弹层看这个孩子做了什么。 -->
  <div class="subagent-card" :data-status="status">
    <button
      class="subagent-pill"
      type="button"
      :title="name"
      :aria-label="`${name}，${statusLabel}`"
      :aria-expanded="open"
      aria-haspopup="dialog"
      @click="onPillClick"
    >
      <span class="subagent-heading">
        <span class="subagent-dot" aria-hidden="true" />
        <span class="subagent-name">{{ name }}</span>
        <span class="subagent-status">{{ statusLabel }}</span>
      </span>
    </button>

    <Teleport to="body">
      <div v-if="open" class="subagent-overlay" @click.self="hidePopup">
        <section
          class="subagent-dialog"
          :data-status="status"
          role="dialog"
          aria-modal="true"
          :aria-label="`${popupTitle} 做了什么`"
        >
          <header class="subagent-dialog-header">
            <div class="subagent-dialog-identity">
              <p v-if="spawn" class="subagent-type">{{ spawn.agentType }}</p>
              <h2>{{ popupTitle }}</h2>
              <p v-if="spawn?.shortId" class="subagent-id">{{ spawn.shortId }}</p>
            </div>
            <div class="subagent-dialog-meta">
              <span class="subagent-dialog-status">{{ statusLabel }}</span>
              <span v-if="durationLabel">{{ durationLabel }}</span>
              <button
                class="icon-button"
                type="button"
                title="关闭子代理卡片"
                aria-label="关闭子代理卡片"
                @click="hidePopup"
              >
                <X :size="16" />
              </button>
            </div>
          </header>
          <div class="subagent-dialog-body">
            <p v-if="groupingNote" class="subagent-meta">{{ groupingNote }}</p>
            <h3>做了什么</h3>
            <p v-if="!tools.length && !groupingNote" class="subagent-meta">
              还没有可展示的工具活动。
            </p>
            <div v-else class="subagent-tools">
              <ToolRow
                v-for="tool in tools"
                :key="tool.key"
                :label="tool.label"
                :status="tool.status"
                :files="tool.files ?? []"
                :detail="tool.detail"
              />
            </div>
            <p v-if="status === 'running'" class="subagent-stop-hint">{{ SUBAGENT_STOP_COPY }}</p>
          </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>
