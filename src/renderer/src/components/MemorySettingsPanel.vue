<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type {
  GrokMemoryDocument,
  GrokMemoryShareStatus,
  GrokMemorySummary
} from '../../../shared/grok-memory'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'

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

const dirty = computed(() => Boolean(document.value) && draft.value !== savedDraft.value)
const truncated = computed(() => document.value?.truncated === true)
const globalMemories = computed(() => memories.value.filter((item) => item.scope === 'global'))
const projectGroups = computed(() => {
  const groups = new Map<string, GrokMemorySummary[]>()
  for (const item of memories.value) {
    if (item.scope === 'global' || !item.projectKey) continue
    const list = groups.get(item.projectKey) ?? []
    list.push(item)
    groups.set(item.projectKey, list)
  }
  return [...groups.entries()].map(([projectKey, items]) => ({
    projectKey,
    isCurrent: items.some((item) => item.isCurrentProject),
    project: items.find((item) => item.scope === 'project'),
    sessions: items.filter((item) => item.scope === 'session')
  }))
})
const canCreateProject = computed(() =>
  projectGroups.value.some((group) => group.isCurrent && group.project)
)

watch(dirty, (value) => emit('dirty', value))

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
}

async function createMemory(scope: 'global' | 'project'): Promise<void> {
  const memoryId =
    scope === 'project'
      ? projectGroups.value.find((group) => group.isCurrent)?.project?.memoryId
      : 'global/MEMORY.md'
  if (!memoryId) {
    const created = unwrapDesktopIpcResult(await window.app.saveMemory('global/MEMORY.md', ''))
    memories.value = unwrapDesktopIpcResult(await window.app.listMemories(props.projectHint))
    await openMemory(created.memoryId)
    return
  }
  try {
    await window.app.getMemory(memoryId)
  } catch {
    unwrapDesktopIpcResult(await window.app.saveMemory(memoryId, ''))
    memories.value = unwrapDesktopIpcResult(await window.app.listMemories(props.projectHint))
  }
  await openMemory(memoryId)
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
    <header>
      <h3 id="memory-title">记忆</h3>
      <p>与 Grok Build TUI 共用 <code>~/.grok/memory</code>，全局和项目记忆都会两边看见。</p>
    </header>

    <p v-if="shareStatus === 'skipped-existing'" class="warning" role="status">
      未与 TUI 共享：App grok-home 已有独立记忆文件。
    </p>

    <label class="toggle">
      <input
        type="checkbox"
        :checked="enabled"
        :disabled="toggling || loadState !== 'ready'"
        @change="toggleEnabled(($event.target as HTMLInputElement).checked)"
      />
      启用跨会话记忆
    </label>

    <div v-if="loadState === 'loading'" class="state">正在加载记忆…</div>
    <div v-else-if="loadState === 'error'" class="state" role="alert">
      <p>{{ errorMessage || '记忆加载失败。' }}</p>
      <button type="button" title="重试加载记忆" aria-label="重试加载记忆" @click="loadAll">
        重试
      </button>
    </div>
    <div v-else class="memory-body">
      <div class="memory-list">
        <div class="list-actions">
          <button type="button" title="新建全局记忆" @click="createMemory('global')">写全局</button>
          <button
            type="button"
            title="新建本项目记忆"
            :disabled="!canCreateProject"
            @click="createMemory('project')"
          >
            写本项目
          </button>
        </div>
        <p v-if="memories.length === 0" class="state">
          还没有记忆。可以在这里直接写，或开着记忆让 Grok 在对话里记住。全局和项目内容都与终端 Grok
          共用。
        </p>
        <template v-else>
          <h4>全局</h4>
          <button
            v-for="item in globalMemories"
            :key="item.memoryId"
            type="button"
            class="memory-item"
            :class="{ selected: item.memoryId === selectedId }"
            @click="openMemory(item.memoryId)"
          >
            {{ item.title }}
          </button>
          <h4>项目</h4>
          <div v-for="group in projectGroups" :key="group.projectKey" class="project-group">
            <p>
              {{ group.projectKey }}
              <span v-if="group.isCurrent">本项目</span>
            </p>
            <button
              v-if="group.project"
              type="button"
              class="memory-item"
              :class="{ selected: group.project.memoryId === selectedId }"
              @click="openMemory(group.project.memoryId)"
            >
              {{ group.project.title }}
            </button>
            <button
              v-for="session in group.sessions"
              :key="session.memoryId"
              type="button"
              class="memory-item session"
              :class="{ selected: session.memoryId === selectedId }"
              @click="openMemory(session.memoryId)"
            >
              {{ session.title }}
            </button>
          </div>
        </template>
      </div>

      <div class="memory-editor">
        <p v-if="!document" class="state">选择一条记忆开始编辑。本地保存不依赖当前 Task。</p>
        <template v-else>
          <textarea
            v-model="draft"
            spellcheck="false"
            :disabled="truncated"
            aria-label="记忆 Markdown"
          />
          <p v-if="truncated" class="warning">文件过大，不能在此覆盖。</p>
          <div class="actions">
            <button
              type="button"
              title="保存记忆"
              :disabled="!dirty || truncated || saving"
              @click="saveDraft"
            >
              保存
            </button>
            <button
              type="button"
              title="放弃未保存"
              :disabled="!dirty || saving"
              @click="discardDraft"
            >
              放弃未保存
            </button>
            <button
              v-if="document.scope === 'session'"
              type="button"
              title="删除会话摘要"
              @click="deleteSelected"
            >
              删除
            </button>
          </div>
        </template>
        <div class="grok-actions">
          <button
            type="button"
            title="让 Grok 记住"
            :disabled="!grokActionsAvailable || !selectedTaskId"
            @click="emit('start-turn', '/remember')"
          >
            让 Grok 记住
          </button>
          <button
            type="button"
            title="保存当前任务"
            :disabled="!grokActionsAvailable || !selectedTaskId"
            @click="emit('start-turn', '/flush')"
          >
            保存当前任务
          </button>
          <button
            type="button"
            title="整理记忆"
            :disabled="!grokActionsAvailable || !selectedTaskId"
            @click="emit('start-turn', '/dream')"
          >
            整理
          </button>
        </div>
        <p v-if="statusMessage" class="success">{{ statusMessage }}</p>
        <p v-if="errorMessage && loadState === 'ready'" class="warning" role="alert">
          {{ errorMessage }}
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.memory-pane,
.memory-body {
  display: grid;
  min-height: 0;
  height: 100%;
  gap: 12px;
}

.memory-pane {
  grid-template-rows: auto auto auto minmax(0, 1fr);
}

.memory-body {
  grid-template-columns: 220px minmax(0, 1fr);
}

header h3,
header p,
.state,
.toggle,
.warning,
.success,
.project-group p,
.grok-actions {
  margin: 0;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.5;
}

header h3 {
  color: var(--text-1);
  font-size: 16px;
}

.warning {
  color: var(--danger);
}

.success {
  color: var(--success);
}

.memory-list,
.memory-editor {
  display: grid;
  align-content: start;
  gap: 8px;
  min-height: 0;
  overflow: auto;
}

.memory-item,
.list-actions button,
.actions button,
.grok-actions button {
  min-height: 32px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  color: var(--text-1);
  background: var(--surface-2);
  text-align: left;
  cursor: pointer;
}

.memory-item.selected {
  border-color: color-mix(in srgb, var(--accent) 70%, var(--border));
  background: color-mix(in srgb, var(--accent) 10%, var(--surface-2));
}

.memory-item.session {
  margin-left: 12px;
  font-size: 12px;
}

textarea {
  width: 100%;
  min-height: 220px;
  padding: 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  color: var(--text-1);
  background: var(--surface-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  resize: vertical;
}

.actions,
.list-actions,
.grok-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
