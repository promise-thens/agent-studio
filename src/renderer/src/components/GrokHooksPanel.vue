<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'
import {
  GROK_HOOKS_EMPTY_COPY,
  GROK_HOOKS_ERROR_COPY,
  GROK_HOOKS_INTRO,
  GROK_HOOKS_LOADING_COPY,
  GROK_HOOKS_RETRY_LABEL,
  GROK_HOOKS_TITLE,
  mapGrokHookSummariesToRowViews,
  type GrokHookRowView
} from '../grok-hooks-settings'

const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const errorMessage = ref('')
const hookRows = ref<GrokHookRowView[]>([])

/** 只读库存：走 listHooks，Renderer 不读磁盘、不执行钩子。 */
async function loadHooks(): Promise<void> {
  loadState.value = 'loading'
  errorMessage.value = ''
  try {
    const summaries = unwrapDesktopIpcResult(await window.app.listHooks())
    hookRows.value = mapGrokHookSummariesToRowViews(summaries)
    loadState.value = 'ready'
  } catch (error) {
    hookRows.value = []
    errorMessage.value = error instanceof Error ? error.message : String(error)
    loadState.value = 'error'
  }
}

onMounted(() => {
  void loadHooks()
})
</script>

<template>
  <section class="hooks-pane" aria-labelledby="grok-hooks-title">
    <header>
      <h3 id="grok-hooks-title">{{ GROK_HOOKS_TITLE }}</h3>
      <p id="grok-hooks-intro">{{ GROK_HOOKS_INTRO }}</p>
    </header>

    <div
      class="hooks-body"
      :aria-busy="loadState === 'loading' ? 'true' : undefined"
      aria-describedby="grok-hooks-intro"
    >
      <p v-if="loadState === 'loading'" class="hooks-status" role="status">
        {{ GROK_HOOKS_LOADING_COPY }}
      </p>
      <div v-else-if="loadState === 'error'" class="hooks-error" role="alert">
        <p id="grok-hooks-error" class="error">
          {{ errorMessage || GROK_HOOKS_ERROR_COPY }}
        </p>
        <button
          class="hub-secondary"
          type="button"
          :title="GROK_HOOKS_RETRY_LABEL"
          :aria-label="GROK_HOOKS_RETRY_LABEL"
          @click="loadHooks"
        >
          重试
        </button>
      </div>
      <p v-else-if="hookRows.length === 0" class="hooks-empty">{{ GROK_HOOKS_EMPTY_COPY }}</p>
      <ul v-else class="hooks-list">
        <li v-for="row in hookRows" :key="row.id" class="hooks-row">
          <div class="hooks-row-main">
            <span class="hooks-event">{{ row.eventLabel }}</span>
            <span class="hooks-enabled">{{ row.enabledLabel }}</span>
            <span class="hooks-target">{{ row.targetLabel }}</span>
          </div>
          <p v-if="row.warning" class="hooks-warning">{{ row.warning }}</p>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.hooks-pane {
  display: grid;
  gap: 12px;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  grid-template-rows: auto minmax(0, 1fr);
}

header h3,
header p {
  margin: 0;
}

header h3 {
  font-size: 16px;
}

header p,
.hooks-status,
.hooks-empty,
.hooks-warning {
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.55;
}

.hooks-body {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--app-bg);
}

.hooks-status,
.hooks-empty,
.hooks-warning {
  margin: 0;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.hooks-error {
  display: grid;
  gap: 8px;
  justify-items: start;
}

.hooks-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.hooks-row {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.hooks-row-main {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.hooks-event {
  min-width: 0;
  color: var(--text-1);
  font-size: 13px;
  font-weight: 650;
  overflow-wrap: anywhere;
}

.hooks-enabled,
.hooks-target {
  min-width: 0;
  color: var(--text-3);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.error {
  margin: 0;
  color: var(--danger);
  font-size: 12px;
}
</style>
