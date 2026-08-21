<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { PhGear as Gear } from '@phosphor-icons/vue'
import type { McpServerSummary, McpTransportKind } from '../../../shared/mcp-server-config'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'
import { filterPluginHubQuery, type PluginHubMcpRow } from '../plugins-page'

const props = withDefaults(
  defineProps<{
    projectId?: string
    query?: string
    pluginServers?: PluginHubMcpRow[]
    layout?: 'page' | 'hub'
  }>(),
  {
    query: '',
    pluginServers: () => [],
    layout: 'page'
  }
)

const emit = defineEmits<{
  'server-count': [value: number]
}>()

const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const errorMessage = ref('')
const servers = ref<McpServerSummary[]>([])
const saving = ref(false)
const statusMessage = ref('')
const showForm = ref(false)
const name = ref('')
const transport = ref<McpTransportKind>('stdio')
const command = ref('')
const argsText = ref('')
const url = ref('')
const secret = ref('')
const enabled = ref(true)
const editingName = ref('')

const emptyCopy =
  '还没有用户级 MCP。添加后终端 Grok 也能用。本项目若在 .grok/config.toml 里配了服务器，会出现在列表里（只读）。'

const userServers = computed(() => servers.value.filter((item) => item.origin === 'user'))
const projectServers = computed(() => servers.value.filter((item) => item.origin === 'project'))
const filteredUserServers = computed(() => filterPluginHubQuery(userServers.value, props.query))
const filteredProjectServers = computed(() =>
  filterPluginHubQuery(projectServers.value, props.query)
)
const filteredPluginServers = computed(() => filterPluginHubQuery(props.pluginServers, props.query))
const visibleCount = computed(
  () =>
    filteredUserServers.value.length +
    filteredProjectServers.value.length +
    filteredPluginServers.value.length
)
const isEmpty = computed(
  () => userServers.value.length + projectServers.value.length + props.pluginServers.length === 0
)

watch(
  () => servers.value.length,
  (value) => emit('server-count', value)
)

async function loadServers(): Promise<void> {
  loadState.value = 'loading'
  errorMessage.value = ''
  try {
    servers.value = unwrapDesktopIpcResult(await window.app.listMcpServers(props.projectId))
    loadState.value = 'ready'
    emit('server-count', servers.value.length)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
    loadState.value = 'error'
  }
}

function startCreate(): void {
  showForm.value = true
  editingName.value = ''
  name.value = ''
  transport.value = 'stdio'
  command.value = ''
  argsText.value = ''
  url.value = ''
  secret.value = ''
  enabled.value = true
  statusMessage.value = ''
}

function startEdit(server: McpServerSummary): void {
  if (server.origin !== 'user') return
  showForm.value = true
  editingName.value = server.name
  name.value = server.name
  transport.value = server.transport
  command.value = server.command ?? ''
  argsText.value = ''
  url.value = server.url ?? ''
  secret.value = ''
  enabled.value = server.enabled
  statusMessage.value = ''
}

async function saveServer(): Promise<void> {
  saving.value = true
  errorMessage.value = ''
  try {
    const args = argsText.value
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean)
    const input = {
      name: name.value.trim(),
      enabled: enabled.value,
      transport: transport.value,
      ...(transport.value === 'stdio'
        ? { command: command.value.trim(), args }
        : { url: url.value.trim() }),
      ...(secret.value.trim()
        ? transport.value === 'stdio'
          ? { env: { API_KEY: secret.value.trim() } }
          : { headers: { Authorization: secret.value.trim() } }
        : {})
    }
    unwrapDesktopIpcResult(await window.app.upsertMcpServer(input))
    showForm.value = false
    secret.value = ''
    statusMessage.value =
      '已保存。与终端 Grok 共用用户级服务器。当前对话不会热重载，新 Task 或重新进入后由 Grok 连接。'
    await loadServers()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}

async function toggleEnabled(server: McpServerSummary): Promise<void> {
  if (server.origin !== 'user') return
  try {
    unwrapDesktopIpcResult(
      await window.app.upsertMcpServer({
        name: server.name,
        enabled: !server.enabled,
        transport: server.transport,
        ...(server.command ? { command: server.command } : {}),
        ...(server.url ? { url: server.url } : {})
      })
    )
    await loadServers()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

async function removeServer(server: McpServerSummary): Promise<void> {
  if (server.origin !== 'user') return
  if (!window.confirm(`删除 MCP「${server.name}」？终端 Grok 也会去掉这一项。`)) return
  try {
    unwrapDesktopIpcResult(await window.app.deleteMcpServer(server.name))
    if (editingName.value === server.name) showForm.value = false
    await loadServers()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

function originLabel(origin: McpServerSummary['origin']): string {
  return origin === 'project' ? '本项目' : '用户'
}

function deleteEditing(): void {
  const server = userServers.value.find((item) => item.name === editingName.value)
  if (server) void removeServer(server)
}

watch(
  () => props.projectId,
  () => {
    void loadServers()
  }
)

onMounted(() => {
  void loadServers()
})

defineExpose({ startCreate })
</script>

<template>
  <section class="mcp-pane" :class="{ hub: layout === 'hub' }" aria-labelledby="mcp-title">
    <header v-if="layout !== 'hub'">
      <h3 id="mcp-title">MCP</h3>
      <p>与 Grok Build TUI 共用用户级 MCP。由 Grok 连接，Agent Studio 不自己执行。</p>
    </header>
    <h3 v-else id="mcp-title" class="sr-only">MCP</h3>

    <div v-if="loadState === 'loading'" class="state">正在加载 MCP…</div>
    <div v-else-if="loadState === 'error'" class="state" role="alert">
      <p>{{ errorMessage || 'MCP 列表加载失败。' }}</p>
      <button
        class="hub-secondary"
        type="button"
        title="重试加载 MCP"
        aria-label="重试加载 MCP"
        @click="loadServers"
      >
        重试
      </button>
    </div>
    <template v-else>
      <p v-if="isEmpty && !showForm" class="state">{{ emptyCopy }}</p>
      <p v-else-if="visibleCount === 0 && !showForm" class="state">没有匹配的 MCP 服务器。</p>
      <template v-else>
        <div v-if="filteredUserServers.length > 0" class="mcp-group">
          <h4>服务器</h4>
          <ul class="mcp-card">
            <li v-for="server in filteredUserServers" :key="`user-${server.name}`">
              <div class="mcp-copy">
                <strong>{{ server.name }}</strong>
                <small>
                  {{ server.transport }} · {{ originLabel(server.origin) }}
                  <template v-if="server.hasSecret"> · 已保存密钥</template>
                  <template v-if="!server.enabled"> · 已停用</template>
                </small>
                <small v-if="server.lastError" class="error">{{ server.lastError }}</small>
              </div>
              <button
                class="icon-button"
                type="button"
                title="编辑"
                aria-label="编辑"
                @click="startEdit(server)"
              >
                <Gear :size="16" />
              </button>
              <button
                class="studio-switch"
                type="button"
                role="switch"
                :aria-checked="server.enabled"
                :title="server.enabled ? '停用' : '启用'"
                :aria-label="server.enabled ? '停用' : '启用'"
                @click="toggleEnabled(server)"
              />
            </li>
          </ul>
        </div>

        <div v-if="filteredProjectServers.length > 0" class="mcp-group">
          <h4>本项目</h4>
          <ul class="mcp-card">
            <li v-for="server in filteredProjectServers" :key="`project-${server.name}`">
              <div class="mcp-copy">
                <strong>{{ server.name }}</strong>
                <small>{{ server.transport }} · 只读</small>
                <small class="hint">改这个文件会进 git，请在仓库里改或复制到用户级。</small>
              </div>
            </li>
          </ul>
        </div>

        <div v-if="filteredPluginServers.length > 0" class="mcp-group">
          <h4>来自插件</h4>
          <ul class="mcp-card">
            <li
              v-for="server in filteredPluginServers"
              :key="`plugin-${server.pluginId}-${server.name}`"
            >
              <div class="mcp-copy">
                <strong>{{ server.name }}</strong>
                <small>来自 {{ server.pluginLabel }}</small>
              </div>
            </li>
          </ul>
        </div>
      </template>

      <form v-if="showForm" class="mcp-form" @submit.prevent="saveServer">
        <label>
          名称
          <input v-model="name" :disabled="Boolean(editingName)" required maxlength="32" />
        </label>
        <label>
          传输
          <select v-model="transport">
            <option value="stdio">stdio</option>
            <option value="http">http</option>
          </select>
        </label>
        <label v-if="transport === 'stdio'">
          可执行文件（绝对路径）
          <input v-model="command" required />
        </label>
        <label v-if="transport === 'stdio'">
          参数（每行一个）
          <textarea v-model="argsText" rows="3" />
        </label>
        <label v-else>
          URL
          <input v-model="url" required />
        </label>
        <label>
          {{ transport === 'stdio' ? '环境变量密钥' : 'Authorization' }}
          <input v-model="secret" :placeholder="editingName ? '已保存' : ''" autocomplete="off" />
        </label>
        <label class="toggle">
          <input v-model="enabled" type="checkbox" />
          启用
        </label>
        <p class="hint">密钥保存后只显示「已保存」，不会写进 App config.toml。</p>
        <div class="actions">
          <button class="hub-primary" type="submit" :disabled="saving">
            {{ saving ? '保存中…' : '保存' }}
          </button>
          <button class="hub-secondary" type="button" @click="showForm = false">取消</button>
          <button v-if="editingName" class="text-danger" type="button" @click="deleteEditing">
            删除
          </button>
        </div>
      </form>
      <p v-if="statusMessage" class="success">{{ statusMessage }}</p>
      <p v-if="errorMessage && loadState === 'ready'" class="error" role="alert">
        {{ errorMessage }}
      </p>
    </template>
  </section>
</template>

<style scoped>
.mcp-pane {
  display: grid;
  gap: 16px;
  align-content: start;
}

.mcp-pane.hub {
  padding-top: 4px;
}

header h3,
header p,
.state,
.hint,
.success,
.error,
small,
h4 {
  margin: 0;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.5;
}

header h3 {
  color: var(--text-1);
  font-size: 16px;
}

h4 {
  margin-bottom: 8px;
  color: var(--text-1);
  font-size: 13px;
  font-weight: 650;
}

.mcp-group {
  display: grid;
  gap: 8px;
}

.mcp-card {
  margin: 0;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface-2);
  list-style: none;
}

.mcp-card li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  min-height: 56px;
  padding: 8px 4px;
}

.mcp-card li + li {
  border-top: 1px solid var(--border);
}

.mcp-copy {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.mcp-copy strong {
  overflow: hidden;
  color: var(--text-1);
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

input,
select,
textarea {
  width: 100%;
  min-height: 36px;
  padding: 6px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  color: var(--text-1);
  background: var(--app-bg);
}

.mcp-form,
.mcp-form label {
  display: grid;
  gap: 6px;
}

.mcp-form {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface-2);
}

.toggle {
  display: flex;
  align-items: center;
  gap: 8px;
}

.text-danger {
  margin-left: auto;
  border: 0;
  color: var(--danger);
  background: transparent;
  cursor: pointer;
}

.error {
  color: var(--danger);
}

.success {
  color: var(--success);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}
</style>
