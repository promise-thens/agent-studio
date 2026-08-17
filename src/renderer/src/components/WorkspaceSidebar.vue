<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  PhCaretDown as CaretDown,
  PhFolderSimple as FolderSimple,
  PhGearSix as GearSix,
  PhMagnifyingGlass as MagnifyingGlass,
  PhNotePencil as NotePencil,
  PhFolderOpen as FolderOpen,
  PhRobot as Robot
} from '@phosphor-icons/vue'

/** 侧栏展示用的会话条目，仅负责 UI 状态，不承载 Runtime 协议。 */
export interface SidebarSessionItem {
  id: string
  title: string
  state?: string
}

/** 侧栏展示用的项目条目，路径只用于展示与高亮，不直接访问文件系统。 */
export interface SidebarProjectItem {
  id: string
  name: string
  path: string
  status: 'active' | 'removed'
  availability: 'available' | 'unavailable' | 'version-unsupported' | 'corrupt'
}

const props = withDefaults(
  defineProps<{
    brandName?: string
    workspacePath: string
    workspaceName: string
    projects: SidebarProjectItem[]
    sessions: SidebarSessionItem[]
    activeSessionId: string
    activeProjectId?: string
    /** 连接或执行期间由上层禁用新对话，避免并发重建 Runtime 会话。 */
    newChatDisabled?: boolean
    /** 为禁用的新对话入口提供可读原因，不替代主区域的状态反馈。 */
    newChatDisabledReason?: string
    /** 只读历史导航只在列表自身切换期间禁用，后台执行不能封死浏览入口。 */
    historyNavigationDisabled?: boolean
    /** 历史导航禁用原因必须可见，并关联到 Project/Task 主按钮。 */
    historyNavigationDisabledReason?: string
    /** 会改变 Runtime、Project 或历史的操作在活动 execution 期间统一禁用。 */
    mutationActionsDisabled?: boolean
    /** mutation 禁用原因只解释打开、删除、移除等会改变状态的入口。 */
    mutationActionsDisabledReason?: string
    hasMoreSessions?: boolean
    loadingMoreSessions?: boolean
  }>(),
  {
    brandName: 'Agent Studio',
    activeProjectId: '',
    newChatDisabled: false,
    newChatDisabledReason: '',
    historyNavigationDisabled: false,
    historyNavigationDisabledReason: '',
    mutationActionsDisabled: false,
    mutationActionsDisabledReason: '',
    hasMoreSessions: false,
    loadingMoreSessions: false
  }
)

const emit = defineEmits<{
  newChat: []
  openProject: []
  openSettings: []
  selectSession: [sessionId: string]
  selectProject: [projectId: string]
  deleteSession: [sessionId: string]
  removeProject: [projectId: string]
  deleteProjectHistory: [projectId: string]
  loadMoreSessions: []
}>()

/** 本地搜索只过滤侧栏列表，不触发主进程查询。 */
const query = ref('')
/** 搜索框默认收起，点击放大镜后展开，贴近 Codex 侧栏节奏。 */
const searchOpen = ref(false)

const normalizedQuery = computed(() => query.value.trim().toLowerCase())

function toggleSearch(): void {
  searchOpen.value = !searchOpen.value
  if (!searchOpen.value) query.value = ''
}

/** 按关键字同时过滤项目名与最近会话标题，保持侧栏轻量。 */
const filteredProjects = computed(() => {
  if (!normalizedQuery.value) return props.projects
  return props.projects.filter((project) => {
    const haystack = `${project.name} ${project.path}`.toLowerCase()
    return haystack.includes(normalizedQuery.value)
  })
})

const filteredSessions = computed(() => {
  if (!normalizedQuery.value) return props.sessions
  return props.sessions.filter((session) =>
    session.title.toLowerCase().includes(normalizedQuery.value)
  )
})
</script>

<template>
  <aside class="workspace-sidebar" aria-label="工作区导航">
    <!-- 顶部品牌区：对齐 Codex 的产品名 + 快捷入口布局 -->
    <div class="sidebar-top">
      <button class="brand-button" type="button" title="当前工作台" aria-label="当前工作台">
        <span class="brand-mark">
          <Robot :size="15" weight="fill" />
        </span>
        <span class="brand-copy">
          <strong>{{ brandName }}</strong>
        </span>
        <CaretDown :size="12" class="brand-caret" />
      </button>

      <div class="sidebar-top-actions">
        <button
          class="sidebar-icon-button"
          type="button"
          title="搜索"
          aria-label="搜索项目和会话"
          :aria-pressed="searchOpen"
          @click="toggleSearch"
        >
          <MagnifyingGlass :size="16" />
        </button>
        <button
          class="sidebar-icon-button"
          type="button"
          title="模型设置"
          aria-label="模型设置"
          @click="emit('openSettings')"
        >
          <GearSix :size="16" />
        </button>
      </div>
    </div>

    <label v-if="searchOpen" class="sidebar-search-row">
      <MagnifyingGlass :size="14" />
      <input v-model="query" aria-label="搜索项目和会话" placeholder="搜索项目和会话" />
    </label>

    <!-- 主操作区：新对话与打开项目，对应 Codex 顶部动作列表 -->
    <div class="sidebar-actions">
      <button
        class="sidebar-link"
        type="button"
        :disabled="newChatDisabled"
        :title="newChatDisabledReason || '新对话'"
        aria-label="新对话"
        @click="emit('newChat')"
      >
        <NotePencil :size="16" />
        <span>新对话</span>
      </button>
      <button
        class="sidebar-link"
        type="button"
        :disabled="mutationActionsDisabled"
        :aria-describedby="
          mutationActionsDisabled && mutationActionsDisabledReason
            ? 'mutation-actions-disabled-reason'
            : undefined
        "
        :title="
          mutationActionsDisabled && mutationActionsDisabledReason
            ? mutationActionsDisabledReason
            : '打开项目'
        "
        @click="emit('openProject')"
      >
        <FolderOpen :size="16" />
        <span>打开项目</span>
      </button>
    </div>

    <div class="sidebar-scroll">
      <!-- 项目分区：展示当前已选工作目录 -->
      <section class="sidebar-section" aria-label="项目">
        <div class="section-label">项目</div>
        <p
          v-if="historyNavigationDisabled && historyNavigationDisabledReason"
          id="history-navigation-disabled-reason"
          class="section-hint"
        >
          {{ historyNavigationDisabledReason }}
        </p>
        <p
          v-else-if="mutationActionsDisabled && mutationActionsDisabledReason"
          id="mutation-actions-disabled-reason"
          class="section-hint"
        >
          {{ mutationActionsDisabledReason }}
        </p>

        <div v-if="filteredProjects.length" class="section-list">
          <div v-for="project in filteredProjects" :key="project.id" class="sidebar-item-row">
            <button
              class="sidebar-item sidebar-item-main"
              type="button"
              :class="{ active: project.id === activeProjectId }"
              :disabled="historyNavigationDisabled"
              :aria-describedby="
                historyNavigationDisabled && historyNavigationDisabledReason
                  ? 'history-navigation-disabled-reason'
                  : undefined
              "
              :title="project.path"
              @click="emit('selectProject', project.id)"
            >
              <FolderSimple :size="15" />
              <span>{{ project.name }}</span>
              <small v-if="project.availability !== 'available'">不可执行</small>
            </button>
            <button
              class="sidebar-row-action"
              type="button"
              :disabled="mutationActionsDisabled"
              :title="`从项目列表移除：${project.name}`"
              :aria-label="`从项目列表移除：${project.name}`"
              @click.stop="emit('removeProject', project.id)"
            >
              移除
            </button>
            <button
              class="sidebar-row-action danger"
              type="button"
              :disabled="mutationActionsDisabled"
              :title="`删除项目本地历史：${project.name}`"
              :aria-label="`删除项目本地历史：${project.name}`"
              @click.stop="emit('deleteProjectHistory', project.id)"
            >
              删历史
            </button>
          </div>
        </div>

        <button
          v-else
          class="sidebar-empty"
          type="button"
          :disabled="mutationActionsDisabled"
          :aria-describedby="
            mutationActionsDisabled && mutationActionsDisabledReason
              ? 'mutation-actions-disabled-reason'
              : undefined
          "
          :title="
            mutationActionsDisabled && mutationActionsDisabledReason
              ? mutationActionsDisabledReason
              : '选择项目目录'
          "
          @click="emit('openProject')"
        >
          <FolderSimple :size="15" />
          <span>{{ workspacePath ? '未匹配到项目' : '选择项目目录后开始工作' }}</span>
        </button>
      </section>

      <!-- 最近分区：展示本地点会话标题列表 -->
      <section class="sidebar-section" aria-label="最近">
        <div class="section-label">最近</div>
        <p
          v-if="historyNavigationDisabled && historyNavigationDisabledReason"
          id="recent-navigation-disabled-reason"
          class="section-hint"
        >
          {{ historyNavigationDisabledReason }}
        </p>
        <p
          v-else-if="mutationActionsDisabled && mutationActionsDisabledReason"
          class="section-hint"
        >
          {{ mutationActionsDisabledReason }}
        </p>

        <div v-if="filteredSessions.length" class="section-list">
          <div v-for="session in filteredSessions" :key="session.id" class="sidebar-item-row">
            <button
              class="sidebar-item sidebar-item-main session-item"
              type="button"
              :class="{ active: session.id === activeSessionId }"
              :disabled="historyNavigationDisabled"
              :aria-describedby="
                historyNavigationDisabled && historyNavigationDisabledReason
                  ? 'recent-navigation-disabled-reason'
                  : undefined
              "
              :title="session.title"
              @click="emit('selectSession', session.id)"
            >
              <span>{{ session.title }}</span>
            </button>
            <button
              class="sidebar-row-action danger"
              type="button"
              :disabled="mutationActionsDisabled"
              :title="`删除 Task：${session.title}`"
              :aria-label="`删除 Task：${session.title}`"
              @click.stop="emit('deleteSession', session.id)"
            >
              删除
            </button>
          </div>
          <button
            v-if="hasMoreSessions"
            class="load-more-button"
            type="button"
            :disabled="loadingMoreSessions || historyNavigationDisabled"
            :aria-busy="loadingMoreSessions"
            @click="emit('loadMoreSessions')"
          >
            {{ loadingMoreSessions ? '正在加载…' : '加载更多任务' }}
          </button>
        </div>

        <div v-else class="sidebar-empty static">
          <span>暂无最近对话</span>
        </div>
      </section>
    </div>

    <!-- 底部当前目录摘要，方便确认 Runtime 工作区 -->
    <div class="sidebar-footer">
      <div class="footer-workspace" :title="workspacePath || '尚未选择项目目录'">
        <FolderSimple :size="14" />
        <div class="footer-copy">
          <strong>{{ workspaceName }}</strong>
          <small>{{ workspacePath || '选择项目目录后开始工作' }}</small>
        </div>
      </div>
      <button
        class="footer-button"
        type="button"
        :disabled="mutationActionsDisabled"
        :aria-describedby="
          mutationActionsDisabled && mutationActionsDisabledReason
            ? 'mutation-actions-disabled-reason'
            : undefined
        "
        :title="
          mutationActionsDisabled && mutationActionsDisabledReason
            ? mutationActionsDisabledReason
            : workspacePath
              ? '切换目录'
              : '选择目录'
        "
        @click="emit('openProject')"
      >
        {{ workspacePath ? '切换目录' : '选择目录' }}
      </button>
    </div>
  </aside>
</template>

<style scoped>
.workspace-sidebar {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border) 88%, transparent);
  border-radius: 22px;
  background: color-mix(in srgb, #0a0c10 94%, #141a22);
  color: var(--text-2);
  box-shadow: 0 10px 28px rgb(2 5 9 / 18%);
}

.sidebar-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 12px 8px;
}

.brand-button {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border: 0;
  border-radius: var(--radius-soft);
  color: var(--text-1);
  background: transparent;
  cursor: default;
}

.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 10px;
  color: var(--accent-ink);
  background: var(--accent);
}

.brand-copy {
  min-width: 0;
}

.brand-copy strong {
  display: block;
  overflow: hidden;
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.brand-caret {
  flex: 0 0 auto;
  color: var(--text-3);
}

.sidebar-top-actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}

.sidebar-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: var(--radius-chip);
  color: var(--text-3);
  background: transparent;
  cursor: pointer;
}

.sidebar-icon-button:hover,
.sidebar-icon-button[aria-pressed='true'] {
  color: var(--text-1);
  background: rgba(255, 255, 255, 0.04);
}

.sidebar-search-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 12px 8px;
  padding: 0 12px;
  height: 36px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: var(--radius-soft);
  color: var(--text-3);
  background: rgba(255, 255, 255, 0.02);
}

.sidebar-search-row input {
  width: 100%;
  border: 0;
  outline: 0;
  color: var(--text-1);
  background: transparent;
  font-size: 12px;
}

.sidebar-actions {
  display: grid;
  gap: 2px;
  padding: 4px 8px 10px;
}

.sidebar-link,
.sidebar-item,
.sidebar-empty,
.footer-button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  border: 0;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.sidebar-link {
  min-height: 36px;
  padding: 0 12px;
  border-radius: var(--radius-soft);
  color: var(--text-1);
  font-size: 13px;
}

.sidebar-link:not(:disabled):hover,
.sidebar-item:not(:disabled):hover {
  background: rgba(255, 255, 255, 0.04);
}

.sidebar-link:disabled,
.sidebar-item:disabled,
.sidebar-empty:disabled,
.footer-button:disabled {
  color: color-mix(in srgb, var(--text-3) 72%, transparent);
  cursor: not-allowed;
}

.sidebar-link svg,
.sidebar-item svg {
  flex: 0 0 auto;
  color: var(--text-3);
}

.sidebar-scroll {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 14px;
  padding: 2px 8px 12px;
  overflow: auto;
}

.sidebar-section {
  display: grid;
  gap: 4px;
}

.section-label {
  padding: 8px 10px 4px;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 600;
}

.section-hint {
  margin: 0 10px 4px;
  color: var(--text-3);
  font-size: 10px;
  line-height: 1.5;
}

.section-list {
  display: grid;
  gap: 1px;
}

.sidebar-item {
  min-height: 34px;
  padding: 0 12px;
  border-radius: var(--radius-soft);
  color: var(--text-2);
  font-size: 13px;
}

.sidebar-item-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 2px;
}

.sidebar-item-main {
  flex: 1;
  min-width: 0;
}

.sidebar-item-main small {
  margin-left: auto;
  color: var(--warning);
  font-size: 9px;
}

.sidebar-row-action,
.load-more-button {
  border: 0;
  border-radius: var(--radius-soft);
  color: var(--text-3);
  background: transparent;
  cursor: pointer;
  font-size: 10px;
}

.sidebar-row-action {
  flex: 0 0 auto;
  padding: 6px 5px;
}

.sidebar-row-action:not(:disabled):hover,
.load-more-button:not(:disabled):hover {
  color: var(--text-1);
  background: rgba(255, 255, 255, 0.05);
}

.sidebar-row-action.danger:not(:disabled):hover {
  color: var(--danger);
}

.load-more-button {
  width: 100%;
  padding: 8px;
}

.sidebar-item span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-item.active {
  color: var(--text-1);
  background: rgba(255, 255, 255, 0.06);
}

.sidebar-item.active svg {
  color: var(--text-2);
}

.session-item {
  padding-left: 12px;
}

.sidebar-empty {
  min-height: 34px;
  padding: 0 10px;
  border-radius: var(--radius-soft);
  color: var(--text-3);
  font-size: 12px;
}

.sidebar-empty.static {
  cursor: default;
}

.sidebar-empty:not(.static):not(:disabled):hover {
  color: var(--text-2);
  background: rgba(255, 255, 255, 0.04);
}

.sidebar-footer {
  display: grid;
  gap: 8px;
  padding: 10px 12px 14px;
  border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  background: rgba(0, 0, 0, 0.12);
  border-bottom-left-radius: 22px;
  border-bottom-right-radius: 22px;
}

.footer-workspace {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  color: var(--text-3);
}

.footer-workspace svg {
  margin-top: 2px;
}

.footer-copy {
  min-width: 0;
}

.footer-copy strong,
.footer-copy small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.footer-copy strong {
  color: var(--text-2);
  font-size: 11px;
  font-weight: 650;
}

.footer-copy small {
  margin-top: 2px;
  font-size: 10px;
  line-height: 1.4;
}

.footer-button {
  justify-content: center;
  min-height: 34px;
  border: 1px solid var(--border);
  border-radius: var(--radius-soft);
  color: var(--text-2);
  background: rgba(255, 255, 255, 0.02);
  font-size: 11px;
  font-weight: 650;
}

.footer-button:not(:disabled):hover {
  color: var(--text-1);
  background: rgba(255, 255, 255, 0.04);
}
</style>
