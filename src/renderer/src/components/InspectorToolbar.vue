<script setup lang="ts">
import { nextTick } from 'vue'
import {
  PhArrowsIn as ArrowsIn,
  PhArrowsOut as ArrowsOut,
  PhColumns as Columns,
  PhSidebarSimple as SidebarSimple,
  PhX as X
} from '@phosphor-icons/vue'
import {
  INSPECTOR_TABS,
  nextInspectorTab,
  resolveInspectorTab,
  type InspectorTab
} from '../task-inspector'

const props = withDefaults(
  defineProps<{
    activeTab: InspectorTab
    compact?: boolean
    showControls?: boolean
    expanded?: boolean
    docked?: boolean
    split?: boolean
  }>(),
  {
    compact: false,
    showControls: true,
    expanded: false,
    docked: false,
    split: false
  }
)

const emit = defineEmits<{
  'update:activeTab': [tab: InspectorTab]
  toggleExpanded: []
  toggleDocked: []
  toggleSplit: []
  close: []
}>()

/** 统一处理主栏与副栏的标签切换，避免各面板重复实现校验。 */
function selectTab(tab: InspectorTab, focus = false): void {
  const next = resolveInspectorTab(tab)
  emit('update:activeTab', next)
  if (!focus) return
  void nextTick(() => document.getElementById(tabId(next))?.focus())
}

/** 通过紧凑模式生成不同的 DOM id，确保分栏标签不会互相覆盖。 */
function tabId(tab: InspectorTab): string {
  return `inspector-tab-${props.compact ? 'secondary-' : ''}${tab}`
}

/** 键盘左右切换标签，和原检查器的可访问交互保持一致。 */
function onTabKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault()
    const delta: -1 | 1 = event.key === 'ArrowRight' ? 1 : -1
    selectTab(nextInspectorTab(props.activeTab, delta), true)
    return
  }
  if (event.key === 'Home') {
    event.preventDefault()
    selectTab('timeline', true)
    return
  }
  if (event.key === 'End') {
    event.preventDefault()
    selectTab(INSPECTOR_TABS[INSPECTOR_TABS.length - 1]?.id ?? 'timeline', true)
  }
}
</script>

<template>
  <div class="inspector-toolbar-content" :class="{ 'is-compact': compact }">
    <div class="inspector-tabs" role="tablist" aria-label="检查器标签" @keydown="onTabKeydown">
      <button
        v-for="tab in INSPECTOR_TABS"
        :id="tabId(tab.id)"
        :key="tab.id"
        class="inspector-tab"
        type="button"
        role="tab"
        :aria-controls="`inspector-panel-${compact ? 'secondary' : 'primary'}-${tab.id}`"
        :aria-selected="activeTab === tab.id"
        :tabindex="activeTab === tab.id ? 0 : -1"
        @click="selectTab(tab.id)"
      >
        {{ tab.label }}
      </button>
    </div>

    <div v-if="showControls" class="inspector-toolbar-actions">
      <button
        class="icon-button inspector-control"
        type="button"
        :title="split ? '关闭分栏' : '开启分栏'"
        :aria-label="split ? '关闭分栏' : '开启分栏'"
        :aria-pressed="split"
        @click="emit('toggleSplit')"
      >
        <Columns :size="compact ? 14 : 16" />
      </button>
      <button
        class="icon-button inspector-control"
        type="button"
        :title="docked ? '还原为悬浮面板' : '吸附到工作区右侧'"
        :aria-label="docked ? '还原为悬浮面板' : '吸附到工作区右侧'"
        :aria-pressed="docked"
        @click="emit('toggleDocked')"
      >
        <SidebarSimple :size="compact ? 14 : 16" />
      </button>
      <button
        class="icon-button inspector-control"
        type="button"
        :title="docked ? '吸附状态下已占满右侧' : expanded ? '还原检查器大小' : '放大检查器'"
        :aria-label="docked ? '吸附状态下已占满右侧' : expanded ? '还原检查器大小' : '放大检查器'"
        :disabled="docked"
        @click="emit('toggleExpanded')"
      >
        <ArrowsIn v-if="expanded" :size="compact ? 14 : 16" />
        <ArrowsOut v-else :size="compact ? 14 : 16" />
      </button>
      <button
        class="icon-button inspector-control inspector-close"
        type="button"
        title="关闭检查器"
        aria-label="关闭检查器"
        @click="emit('close')"
      >
        <X :size="compact ? 14 : 16" />
      </button>
    </div>
  </div>
</template>
