<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  PhCircleNotch as CircleNotch,
  PhCube as Cube,
  PhMagnifyingGlass as MagnifyingGlass,
  PhPlus as Plus,
  PhPuzzlePiece as PuzzlePiece
} from '@phosphor-icons/vue'
import type { MarketplacePluginSummary } from '../../../shared/runtime-marketplace-plugin'
import type { RuntimePluginDetail, RuntimePluginSummary } from '../../../shared/runtime-plugin'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'
import {
  OFFICIAL_MARKETPLACE_GIT_URL,
  PLUGIN_ADD_OFFICIAL_MARKETPLACE_COPY,
  PLUGIN_EMPTY_COPY,
  PLUGIN_ENABLE_TOGGLE_HINT,
  PLUGIN_GO_TO_MARKETPLACE_COPY,
  PLUGIN_INSTALL_SUCCESS_COPY,
  PLUGIN_INSTALLING_HINT_COPY,
  PLUGIN_PAGE_INTRO_COPY,
  buildPluginUninstallRequest,
  buildTrustedPluginInstallRequest,
  filterInstalledPlugins,
  filterMarketplacePlugins,
  filterPluginHubQuery,
  flattenPluginMcps,
  flattenPluginSkills,
  marketplaceDisplayLabel,
  marketplacePluginSubtitle,
  pluginDisplayLabel,
  pluginHubSubtitle,
  resolvePluginHubTab,
  resolvePluginPane,
  type PluginHubSkillRow,
  type PluginHubTab,
  type PluginPane
} from '../plugins-page'
import McpSettingsPanel from './McpSettingsPanel.vue'
import PluginTrustDialog from './PluginTrustDialog.vue'

const props = defineProps<{
  projectId?: string
  initialTab?: PluginHubTab
  initialPane?: PluginPane
}>()

const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const errorMessage = ref('')
const plugins = ref<RuntimePluginSummary[]>([])
const details = ref<RuntimePluginDetail[]>([])
const marketplacePlugins = ref<MarketplacePluginSummary[]>([])
const marketLoadState = ref<'loading' | 'ready' | 'error'>('loading')
const marketError = ref('')
const query = ref('')
const tab = ref<PluginHubTab>(resolvePluginHubTab(props.initialTab))
const pane = ref<PluginPane>(resolvePluginPane(props.initialPane))
const togglingId = ref('')
const toggleError = ref('')
const pendingInstall = ref<MarketplacePluginSummary | null>(null)
const installingName = ref('')
const uninstallingId = ref('')
const addingSource = ref(false)
const actionError = ref('')
const actionStatus = ref('')
const mcpPanel = ref<{ startCreate: () => void } | null>(null)
const userMcpCount = ref(0)
let loadGeneration = 0
let marketGeneration = 0

const pluginMcps = computed(() => flattenPluginMcps(details.value))
const skills = computed(() => flattenPluginSkills(details.value))
const filteredPlugins = computed(() => filterInstalledPlugins(plugins.value, query.value))
const filteredMarketplace = computed(() =>
  filterMarketplacePlugins(marketplacePlugins.value, query.value)
)
const filteredSkills = computed(() => filterPluginHubQuery(skills.value, query.value))
const mcpCount = computed(() => userMcpCount.value + pluginMcps.value.length)
const searchPlaceholder = computed(() => {
  if (tab.value === 'mcp') return '搜索 MCP 服务器'
  if (tab.value === 'skills') return '搜索技能'
  if (pane.value === 'marketplace') return '搜索市场插件'
  return '搜索插件'
})
const actionBusy = computed(
  () => Boolean(installingName.value) || Boolean(uninstallingId.value) || addingSource.value
)

watch(
  () => props.initialTab,
  (value) => {
    tab.value = resolvePluginHubTab(value)
  }
)

watch(
  () => props.initialPane,
  (value) => {
    pane.value = resolvePluginPane(value)
  }
)

watch(
  () => props.projectId,
  () => {
    if (loadState.value === 'ready') void loadHub()
  }
)

/** 列表失败不得本地乐观打勾；详情只用于摊平技能和插件 MCP。 */
async function loadHub(): Promise<void> {
  const generation = ++loadGeneration
  loadState.value = 'loading'
  errorMessage.value = ''
  try {
    const listed = unwrapDesktopIpcResult(await window.app.listPlugins())
    const nextDetails = await Promise.all(
      listed.map(async (plugin) => {
        try {
          return unwrapDesktopIpcResult(await window.app.getPlugin(plugin.pluginId))
        } catch {
          return null
        }
      })
    )
    if (generation !== loadGeneration) return
    plugins.value = listed
    details.value = nextDetails.filter((item): item is RuntimePluginDetail => item !== null)
    loadState.value = 'ready'
  } catch (error) {
    if (generation !== loadGeneration) return
    errorMessage.value = error instanceof Error ? error.message : String(error)
    loadState.value = 'error'
  }
}

/** 货架与已安装分开加载，避免市场失败把已装列表一起打挂。 */
async function loadMarketplace(): Promise<void> {
  const generation = ++marketGeneration
  marketLoadState.value = 'loading'
  marketError.value = ''
  try {
    const listed = unwrapDesktopIpcResult(await window.app.listMarketplacePlugins())
    if (generation !== marketGeneration) return
    marketplacePlugins.value = listed
    marketLoadState.value = 'ready'
  } catch (error) {
    if (generation !== marketGeneration) return
    marketError.value = error instanceof Error ? error.message : String(error)
    marketLoadState.value = 'error'
  }
}

async function togglePlugin(plugin: RuntimePluginSummary, enabled: boolean): Promise<void> {
  if (plugin.status === 'invalid' || togglingId.value) return
  togglingId.value = plugin.pluginId
  toggleError.value = ''
  try {
    unwrapDesktopIpcResult(await window.app.setPluginEnabled(plugin.pluginId, enabled))
    await loadHub()
  } catch (error) {
    toggleError.value = error instanceof Error ? error.message : String(error)
  } finally {
    togglingId.value = ''
  }
}

function switchTitle(enabled: boolean, extra?: string): string {
  const action = enabled ? '停用' : '启用'
  return extra ? `${action}。${extra}` : `${action}。${PLUGIN_ENABLE_TOGGLE_HINT}`
}

function toggleSkill(skill: PluginHubSkillRow): void {
  const plugin = plugins.value.find((item) => item.pluginId === skill.pluginId)
  if (!plugin) return
  void togglePlugin(plugin, !skill.enabled)
}

function openTrustDialog(plugin: MarketplacePluginSummary): void {
  if (plugin.installed || actionBusy.value) return
  actionError.value = ''
  pendingInstall.value = plugin
}

/** 确认框勾选后才走到这里；helper 再挡一道未信任请求。 */
async function confirmTrustedInstall(): Promise<void> {
  const request = buildTrustedPluginInstallRequest(pendingInstall.value, true)
  if (!request || installingName.value) return
  installingName.value = request.name
  actionError.value = ''
  actionStatus.value = ''
  try {
    unwrapDesktopIpcResult(await window.app.installPlugin(request.name, request.trust))
    actionStatus.value = PLUGIN_INSTALL_SUCCESS_COPY
    pendingInstall.value = null
    await Promise.all([loadHub(), loadMarketplace()])
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
  } finally {
    installingName.value = ''
  }
}

async function uninstallListedPlugin(plugin: RuntimePluginSummary): Promise<void> {
  const request = buildPluginUninstallRequest(plugin.pluginId, plugins.value)
  if (!request || actionBusy.value) return
  if (!window.confirm(`卸载插件「${pluginDisplayLabel(plugin)}」？`)) return
  uninstallingId.value = request.pluginId
  actionError.value = ''
  actionStatus.value = ''
  try {
    unwrapDesktopIpcResult(await window.app.uninstallPlugin(request.pluginId))
    await Promise.all([loadHub(), loadMarketplace()])
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
  } finally {
    uninstallingId.value = ''
  }
}

async function addOfficialMarketplace(): Promise<void> {
  if (actionBusy.value) return
  addingSource.value = true
  actionError.value = ''
  actionStatus.value = ''
  try {
    unwrapDesktopIpcResult(await window.app.addMarketplaceSource(OFFICIAL_MARKETPLACE_GIT_URL))
    await loadMarketplace()
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
  } finally {
    addingSource.value = false
  }
}

function installButtonTitle(plugin: MarketplacePluginSummary): string {
  if (plugin.installed) return '已安装'
  if (installingName.value === plugin.name) return '正在安装'
  return `安装 ${plugin.name}`
}

onMounted(() => {
  void loadHub()
  void loadMarketplace()
})
</script>

<template>
  <section class="plugins-page" aria-labelledby="plugins-page-title">
    <div class="plugins-shell">
      <header class="plugins-header">
        <div class="plugins-heading">
          <div>
            <h1 id="plugins-page-title">插件</h1>
            <p>{{ PLUGIN_PAGE_INTRO_COPY }}</p>
          </div>
          <button
            v-if="tab === 'mcp'"
            class="hub-primary"
            type="button"
            title="添加 MCP 服务器"
            @click="mcpPanel?.startCreate()"
          >
            <Plus :size="14" />
            添加
          </button>
        </div>

        <div class="plugins-toolbar">
          <div class="plugins-tabs" role="tablist" aria-label="插件分类">
            <button
              class="plugins-tab"
              type="button"
              role="tab"
              :aria-selected="tab === 'plugins'"
              @click="tab = 'plugins'"
            >
              插件 {{ plugins.length }}
            </button>
            <button
              class="plugins-tab"
              type="button"
              role="tab"
              :aria-selected="tab === 'mcp'"
              @click="tab = 'mcp'"
            >
              MCP {{ mcpCount }}
            </button>
            <button
              class="plugins-tab"
              type="button"
              role="tab"
              :aria-selected="tab === 'skills'"
              @click="tab = 'skills'"
            >
              技能 {{ skills.length }}
            </button>
          </div>
          <label class="plugins-search">
            <MagnifyingGlass :size="14" />
            <span class="sr-only">{{ searchPlaceholder }}</span>
            <input
              v-model="query"
              type="search"
              :placeholder="searchPlaceholder"
              :disabled="
                tab === 'plugins' && pane === 'marketplace'
                  ? marketLoadState !== 'ready'
                  : tab !== 'mcp' && loadState !== 'ready'
              "
            />
          </label>
        </div>
      </header>

      <div v-show="tab === 'plugins'">
        <div class="plugin-panes" role="tablist" aria-label="已安装与市场">
          <button
            class="plugins-tab"
            type="button"
            role="tab"
            :aria-selected="pane === 'installed'"
            title="已安装"
            @click="pane = 'installed'"
          >
            已安装
          </button>
          <button
            class="plugins-tab"
            type="button"
            role="tab"
            :aria-selected="pane === 'marketplace'"
            title="市场"
            @click="pane = 'marketplace'"
          >
            市场
          </button>
        </div>

        <p v-if="actionStatus" class="plugins-banner" role="status">{{ actionStatus }}</p>
        <p v-if="addingSource || installingName" class="plugins-banner" role="status">
          {{ PLUGIN_INSTALLING_HINT_COPY }}
        </p>
        <p v-if="actionError" class="plugins-banner is-error" role="alert">{{ actionError }}</p>

        <template v-if="pane === 'installed'">
          <div v-if="loadState === 'loading'" class="plugins-state" role="status">
            <CircleNotch :size="18" class="spin" />
            正在加载插件
          </div>
          <div v-else-if="loadState === 'error'" class="plugins-state" role="alert">
            <p>{{ errorMessage || '插件列表加载失败。' }}</p>
            <button
              class="hub-secondary"
              type="button"
              title="重试加载插件"
              aria-label="重试加载插件"
              @click="loadHub"
            >
              重试
            </button>
          </div>
          <div v-else-if="plugins.length === 0" class="plugins-state" role="status">
            <p>{{ PLUGIN_EMPTY_COPY }}</p>
            <button
              class="hub-primary"
              type="button"
              title="去市场看看"
              @click="pane = 'marketplace'"
            >
              {{ PLUGIN_GO_TO_MARKETPLACE_COPY }}
            </button>
          </div>
          <p v-else-if="filteredPlugins.length === 0" class="plugins-state">
            没有匹配的已安装插件。
          </p>
          <ul v-else class="hub-list" aria-label="已安装插件">
            <li v-for="plugin in filteredPlugins" :key="plugin.pluginId" class="hub-row">
              <span class="hub-icon" aria-hidden="true">
                <PuzzlePiece :size="18" />
              </span>
              <div class="hub-copy">
                <strong :title="pluginDisplayLabel(plugin)">{{
                  pluginDisplayLabel(plugin)
                }}</strong>
                <small>{{ pluginHubSubtitle(plugin) }}</small>
              </div>
              <div class="hub-actions">
                <button
                  class="hub-secondary"
                  type="button"
                  title="卸载插件"
                  aria-label="卸载插件"
                  :disabled="uninstallingId === plugin.pluginId || actionBusy"
                  @click="uninstallListedPlugin(plugin)"
                >
                  {{ uninstallingId === plugin.pluginId ? '正在卸载…' : '卸载' }}
                </button>
                <button
                  class="studio-switch"
                  type="button"
                  role="switch"
                  :aria-checked="plugin.status === 'enabled'"
                  :disabled="plugin.status === 'invalid' || togglingId === plugin.pluginId"
                  :title="switchTitle(plugin.status === 'enabled')"
                  :aria-label="switchTitle(plugin.status === 'enabled')"
                  @click="togglePlugin(plugin, plugin.status !== 'enabled')"
                />
              </div>
            </li>
          </ul>
        </template>

        <template v-else>
          <div v-if="marketLoadState === 'loading'" class="plugins-state" role="status">
            <CircleNotch :size="18" class="spin" />
            正在加载市场
          </div>
          <div v-else-if="marketLoadState === 'error'" class="plugins-state" role="alert">
            <p>{{ marketError || '市场货架加载失败。' }}</p>
            <button
              class="hub-secondary"
              type="button"
              title="重试加载市场"
              aria-label="重试加载市场"
              @click="loadMarketplace"
            >
              重试
            </button>
          </div>
          <div v-else-if="marketplacePlugins.length === 0" class="plugins-state" role="status">
            <p>还没有市场条目。添加官方市场后由 Grok 拉取货架。</p>
            <button
              class="hub-primary"
              type="button"
              title="添加官方市场"
              :disabled="addingSource"
              @click="addOfficialMarketplace"
            >
              {{ addingSource ? '正在添加…' : PLUGIN_ADD_OFFICIAL_MARKETPLACE_COPY }}
            </button>
          </div>
          <p v-else-if="filteredMarketplace.length === 0" class="plugins-state">
            没有匹配的市场插件。
          </p>
          <ul v-else class="hub-list" aria-label="市场插件">
            <li
              v-for="plugin in filteredMarketplace"
              :key="`${plugin.sourceName}:${plugin.name}`"
              class="hub-row"
            >
              <span class="hub-icon" aria-hidden="true">
                <PuzzlePiece :size="18" />
              </span>
              <div class="hub-copy">
                <strong :title="marketplaceDisplayLabel(plugin)">{{
                  marketplaceDisplayLabel(plugin)
                }}</strong>
                <small>{{ marketplacePluginSubtitle(plugin) || plugin.sourceName }}</small>
              </div>
              <span class="hub-origin">{{ plugin.sourceName }}</span>
              <button
                class="hub-primary"
                type="button"
                :title="installButtonTitle(plugin)"
                :aria-label="installButtonTitle(plugin)"
                :disabled="plugin.installed || actionBusy"
                @click="openTrustDialog(plugin)"
              >
                {{
                  plugin.installed
                    ? '已安装'
                    : installingName === plugin.name
                      ? '正在安装…'
                      : '安装'
                }}
              </button>
            </li>
          </ul>
        </template>
      </div>

      <McpSettingsPanel
        v-show="tab === 'mcp'"
        ref="mcpPanel"
        layout="hub"
        :project-id="projectId"
        :query="query"
        :plugin-servers="pluginMcps"
        @server-count="userMcpCount = $event"
      />

      <div v-show="tab === 'skills'">
        <div v-if="loadState === 'loading'" class="plugins-state" role="status">
          <CircleNotch :size="18" class="spin" />
          正在加载插件
        </div>
        <div v-else-if="loadState === 'error'" class="plugins-state" role="alert">
          <p>{{ errorMessage || '插件列表加载失败。' }}</p>
          <button
            class="hub-secondary"
            type="button"
            title="重试加载插件"
            aria-label="重试加载插件"
            @click="loadHub"
          >
            重试
          </button>
        </div>
        <p v-else-if="skills.length === 0" class="plugins-state" role="status">
          还没有技能。技能来自已安装插件，不能在桌面单独安装。
        </p>
        <p v-else-if="filteredSkills.length === 0" class="plugins-state">没有匹配的技能。</p>
        <ul v-else class="hub-list" aria-label="已安装技能">
          <li v-for="skill in filteredSkills" :key="skill.skillKey" class="hub-row">
            <span class="hub-icon" aria-hidden="true">
              <Cube :size="18" />
            </span>
            <div class="hub-copy">
              <strong :title="skill.name">{{ skill.name }}</strong>
              <small>{{ skill.description || `来自 ${skill.pluginLabel}` }}</small>
            </div>
            <span class="hub-origin">{{ skill.pluginLabel }}</span>
            <button
              class="studio-switch"
              type="button"
              role="switch"
              :aria-checked="skill.enabled"
              :disabled="skill.invalid || togglingId === skill.pluginId"
              :title="switchTitle(skill.enabled, `随所属插件启停。${PLUGIN_ENABLE_TOGGLE_HINT}`)"
              :aria-label="
                switchTitle(skill.enabled, `随所属插件启停。${PLUGIN_ENABLE_TOGGLE_HINT}`)
              "
              @click="toggleSkill(skill)"
            />
          </li>
        </ul>
      </div>
      <p v-if="toggleError" class="plugins-state" role="alert">{{ toggleError }}</p>
    </div>

    <PluginTrustDialog
      v-if="pendingInstall"
      :key="pendingInstall.name"
      :name="pendingInstall.name"
      :source-name="pendingInstall.sourceName"
      :busy="installingName === pendingInstall.name"
      @confirm="confirmTrustedInstall"
      @cancel="!installingName && (pendingInstall = null)"
    />
  </section>
</template>

<style scoped>
.plugins-page {
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: auto;
  color: var(--text-1);
  background: var(--app-bg);
}

.plugins-shell {
  width: min(840px, 100%);
  margin: 0 auto;
  padding: 28px 32px 48px;
}

.plugins-header {
  display: grid;
  gap: 22px;
  margin-bottom: 22px;
}

.plugins-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.plugins-heading h1,
.plugins-heading p {
  margin: 0;
}

.plugins-heading h1 {
  font-size: 28px;
  font-weight: 650;
  letter-spacing: -0.03em;
}

.plugins-heading p {
  margin-top: 6px;
  color: var(--text-3);
  font-size: 13px;
  line-height: 1.45;
}

.plugins-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.plugins-tabs,
.plugin-panes {
  display: flex;
  gap: 4px;
}

.plugin-panes {
  margin-bottom: 14px;
}

.plugins-tab {
  padding: 6px 10px;
  border: 0;
  border-radius: 10px;
  color: var(--text-3);
  background: transparent;
  font-size: 13px;
  cursor: pointer;
}

.plugins-tab[aria-selected='true'] {
  color: var(--text-1);
  background: var(--surface-2);
  box-shadow: 0 0 0 1px var(--border);
}

.plugins-search {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 220px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-chip);
  color: var(--text-3);
  background: var(--surface-2);
}

.plugins-search input {
  width: 160px;
  min-height: 34px;
  padding: 0;
  border: 0;
  color: var(--text-1);
  background: transparent;
}

.plugins-search input:focus {
  outline: 0;
}

.hub-list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.hub-row {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 64px;
  padding: 10px 4px;
}

.hub-icon {
  display: grid;
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text-2);
  background: var(--surface-2);
}

.hub-copy {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 3px;
}

.hub-copy strong,
.hub-origin {
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hub-copy small {
  overflow: hidden;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hub-origin {
  color: var(--text-3);
  font-size: 12px;
  font-weight: 500;
}

.hub-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
}

.plugins-banner {
  margin: 0 0 12px;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.5;
}

.plugins-banner.is-error {
  color: var(--fgColor-danger, #f85149);
}

.plugins-state {
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 8px;
  min-height: 160px;
  color: var(--text-3);
  font-size: 13px;
  line-height: 1.55;
  text-align: center;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}

@media (max-width: 720px) {
  .plugins-toolbar {
    flex-wrap: wrap;
  }

  .hub-origin {
    display: none;
  }
}
</style>
