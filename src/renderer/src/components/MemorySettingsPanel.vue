<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type {
  GrokMemoryDocument,
  GrokMemoryShareStatus,
  GrokMemorySummary
} from '../../../shared/grok-memory'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'
import {
  formatMemoryItemSubtitle,
  formatMemoryItemTitle,
  formatMemoryKindLabel,
  formatProjectKey,
  groupProjectMemories,
  type MemoryProjectGroup
} from '../memory-settings'
import AssistantMarkdown from './AssistantMarkdown.vue'

const props = defineProps<{
  selectedTaskId?: string
  grokActionsAvailable?: boolean
  projectHint?: string
}>()

const emit = defineEmits<{
  dirty: [value: boolean]
  'start-turn': [command: string]
}>()

const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const errorMessage = ref('')
const enabled = ref(true)
const shareStatus = ref<GrokMemoryShareStatus>('linked')
const memories = ref<GrokMemorySummary[]>([])
const selectedId = ref('')
const document = ref<GrokMemoryDocument | null>(null)
const draft = ref('')
const savedDraft = ref('')
const saving = ref(false)
const statusMessage = ref('')
const toggling = ref(false)
const expandedProjectKeys = ref<string[]>([])
/** 默认渲染 Markdown；改文字时才切回源码。 */
const editingSource = ref(false)

const dirty = computed(() => Boolean(document.value) && draft.value !== savedDraft.value)
const truncated = computed(() => document.value?.truncated === true)
const globalMemories = computed(() => memories.value.filter((item) => item.scope === 'global'))
const projectGroups = computed(() => groupProjectMemories(memories.value))
const currentProject = computed(() => projectGroups.value.find((group) => group.isCurrent) ?? null)
const otherProjects = computed(() => projectGroups.value.filter((group) => !group.isCurrent))
const longTermItems = computed(() => {
  const items = [...globalMemories.value]
  if (currentProject.value?.project) items.push(currentProject.value.project)
  return items
})
const currentSessions = computed(() => currentProject.value?.sessions ?? [])
const canRunGrokActions = computed(() =>
  Boolean(props.grokActionsAvailable && props.selectedTaskId)
)
const editorTitle = computed(() => (document.value ? formatMemoryItemTitle(document.value) : ''))
const editorSubtitle = computed(() => {
  const item = memories.value.find((entry) => entry.memoryId === selectedId.value)
  if (!item) return '本地保存，不依赖当前对话。'
  const when = formatMemoryItemSubtitle(item)
  return `${formatMemoryKindLabel(item.scope)} · ${when}`
})

watch(dirty, (value) => emit('dirty', value))
watch(
  () => props.projectHint,
  () => {
    if (loadState.value === 'ready') void refreshList()
  }
)

async function loadAll(): Promise<void> {
  loadState.value = 'loading'
  errorMessage.value = ''
  try {
    const [state, list] = await Promise.all([
      unwrapDesktopIpcResult(await window.app.getMemoryEnabled()),
      unwrapDesktopIpcResult(await window.app.listMemories(props.projectHint))
    ])
    enabled.value = state.enabled
    shareStatus.value = state.shareStatus
    memories.value = list
    expandedProjectKeys.value = groupProjectMemories(list)
      .filter((group) => group.isCurrent)
      .map((group) => group.projectKey)
    loadState.value = 'ready'
    if (selectedId.value && list.some((item) => item.memoryId === selectedId.value)) {
      await openMemory(selectedId.value)
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
    loadState.value = 'error'
  }
}

async function toggleEnabled(next: boolean): Promise<void> {
  toggling.value = true
  try {
    const state = unwrapDesktopIpcResult(await window.app.setMemoryEnabled(next))
    enabled.value = state.enabled
    shareStatus.value = state.shareStatus
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    toggling.value = false
  }
}

async function openMemory(memoryId: string): Promise<void> {
  if (dirty.value && !window.confirm('有未保存的更改，确定离开？')) return
  selectedId.value = memoryId
  statusMessage.value = ''
  try {
    const next = unwrapDesktopIpcResult(await window.app.getMemory(memoryId))
    document.value = next
    draft.value = next.markdown
    savedDraft.value = next.markdown
    editingSource.value = false
    if (next.projectKey) expandProject(next.projectKey)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}

async function saveDraft(): Promise<void> {
  if (!document.value || truncated.value || !dirty.value) return
  saving.value = true
  try {
    const saved = unwrapDesktopIpcResult(
      await window.app.saveMemory(document.value.memoryId, draft.value)
    )
    document.value = saved
    savedDraft.value = saved.markdown
    editingSource.value = false
    statusMessage.value = '已保存到共享记忆目录。'
    await refreshList()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}

function discardDraft(): void {
  draft.value = savedDraft.value
  editingSource.value = false
}

function showMemoryPreview(): void {
  editingSource.value = false
}

function showMemorySource(): void {
  if (truncated.value) return
  editingSource.value = true
}

async function deleteSelected(): Promise<void> {
  if (document.value?.scope !== 'session') return
  if (!window.confirm('删除这条会话摘要？')) return
  unwrapDesktopIpcResult(await window.app.deleteMemory(document.value.memoryId))
  document.value = null
  draft.value = ''
  savedDraft.value = ''
  selectedId.value = ''
  await refreshList()
}

async function refreshList(): Promise<void> {
  memories.value = unwrapDesktopIpcResult(await window.app.listMemories(props.projectHint))
}

function isProjectOpen(group: MemoryProjectGroup): boolean {
  return expandedProjectKeys.value.includes(group.projectKey)
}

function expandProject(projectKey: string): void {
  if (expandedProjectKeys.value.includes(projectKey)) return
  expandedProjectKeys.value = [...expandedProjectKeys.value, projectKey]
}

function toggleProject(projectKey: string): void {
  expandedProjectKeys.value = expandedProjectKeys.value.includes(projectKey)
    ? expandedProjectKeys.value.filter((key) => key !== projectKey)
    : [...expandedProjectKeys.value, projectKey]
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    void saveDraft()
  }
}

onMounted(() => {
  void loadAll()
})
</script>

<template>
  <section class="memory-pane" aria-labelledby="memory-title" @keydown="onKeydown">
    <div class="memory-top">
      <header class="memory-header">
        <div>
          <h3 id="memory-title">记忆</h3>
          <p>和终端 Grok 共用同一份笔记。</p>
        </div>
        <div class="enable-control">
          <span>
            <strong>跨会话记忆</strong>
            <small>关闭后不能 /remember、/flush、/dream</small>
          </span>
          <button
            class="studio-switch"
            type="button"
            role="switch"
            :aria-checked="enabled"
            :disabled="toggling || loadState !== 'ready'"
            title="启用跨会话记忆"
            aria-label="启用跨会话记忆"
            @click="toggleEnabled(!enabled)"
          />
        </div>
      </header>
      <p v-if="shareStatus === 'skipped-existing'" class="warning" role="status">
        未与终端共享：App grok-home 里已有独立记忆文件。
      </p>
    </div>

    <div v-if="loadState === 'loading'" class="state">正在加载记忆…</div>
    <div v-else-if="loadState === 'error'" class="state" role="alert">
      <p>{{ errorMessage || '记忆加载失败。' }}</p>
      <button
        class="hub-secondary"
        type="button"
        title="重试加载记忆"
        aria-label="重试加载记忆"
        @click="loadAll"
      >
        重试
      </button>
    </div>
    <div v-else class="memory-body">
      <aside class="memory-list" aria-label="记忆目录">
        <p v-if="memories.length === 0" class="list-empty">
          还没有笔记。开着跨会话记忆，让 Grok 在对话里记住。
        </p>
        <template v-else>
          <section v-if="longTermItems.length" class="memory-section">
            <h4>长期笔记</h4>
            <p class="section-kicker">跨对话保留</p>
            <button
              v-for="item in longTermItems"
              :key="item.memoryId"
              type="button"
              class="memory-item"
              :class="{ selected: item.memoryId === selectedId }"
              :title="item.title"
              :aria-current="item.memoryId === selectedId ? 'true' : undefined"
              @click="openMemory(item.memoryId)"
            >
              <span class="kind-tag" :data-kind="item.scope">{{
                formatMemoryKindLabel(item.scope)
              }}</span>
              <span class="memory-copy">
                <strong>{{ formatMemoryItemTitle(item) }}</strong>
                <small>{{ formatMemoryItemSubtitle(item) }}</small>
              </span>
            </button>
          </section>

          <section v-if="currentSessions.length" class="memory-section">
            <h4>会话摘要</h4>
            <p class="section-kicker">单场备忘，可删</p>
            <button
              v-for="session in currentSessions"
              :key="session.memoryId"
              type="button"
              class="memory-item"
              :class="{ selected: session.memoryId === selectedId }"
              :title="session.title"
              :aria-current="session.memoryId === selectedId ? 'true' : undefined"
              @click="openMemory(session.memoryId)"
            >
              <span class="kind-tag" data-kind="session">{{
                formatMemoryKindLabel('session')
              }}</span>
              <span class="memory-copy">
                <strong>{{ formatMemoryItemTitle(session) }}</strong>
                <small>{{ formatMemoryItemSubtitle(session) }}</small>
              </span>
            </button>
          </section>

          <section v-if="otherProjects.length" class="memory-section">
            <h4>其它项目</h4>
            <div v-for="group in otherProjects" :key="group.projectKey" class="project-block">
              <button
                class="project-heading"
                type="button"
                :aria-expanded="isProjectOpen(group)"
                :title="group.projectKey"
                :aria-label="`${isProjectOpen(group) ? '收起' : '展开'} ${formatProjectKey(group.projectKey)}`"
                @click="toggleProject(group.projectKey)"
              >
                <span class="chevron" :data-open="isProjectOpen(group) ? 'true' : undefined"
                  >▸</span
                >
                <span>{{ formatProjectKey(group.projectKey) }}</span>
                <small v-if="group.sessions.length">{{ group.sessions.length }}</small>
              </button>
              <div v-if="isProjectOpen(group)" class="project-children">
                <button
                  v-if="group.project"
                  type="button"
                  class="memory-item"
                  :class="{ selected: group.project.memoryId === selectedId }"
                  :title="group.project.title"
                  :aria-current="group.project.memoryId === selectedId ? 'true' : undefined"
                  @click="openMemory(group.project.memoryId)"
                >
                  <span class="kind-tag" data-kind="project">{{
                    formatMemoryKindLabel('project')
                  }}</span>
                  <span class="memory-copy">
                    <strong>{{ formatMemoryItemTitle(group.project) }}</strong>
                    <small>{{ formatMemoryItemSubtitle(group.project) }}</small>
                  </span>
                </button>
                <button
                  v-for="session in group.sessions"
                  :key="session.memoryId"
                  type="button"
                  class="memory-item"
                  :class="{ selected: session.memoryId === selectedId }"
                  :title="session.title"
                  :aria-current="session.memoryId === selectedId ? 'true' : undefined"
                  @click="openMemory(session.memoryId)"
                >
                  <span class="kind-tag" data-kind="session">{{
                    formatMemoryKindLabel('session')
                  }}</span>
                  <span class="memory-copy">
                    <strong>{{ formatMemoryItemTitle(session) }}</strong>
                    <small>{{ formatMemoryItemSubtitle(session) }}</small>
                  </span>
                </button>
              </div>
            </div>
          </section>
        </template>
      </aside>

      <div class="memory-editor">
        <template v-if="document">
          <div class="editor-frame">
            <div class="editor-bar">
              <div class="editor-copy">
                <strong>{{ editorTitle }}</strong>
                <small>{{ editorSubtitle }}</small>
              </div>
              <span v-if="dirty" class="dirty-dot" title="未保存" />
              <button
                class="hub-secondary"
                type="button"
                :aria-pressed="!editingSource ? 'true' : 'false'"
                title="查看渲染"
                aria-label="查看渲染"
                @click="showMemoryPreview"
              >
                预览
              </button>
              <button
                class="hub-secondary"
                type="button"
                :disabled="truncated"
                :aria-pressed="editingSource ? 'true' : 'false'"
                title="编辑源码"
                aria-label="编辑源码"
                @click="showMemorySource"
              >
                编辑
              </button>
              <button
                class="hub-primary"
                type="button"
                title="保存记忆"
                :disabled="!dirty || truncated || saving"
                @click="saveDraft"
              >
                {{ saving ? '保存中…' : '保存' }}
              </button>
              <button
                class="hub-secondary"
                type="button"
                title="放弃未保存"
                :disabled="!dirty || saving"
                @click="discardDraft"
              >
                放弃
              </button>
              <button
                v-if="document.scope === 'session'"
                class="text-danger"
                type="button"
                title="删除会话摘要"
                @click="deleteSelected"
              >
                删除
              </button>
            </div>
            <div v-if="!editingSource" class="memory-preview">
              <AssistantMarkdown :text="draft" />
            </div>
            <textarea
              v-else
              v-model="draft"
              spellcheck="false"
              :disabled="truncated"
              aria-label="记忆 Markdown 源码"
            />
          </div>
        </template>
        <div v-else class="editor-empty">
          <strong>还没打开记忆</strong>
          <p>从左侧选一条。本地保存不依赖当前对话。</p>
        </div>
        <!-- 底栏占固定高度，避免空状态 min-height:100% 把提示裁出圆角区域。 -->
        <div class="editor-footer">
          <p v-if="truncated" class="warning">文件过大，不能在此覆盖。</p>
          <div v-if="canRunGrokActions" class="grok-actions">
            <span>让 Grok</span>
            <button
              class="text-action"
              type="button"
              title="在当前对话执行 /remember"
              @click="emit('start-turn', '/remember')"
            >
              记住
            </button>
            <button
              class="text-action"
              type="button"
              title="在当前对话执行 /flush"
              @click="emit('start-turn', '/flush')"
            >
              保存任务
            </button>
            <button
              class="text-action"
              type="button"
              title="在当前对话执行 /dream"
              @click="emit('start-turn', '/dream')"
            >
              整理
            </button>
          </div>
          <p v-else class="hint">打开一个对话后，可以让 Grok 记住、保存任务或整理。</p>
          <p v-if="statusMessage" class="success">{{ statusMessage }}</p>
          <p v-if="errorMessage && loadState === 'ready'" class="warning" role="alert">
            {{ errorMessage }}
          </p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.memory-pane {
  display: grid;
  min-height: 0;
  height: 100%;
  gap: 12px;
  grid-template-rows: auto minmax(0, 1fr);
}

.memory-top {
  display: grid;
  gap: 8px;
}

.memory-body {
  display: grid;
  min-height: 0;
  overflow: hidden;
  grid-template-columns: 252px minmax(0, 1fr);
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--app-bg);
}

.memory-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.memory-header h3,
.memory-header p,
.state,
.warning,
.success,
.hint,
.enable-control small,
.editor-empty p {
  margin: 0;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.5;
}

.memory-header h3 {
  color: var(--text-1);
  font-size: 16px;
}

.enable-control {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.enable-control span {
  display: grid;
  gap: 2px;
  text-align: right;
}

.enable-control strong {
  color: var(--text-1);
  font-size: 12px;
}

.enable-control small {
  font-size: 11px;
}

.warning {
  color: var(--danger);
}

.success {
  color: var(--success);
}

.memory-list,
.memory-editor {
  min-width: 0;
  min-height: 0;
}

.memory-list {
  display: grid;
  align-content: start;
  gap: 8px;
  overflow: auto;
  padding: 12px;
  border-right: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface-1) 88%, var(--app-bg));
}

.memory-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
  padding: 12px;
}

.editor-frame,
.editor-empty {
  min-height: 0;
  flex: 1 1 0;
}

.list-empty,
.editor-empty {
  display: grid;
  gap: 8px;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.55;
}

.editor-empty {
  place-content: center;
  justify-items: start;
  padding: 8px 4px;
}

/* 记住 / 整理提示必须完整可见，不能被上方编辑区挤出。 */
.editor-footer {
  flex: 0 0 auto;
  display: grid;
  gap: 6px;
  overflow-wrap: anywhere;
}

.editor-empty strong {
  color: var(--text-1);
  font-size: 14px;
}

.memory-section,
.project-block,
.project-children {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.memory-section {
  gap: 6px;
}

.section-kicker {
  margin: 0;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.3;
}

.memory-item,
.project-heading {
  display: grid;
  gap: 2px;
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  color: var(--text-1);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.memory-item {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}

.kind-tag {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  color: var(--text-3);
  background: color-mix(in srgb, var(--surface-3) 70%, transparent);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.02em;
  line-height: 1.5;
}

.kind-tag[data-kind='global'] {
  color: var(--accent);
}

.kind-tag[data-kind='project'] {
  color: var(--text-2);
}

.memory-copy {
  display: grid;
  min-width: 0;
  gap: 1px;
}

.project-heading {
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 650;
}

.project-heading span,
.project-heading small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-heading small {
  color: var(--text-3);
  font-size: 11px;
  font-weight: 500;
}

.chevron {
  flex: 0 0 auto;
  color: var(--text-3);
  font-size: 10px;
  line-height: 1;
  transition: transform 120ms ease;
}

.chevron[data-open='true'] {
  transform: rotate(90deg);
}

.memory-item:hover,
.memory-item.selected,
.project-heading:hover {
  background: var(--hover-fill);
}

.memory-item.selected {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}

.memory-item strong,
.memory-item small,
.memory-copy strong,
.memory-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.memory-item strong {
  font-size: 13px;
  font-weight: 650;
}

.memory-item small {
  color: var(--text-3);
  font-size: 11px;
}

.editor-frame {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-2);
}

.editor-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.editor-copy {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 1px;
}

.editor-copy strong,
.editor-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-copy strong {
  font-size: 13px;
}

.editor-copy small,
.hint {
  color: var(--text-3);
  font-size: 11px;
}

.dirty-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
}

.memory-preview {
  min-height: 0;
  overflow: auto;
  padding: 12px 16px 16px;
}

.memory-preview :deep(.assistant-markdown) {
  font-size: 13px;
}

.hub-secondary[aria-pressed='true'] {
  color: var(--text-1);
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  background: color-mix(in srgb, var(--accent) 10%, var(--surface-2));
}

textarea {
  width: 100%;
  min-height: 0;
  height: 100%;
  padding: 12px;
  border: 0;
  color: var(--text-1);
  background: transparent;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  resize: none;
}

.grok-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  color: var(--text-3);
  font-size: 12px;
}

.text-action,
.text-danger {
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.text-action {
  color: var(--text-2);
  font-size: 12px;
  font-weight: 650;
}

.text-action:hover {
  color: var(--text-1);
}

.text-danger {
  color: var(--danger);
  font-size: 12px;
}

h4 {
  margin: 0;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.04em;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

@media (prefers-reduced-motion: reduce) {
  .memory-item,
  .project-heading,
  .chevron {
    transition: none;
  }
}
</style>
