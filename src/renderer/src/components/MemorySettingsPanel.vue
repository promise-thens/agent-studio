<script setup lang="ts">
/**
 * 记忆设置面板组件
 * 负责展示与管理与终端 Grok 共享的跨会话记忆、项目记忆与会话摘要。
 */
import { computed, onMounted, ref, watch } from 'vue'
import {
  PhBrain as Brain,
  PhCaretRight as CaretRight,
  PhEye as Eye,
  PhFloppyDisk as FloppyDisk,
  PhPencilSimple as Pencil,
  PhSparkle as Sparkle,
  PhTrash as Trash
} from '@phosphor-icons/vue'
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
import { reportSettingsPaneState, type SettingsPaneState } from '../settings-dialog-interaction'

// 组件属性声明：传入当前选中的任务ID、Grok 动作是否可用以及项目路径提示
const props = defineProps<{
  selectedTaskId?: string
  grokActionsAvailable?: boolean
  projectHint?: string
}>()

// 组件事件声明：向外通知表单脏状态以及触发对话命令
const emit = defineEmits<{
  dirty: [value: boolean]
  state: [value: SettingsPaneState]
  'start-turn': [command: string]
}>()

// 加载状态及错误信息
const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const errorMessage = ref('')
// 记忆开关及与终端共享状态
const enabled = ref(true)
const shareStatus = ref<GrokMemoryShareStatus>('linked')
// 记忆列表及当前选中的记忆项 ID
const memories = ref<GrokMemorySummary[]>([])
const selectedId = ref('')
// 当前正在编辑或预览的记忆文档对象及文本草稿
const document = ref<GrokMemoryDocument | null>(null)
const draft = ref('')
const savedDraft = ref('')
const saving = ref(false)
const statusMessage = ref('')
const toggling = ref(false)
const opening = ref(false)
// 记录展开状态的项目 key 列表
const expandedProjectKeys = ref<string[]>([])
/** 默认渲染 Markdown；点击编辑时才切换为源码输入框。 */
const editingSource = ref(false)

// 是否存在未保存的修改
const dirty = computed(() => Boolean(document.value) && draft.value !== savedDraft.value)
// 是否因文件过大被主进程截断保护
const truncated = computed(() => document.value?.truncated === true)
// 全局记忆列表
const globalMemories = computed(() => memories.value.filter((item) => item.scope === 'global'))
// 按项目分组的记忆列表
const projectGroups = computed(() => groupProjectMemories(memories.value))
// 当前项目分组
const currentProject = computed(() => projectGroups.value.find((group) => group.isCurrent) ?? null)
// 其它非当前项目分组
const otherProjects = computed(() => projectGroups.value.filter((group) => !group.isCurrent))
// 长期笔记项：包含全局记忆以及当前项目记忆
const longTermItems = computed(() => {
  const items = [...globalMemories.value]
  if (currentProject.value?.project) items.push(currentProject.value.project)
  return items
})
// 当前项目下的会话摘要列表
const currentSessions = computed(() => currentProject.value?.sessions ?? [])
// 是否可在当前对话中执行 Grok 记忆快捷动作
const canRunGrokActions = computed(() =>
  Boolean(props.grokActionsAvailable && props.selectedTaskId)
)
// 编辑器标题：采用格式化后的展示标题
const editorTitle = computed(() => (document.value ? formatMemoryItemTitle(document.value) : ''))
// 编辑器副标题：展示作用域和相对更新时间
const editorSubtitle = computed(() => {
  const item = memories.value.find((entry) => entry.memoryId === selectedId.value)
  if (!item) return '本地保存，不依赖当前对话。'
  const when = formatMemoryItemSubtitle(item)
  return `${formatMemoryKindLabel(item.scope)} · ${when}`
})

// 监听脏状态变化并通知父容器
watch(dirty, (value) => emit('dirty', value))
reportSettingsPaneState(
  () => ({
    dirty: dirty.value,
    saving: saving.value || toggling.value || opening.value,
    error: errorMessage.value,
    message: statusMessage.value
  }),
  (state) => emit('state', state)
)
watch(draft, () => { statusMessage.value = '' })
// 监听项目路径切换时重新刷新列表
watch(
  () => props.projectHint,
  () => {
    if (loadState.value === 'ready') void refreshList()
  }
)

/**
 * 加载全部记忆数据
 * 同时获取记忆开启状态和记忆列表，默认自动展开当前项目
 */
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

/**
 * 切换记忆启用开关
 */
async function toggleEnabled(next: boolean): Promise<void> {
  if (toggling.value || saving.value) return
  toggling.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    const state = unwrapDesktopIpcResult(await window.app.setMemoryEnabled(next))
    enabled.value = state.enabled
    shareStatus.value = state.shareStatus
    statusMessage.value = '记忆开关已保存。'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    toggling.value = false
  }
}

/**
 * 打开并读取指定记忆内容
 */
async function openMemory(memoryId: string): Promise<void> {
  if (saving.value || opening.value) return
  if (dirty.value && !window.confirm('有未保存的更改，确定离开？')) return
  opening.value = true
  statusMessage.value = ''
  errorMessage.value = ''
  try {
    const next = unwrapDesktopIpcResult(await window.app.getMemory(memoryId))
    selectedId.value = memoryId
    document.value = next
    draft.value = next.markdown
    savedDraft.value = next.markdown
    editingSource.value = false
    if (next.projectKey) expandProject(next.projectKey)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    opening.value = false
  }
}

/**
 * 保存当前正在编辑的草稿内容到磁盘
 */
async function saveDraft(): Promise<void> {
  if (!document.value || truncated.value || !dirty.value || saving.value || opening.value) return
  saving.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  const submitted = draft.value
  try {
    const saved = unwrapDesktopIpcResult(
      await window.app.saveMemory(document.value.memoryId, submitted)
    )
    document.value = saved
    savedDraft.value = saved.markdown
    if (draft.value === submitted) draft.value = saved.markdown
    editingSource.value = dirty.value
    statusMessage.value = '已保存到共享记忆目录。'
    await refreshList()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}

/**
 * 放弃未保存的更改，回滚到保存状态
 */
function discardDraft(): void {
  if (saving.value) return
  draft.value = savedDraft.value
  editingSource.value = false
  errorMessage.value = ''
  statusMessage.value = ''
}

/**
 * 切换到 Markdown 渲染预览模式
 */
function showMemoryPreview(): void {
  editingSource.value = false
}

/**
 * 切换到 Markdown 源码编辑模式
 */
function showMemorySource(): void {
  if (truncated.value) return
  editingSource.value = true
}

/**
 * 删除当前选中的会话摘要记忆
 */
async function deleteSelected(): Promise<void> {
  if (document.value?.scope !== 'session' || saving.value || opening.value) return
  if (!window.confirm(dirty.value ? '删除这条会话摘要并丢弃未保存的更改？' : '删除这条会话摘要？')) return
  saving.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    unwrapDesktopIpcResult(await window.app.deleteMemory(document.value.memoryId))
    document.value = null
    draft.value = ''
    savedDraft.value = ''
    selectedId.value = ''
    await refreshList()
    statusMessage.value = '会话摘要已删除。'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}

/**
 * 刷新记忆列表数据
 */
async function refreshList(): Promise<void> {
  memories.value = unwrapDesktopIpcResult(await window.app.listMemories(props.projectHint))
}

/**
 * 检查某项目分组是否处于展开状态
 */
function isProjectOpen(group: MemoryProjectGroup): boolean {
  return expandedProjectKeys.value.includes(group.projectKey)
}

/**
 * 展开指定项目分组
 */
function expandProject(projectKey: string): void {
  if (expandedProjectKeys.value.includes(projectKey)) return
  expandedProjectKeys.value = [...expandedProjectKeys.value, projectKey]
}

/**
 * 切换指定项目分组的展开与收起
 */
function toggleProject(projectKey: string): void {
  expandedProjectKeys.value = expandedProjectKeys.value.includes(projectKey)
    ? expandedProjectKeys.value.filter((key) => key !== projectKey)
    : [...expandedProjectKeys.value, projectKey]
}

/**
 * 快捷键处理：Cmd+S / Ctrl+S 触发快速保存
 */
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
  <!-- 记忆设置主面板容器 -->
  <section class="memory-pane" aria-labelledby="memory-title" @keydown="onKeydown">
    <!-- 顶部状态与总控区域 -->
    <div class="memory-top">
      <header class="memory-header">
        <div class="header-main">
          <div class="header-badge">
            <Brain :size="16" />
          </div>
          <div class="header-titles">
            <h3 id="memory-title">记忆</h3>
            <p>和终端 Grok 共用同一份笔记，跨任务保持认知连续。</p>
          </div>
        </div>
        <div class="enable-control">
          <div class="control-meta">
            <strong>跨会话记忆</strong>
            <small>关闭后不能 /remember、/flush、/dream</small>
          </div>
          <button
            class="studio-switch"
            type="button"
            role="switch"
            :aria-checked="enabled"
            :disabled="toggling || saving || loadState !== 'ready'"
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

    <!-- 加载中与错误状态提示 -->
    <div v-if="loadState === 'loading'" class="state" role="status">正在加载记忆…</div>
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

    <!-- 记忆左右分栏主体容器 -->
    <div v-else class="memory-body">
      <!-- 左侧记忆导航列表 -->
      <aside class="memory-list" aria-label="记忆目录">
        <p v-if="memories.length === 0" class="list-empty">
          还没有笔记。开着跨会话记忆，让 Grok 在对话里记住。
        </p>
        <template v-else>
          <!-- 长期笔记分组：包含全局记忆与当前项目记忆 -->
          <section v-if="longTermItems.length" class="memory-section">
            <div class="section-title-wrap">
              <h4>长期笔记</h4>
              <p class="section-kicker">跨对话保留</p>
            </div>
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
              <span class="kind-tag" :data-kind="item.scope">
                {{ formatMemoryKindLabel(item.scope) }}
              </span>
              <span class="memory-copy">
                <strong>{{ formatMemoryItemTitle(item) }}</strong>
                <small>{{ formatMemoryItemSubtitle(item) }}</small>
              </span>
            </button>
          </section>

          <!-- 会话摘要分组：当前项目的单场会话备忘 -->
          <section v-if="currentSessions.length" class="memory-section">
            <div class="section-title-wrap">
              <h4>会话摘要</h4>
              <p class="section-kicker">单场备忘，可删</p>
            </div>
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
              <span class="kind-tag" data-kind="session">
                {{ formatMemoryKindLabel('session') }}
              </span>
              <span class="memory-copy">
                <strong>{{ formatMemoryItemTitle(session) }}</strong>
                <small>{{ formatMemoryItemSubtitle(session) }}</small>
              </span>
            </button>
          </section>

          <!-- 其它项目分组：可折叠展开其它项目记录 -->
          <section v-if="otherProjects.length" class="memory-section">
            <div class="section-title-wrap">
              <h4>其它项目</h4>
            </div>
            <div v-for="group in otherProjects" :key="group.projectKey" class="project-block">
              <button
                class="project-heading"
                type="button"
                :aria-expanded="isProjectOpen(group)"
                :title="group.projectKey"
                :aria-label="`${isProjectOpen(group) ? '收起' : '展开'} ${formatProjectKey(group.projectKey)}`"
                @click="toggleProject(group.projectKey)"
              >
                <CaretRight
                  class="chevron"
                  :size="12"
                  :data-open="isProjectOpen(group) ? 'true' : undefined"
                />
                <span class="project-name">{{ formatProjectKey(group.projectKey) }}</span>
                <small v-if="group.sessions.length" class="project-count">{{
                  group.sessions.length
                }}</small>
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
                  <span class="kind-tag" data-kind="project">
                    {{ formatMemoryKindLabel('project') }}
                  </span>
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
                  <span class="kind-tag" data-kind="session">
                    {{ formatMemoryKindLabel('session') }}
                  </span>
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

      <!-- 右侧记忆详情与编辑器 -->
      <div class="memory-editor">
        <!-- 选中文档状态：展示顶部操作栏、渲染预览或 Markdown 源码编辑 -->
        <template v-if="document">
          <div class="editor-frame">
            <div class="editor-bar">
              <div class="editor-copy">
                <strong>{{ editorTitle }}</strong>
                <small>{{ editorSubtitle }}</small>
              </div>
              <span v-if="dirty" class="dirty-dot" title="未保存更改" />
              <!-- 视图切换控件组 -->
              <div class="view-switch-group" role="group" aria-label="查看模式">
                <button
                  class="hub-secondary view-switch-btn"
                  type="button"
                  :aria-pressed="!editingSource ? 'true' : 'false'"
                  title="查看渲染"
                  aria-label="查看渲染"
                  @click="showMemoryPreview"
                >
                  <Eye :size="13" />
                  <span>预览</span>
                </button>
                <button
                  class="hub-secondary view-switch-btn"
                  type="button"
                  :disabled="truncated"
                  :aria-pressed="editingSource ? 'true' : 'false'"
                  title="编辑源码"
                  aria-label="编辑源码"
                  @click="showMemorySource"
                >
                  <Pencil :size="13" />
                  <span>编辑</span>
                </button>
              </div>
              <!-- 保存与放弃操作 -->
              <button
                class="hub-primary save-button"
                type="button"
                title="保存记忆"
                :disabled="!dirty || truncated || saving"
                @click="saveDraft"
              >
                <FloppyDisk :size="13" />
                <span>{{ saving ? '保存中…' : '保存' }}</span>
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
                class="text-danger delete-btn"
                type="button"
                title="删除会话摘要"
                :disabled="saving || opening"
                @click="deleteSelected"
              >
                <Trash :size="13" />
                <span>删除</span>
              </button>
            </div>
            <!-- Markdown 预览展示区 -->
            <div v-if="!editingSource" class="memory-preview">
              <AssistantMarkdown :text="draft" />
            </div>
            <!-- Markdown 源码编辑文本域 -->
            <textarea
              v-else
              v-model="draft"
              spellcheck="false"
              :disabled="truncated || saving || opening"
              aria-label="记忆 Markdown 源码"
              :aria-invalid="Boolean(errorMessage)"
              :aria-describedby="errorMessage ? 'memory-save-error' : undefined"
            />
          </div>
        </template>

        <!-- 未选择记忆时的精致居中空状态 -->
        <div v-else class="editor-empty">
          <div class="empty-badge">
            <Brain :size="30" />
          </div>
          <div class="empty-copy">
            <strong>还没打开记忆</strong>
            <p>从左侧选一条。本地保存不依赖当前对话。</p>
          </div>
          <div class="empty-hint">
            <span class="kbd-badge"><kbd>⌘</kbd><kbd>S</kbd> 随时保存修改</span>
          </div>
        </div>

        <!-- 底部快捷动作与状态提示栏 -->
        <div class="editor-footer">
          <p v-if="truncated" class="warning">文件过大，不能在此覆盖。</p>
          <div v-if="canRunGrokActions" class="grok-actions">
            <div class="grok-actions-label">
              <Sparkle :size="13" class="sparkle-icon" />
              <span>让 Grok</span>
            </div>
            <div class="grok-chip-group">
              <button
                class="grok-action-chip text-action"
                type="button"
                title="在当前对话执行 /remember"
                @click="emit('start-turn', '/remember')"
              >
                <span>记住</span>
                <code class="chip-cmd">/remember</code>
              </button>
              <button
                class="grok-action-chip text-action"
                type="button"
                title="在当前对话执行 /flush"
                @click="emit('start-turn', '/flush')"
              >
                <span>保存任务</span>
                <code class="chip-cmd">/flush</code>
              </button>
              <button
                class="grok-action-chip text-action"
                type="button"
                title="在当前对话执行 /dream"
                @click="emit('start-turn', '/dream')"
              >
                <span>整理</span>
                <code class="chip-cmd">/dream</code>
              </button>
            </div>
          </div>
          <p v-else class="hint">打开一个对话后，可以让 Grok 记住、保存任务或整理。</p>
          <p v-if="statusMessage" class="success" role="status">{{ statusMessage }}</p>
          <p v-if="errorMessage && loadState === 'ready'" id="memory-save-error" class="warning" role="alert">
            {{ errorMessage }}
          </p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 整个面板主布局 */
.memory-pane {
  display: grid;
  min-height: 0;
  gap: 14px;
  grid-template-rows: auto auto;
}

/* 顶部状态与总控区域 */
.memory-top {
  display: grid;
  gap: 8px;
}

.memory-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.header-main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.header-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--accent);
  box-shadow: 0 1px 3px color-mix(in srgb, black 5%, transparent);
}

.header-titles {
  display: grid;
  gap: 2px;
}

.header-titles h3 {
  margin: 0;
  color: var(--text-1);
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.header-titles p {
  margin: 0;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.4;
}

/* 跨会话记忆开关卡片 */
.enable-control {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface-2);
  box-shadow: 0 1px 2px color-mix(in srgb, black 4%, transparent);
}

.control-meta {
  display: grid;
  gap: 1px;
  text-align: right;
}

.control-meta strong {
  color: var(--text-1);
  font-size: 12px;
  font-weight: 600;
}

.control-meta small {
  color: var(--text-3);
  font-size: 11px;
}

/* 记忆主体分栏卡片：优化浅色与深色下的对比度与内阴影 */
.memory-body {
  display: grid;
  min-height: 0;
  overflow: hidden;
  grid-template-columns: minmax(180px, 30%) minmax(0, 1fr);
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  background: var(--surface-1);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--border-strong) 10%, transparent);
}

/* 左侧记忆列表导航 */
.memory-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 14px 10px;
  border-right: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface-1) 94%, var(--surface-0));
  max-height: 34rem;
}

.memory-section {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.section-title-wrap {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 2px 8px 4px;
}

.section-title-wrap h4 {
  margin: 0;
  color: var(--text-2);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.section-kicker {
  margin: 0;
  color: var(--text-3);
  font-size: 10px;
  line-height: 1.3;
}

/* 列表单项卡片样式 */
.memory-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 9px;
  color: var(--text-1);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition:
    background 120ms ease,
    border-color 120ms ease,
    transform 120ms ease;
}

.memory-item:hover {
  background: var(--hover-fill);
}

.memory-item.selected {
  border-color: color-mix(in srgb, var(--accent) 46%, var(--border));
  background: color-mix(in srgb, var(--accent) 10%, var(--surface-2));
  box-shadow: 0 1px 3px color-mix(in srgb, black 6%, transparent);
}

/* 作用域微胶囊标签 */
.kind-tag {
  flex: 0 0 auto;
  padding: 1.5px 7px;
  border-radius: var(--radius-chip);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.02em;
  line-height: 1.5;
}

.kind-tag[data-kind='global'] {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
}

.kind-tag[data-kind='project'] {
  color: var(--text-1);
  background: color-mix(in srgb, var(--surface-3) 90%, transparent);
  border: 1px solid var(--border);
}

.kind-tag[data-kind='session'] {
  color: var(--text-2);
  background: color-mix(in srgb, var(--surface-2) 80%, transparent);
  border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
}

.memory-copy {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.memory-item strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}

.memory-item small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-3);
  font-size: 11px;
}

/* 其它项目折叠分组 */
.project-block,
.project-children {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.project-heading {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--text-2);
  background: transparent;
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition: background 120ms ease;
}

.project-heading:hover {
  color: var(--text-1);
  background: var(--hover-fill);
}

.project-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-count {
  padding: 0 6px;
  border-radius: var(--radius-chip);
  background: color-mix(in srgb, var(--surface-3) 80%, transparent);
  color: var(--text-3);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.6;
}

.chevron {
  flex: 0 0 auto;
  color: var(--text-3);
  transition: transform 160ms cubic-bezier(0.2, 0, 0, 1);
}

.chevron[data-open='true'] {
  transform: rotate(90deg);
}

/* 右侧工作台与编辑器容器 */
.memory-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
  padding: 14px;
  min-width: 0;
}

.editor-frame {
  min-height: 0;
  flex: 1 0 auto;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface-2);
  box-shadow: 0 2px 8px color-mix(in srgb, black 4%, transparent);
}

.editor-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface-2) 96%, var(--surface-1));
}

.editor-copy {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 1px;
}

.editor-copy strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 650;
}

.editor-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-3);
  font-size: 11px;
}

.dirty-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 70%, transparent);
}

/* 视图模式切换器 */
.view-switch-group {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-3) 60%, transparent);
  border: 1px solid var(--border);
}

.view-switch-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.view-switch-btn[aria-pressed='true'] {
  color: var(--text-1);
  background: var(--surface-2);
  box-shadow: 0 1px 3px color-mix(in srgb, black 10%, transparent);
}

.save-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.delete-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.memory-preview {
  min-height: 18rem;
  padding: 14px 18px 18px;
}

.memory-preview :deep(.assistant-markdown) {
  font-size: 13px;
  line-height: 1.6;
}

textarea {
  width: 100%;
  min-height: 18rem;
  height: 100%;
  padding: 14px 16px;
  border: 0;
  color: var(--text-1);
  background: transparent;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  resize: none;
}

/* 空状态设计：景深磨砂徽章 + 居中指引 */
.editor-empty {
  min-height: 0;
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  text-align: center;
}

.empty-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 58px;
  height: 58px;
  border-radius: 16px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--accent);
  box-shadow: 0 8px 24px color-mix(in srgb, black 8%, transparent);
}

.empty-copy {
  display: grid;
  gap: 5px;
  max-width: 290px;
}

.empty-copy strong {
  color: var(--text-1);
  font-size: 14px;
  font-weight: 650;
}

.empty-copy p {
  margin: 0;
  color: var(--text-3);
  font-size: 12.5px;
  line-height: 1.5;
}

.empty-hint {
  display: inline-flex;
}

.kbd-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: var(--radius-chip);
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: 11px;
}

.kbd-badge kbd {
  padding: 1px 4px;
  border-radius: 4px;
  border: 1px solid var(--border-strong);
  background: var(--surface-1);
  color: var(--text-2);
  font-family: inherit;
  font-size: 10px;
  font-weight: 600;
}

/* 记住 / 整理提示底栏：严格匹配 flex: 0 0 auto 单测断言 */
.editor-footer {
  flex: 0 0 auto;
  display: grid;
  gap: 6px;
  padding-top: 4px;
  overflow-wrap: anywhere;
}

.grok-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.grok-actions-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
}

.sparkle-icon {
  color: var(--accent);
}

.grok-chip-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.grok-action-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-chip);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background 120ms ease,
    color 120ms ease;
}

.grok-action-chip:hover {
  color: var(--text-1);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  background: color-mix(in srgb, var(--accent) 8%, var(--surface-2));
}

.chip-cmd {
  padding: 0 3px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--surface-3) 80%, transparent);
  color: var(--text-3);
  font-size: 9.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.text-action,
.text-danger {
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.text-danger {
  color: var(--danger);
  font-size: 12px;
}

.text-danger:hover {
  opacity: 0.85;
}

.list-empty {
  margin: 0;
  padding: 12px 6px;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.5;
}

.state,
.warning,
.success,
.hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
}

.warning {
  color: var(--danger);
}

.success {
  color: var(--success);
}

.hint {
  color: var(--text-3);
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

/* 按设置内容实际宽度折叠，窄窗口不再留下难以输入的正文细栏。 */
@container settings-content (max-width: 680px) {
  .memory-body {
    grid-template-columns: minmax(0, 1fr);
  }

  .memory-list {
    max-height: 12rem;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
}

@media (prefers-reduced-motion: reduce) {
  .memory-item,
  .project-heading,
  .chevron,
  .grok-action-chip {
    transition: none;
  }
}
</style>
