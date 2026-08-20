<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { PhCircleNotch as CircleNotch, PhPuzzlePiece as PuzzlePiece } from '@phosphor-icons/vue'
import type { RuntimePluginDetail, RuntimePluginSummary } from '../../../shared/runtime-plugin'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'
import {
  applyPluginDetailIfCurrent,
  filterInstalledPlugins,
  pluginDisplayLabel
} from '../plugins-page'

const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const errorMessage = ref('')
const plugins = ref<RuntimePluginSummary[]>([])
const query = ref('')
const selectedPluginId = ref('')
const detail = ref<RuntimePluginDetail | null>(null)
const detailState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const detailError = ref('')

const filteredPlugins = computed(() => filterInstalledPlugins(plugins.value, query.value))

/** 只拉已安装摘要；启停要等设置写入 Grok 配置，本页只做禁用占位。 */
async function loadPlugins(): Promise<void> {
  loadState.value = 'loading'
  errorMessage.value = ''
  try {
    plugins.value = unwrapDesktopIpcResult(await window.app.listPlugins())
    loadState.value = 'ready'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
    loadState.value = 'error'
  }
}

/** 点一项再取详情；不预取路径、env 或 hook 命令。迟到响应不得覆盖当前选中项。 */
async function openPlugin(pluginId: string): Promise<void> {
  selectedPluginId.value = pluginId
  detailState.value = 'loading'
  detailError.value = ''
  try {
    const nextDetail = unwrapDesktopIpcResult(await window.app.getPlugin(pluginId))
    const applied = applyPluginDetailIfCurrent({
      selectedPluginId: selectedPluginId.value,
      requestedPluginId: pluginId,
      incoming: { ok: true, detail: nextDetail }
    })
    if (!applied.apply) return
    detail.value = applied.detail
    detailState.value = applied.detailState
    detailError.value = applied.detailError
  } catch (error) {
    const applied = applyPluginDetailIfCurrent({
      selectedPluginId: selectedPluginId.value,
      requestedPluginId: pluginId,
      incoming: {
        ok: false,
        errorMessage: error instanceof Error ? error.message : String(error)
      }
    })
    if (!applied.apply) return
    detail.value = applied.detail
    detailState.value = applied.detailState
    detailError.value = applied.detailError
  }
}

function statusLabel(status: RuntimePluginSummary['status']): string {
  if (status === 'enabled') return '已启用'
  if (status === 'disabled') return '已停用'
  return '无效'
}

onMounted(() => {
  void loadPlugins()
})
</script>

<template>
  <section class="plugins-page" aria-labelledby="plugins-page-title">
    <header class="plugins-header">
      <h1 id="plugins-page-title">
        <PuzzlePiece :size="16" />
        插件
      </h1>
      <p>只展示 Grok Build 已加载的安装项，不能从这里安装或卸载。</p>
      <label class="plugins-search">
        <span class="sr-only">搜索已安装插件</span>
        <input
          v-model="query"
          type="search"
          placeholder="搜索已安装插件"
          :disabled="loadState !== 'ready'"
        />
      </label>
    </header>

    <div v-if="loadState === 'loading'" class="plugins-state" role="status">
      <CircleNotch :size="18" class="spin" />
      正在加载插件
    </div>
    <div v-else-if="loadState === 'error'" class="plugins-state" role="alert">
      <p>{{ errorMessage || '插件列表加载失败。' }}</p>
      <button type="button" title="重试加载插件" aria-label="重试加载插件" @click="loadPlugins">
        重试
      </button>
    </div>
    <div v-else-if="plugins.length === 0" class="plugins-state" role="status">
      还没有已安装的插件。插件由 Grok Build 加载，本页只展示已安装项。
    </div>
    <div v-else class="plugins-body">
      <ul class="plugin-list" aria-label="已安装插件">
        <li v-if="filteredPlugins.length === 0" class="plugins-state">没有匹配的已安装插件。</li>
        <li v-for="plugin in filteredPlugins" :key="plugin.pluginId" class="plugin-item">
          <button
            class="plugin-main"
            type="button"
            :class="{ selected: plugin.pluginId === selectedPluginId }"
            :aria-current="plugin.pluginId === selectedPluginId ? 'true' : undefined"
            :title="pluginDisplayLabel(plugin)"
            @click="openPlugin(plugin.pluginId)"
          >
            <strong>{{ pluginDisplayLabel(plugin) }}</strong>
            <small>
              Skill {{ plugin.skillCount }} · MCP {{ plugin.mcpCount }} · Hooks
              {{ plugin.hookCount }}
            </small>
          </button>
          <input
            type="checkbox"
            class="plugin-enable"
            disabled
            :checked="plugin.status === 'enabled'"
            title="将在设置写入 Grok 配置后可用"
            aria-label="将在设置写入 Grok 配置后可用"
          />
        </li>
      </ul>

      <section class="plugin-detail" aria-live="polite">
        <p v-if="detailState === 'idle'" class="plugins-state">
          选择一个插件查看 Skill、MCP 与 Hooks 摘要。
        </p>
        <p v-else-if="detailState === 'loading'" class="plugins-state">正在读取插件详情…</p>
        <p v-else-if="detailState === 'error'" class="plugins-state" role="alert">
          {{ detailError || '插件详情加载失败。' }}
        </p>
        <template v-else-if="detail">
          <h2 :title="pluginDisplayLabel(detail)">{{ pluginDisplayLabel(detail) }}</h2>
          <p class="plugin-meta">
            {{ statusLabel(detail.status) }}
            <template v-if="detail.version"> · {{ detail.version }}</template>
          </p>
          <p v-if="detail.invalidReason" class="plugin-invalid">{{ detail.invalidReason }}</p>
          <h3>Skill</h3>
          <p v-if="detail.skillNames.length === 0">无</p>
          <ul v-else>
            <li v-for="name in detail.skillNames" :key="`skill-${name}`">{{ name }}</li>
          </ul>
          <h3>MCP</h3>
          <p v-if="detail.mcpNames.length === 0">无</p>
          <ul v-else>
            <li v-for="name in detail.mcpNames" :key="`mcp-${name}`">{{ name }}</li>
          </ul>
          <h3>Hooks</h3>
          <p v-if="detail.hookNames.length === 0">无</p>
          <ul v-else>
            <li v-for="name in detail.hookNames" :key="`hook-${name}`">{{ name }}</li>
          </ul>
        </template>
      </section>
    </div>
  </section>
</template>

<style scoped>
.plugins-page {
  display: flex;
  min-width: 0;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  color: var(--text-1);
  background: var(--app-bg);
}

.plugins-header {
  display: grid;
  gap: 8px;
  padding: 14px 18px 12px;
  border-bottom: 1px solid var(--border);
}

.plugins-header h1 {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}

.plugins-header p {
  margin: 0;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.45;
}

.plugins-search input {
  width: 100%;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  color: var(--text-1);
  background: var(--surface-2);
}

.plugins-body {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
}

.plugin-list,
.plugin-detail {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 10px;
  list-style: none;
}

.plugin-list {
  border-right: 1px solid var(--border);
}

.plugin-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.plugin-main {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 2px;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--radius-soft);
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.plugin-main.selected,
.plugin-main:hover {
  background: var(--hover-fill);
}

.plugin-main strong,
.plugin-detail h2 {
  overflow: hidden;
  font-size: 13px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-main small,
.plugin-meta {
  color: var(--text-3);
  font-size: 11px;
}

.plugin-enable {
  flex: 0 0 auto;
  accent-color: var(--accent);
  cursor: not-allowed;
}

.plugin-detail {
  display: grid;
  align-content: start;
  gap: 8px;
  padding: 16px 18px;
}

.plugin-detail h2,
.plugin-detail h3,
.plugin-detail p,
.plugin-detail ul {
  margin: 0;
}

.plugin-detail h3 {
  margin-top: 8px;
  color: var(--text-2);
  font-size: 12px;
}

.plugin-detail ul {
  padding-left: 18px;
  color: var(--text-2);
  font-size: 13px;
}

.plugin-invalid {
  color: var(--warning, #d9b25f);
  font-size: 12px;
}

.plugins-state {
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 8px;
  min-height: 120px;
  padding: 24px;
  color: var(--text-3);
  font-size: 13px;
  line-height: 1.55;
  text-align: center;
}

.plugins-state button {
  min-height: 28px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-chip);
  color: var(--text-1);
  background: var(--surface-2);
  cursor: pointer;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
