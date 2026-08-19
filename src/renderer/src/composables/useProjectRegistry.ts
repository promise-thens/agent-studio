import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { DeletionPreview, ProjectSummary } from '../../../shared/task-history'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'

export type WorkbenchLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface WorkbenchLoadState {
  status: WorkbenchLoadStatus
  errorMessage: string
  revision: number
}

export interface ProjectRegistryState {
  projects: Ref<ProjectSummary[]>
  selectedProjectId: Ref<string>
  selectedProject: ComputedRef<ProjectSummary | null>
  loadState: Ref<WorkbenchLoadState>
  initialize(): Promise<void>
  refresh(): Promise<void>
  retryAccess(projectId: string): Promise<void>
  chooseProject(isCurrent?: () => boolean): Promise<ProjectSummary | null>
  selectProject(projectId: string, isCurrent?: () => boolean): Promise<void>
  removeProject(projectId: string): Promise<void>
  previewProjectDeletion(projectId: string): Promise<DeletionPreview>
  deleteProjectHistory(projectId: string, token: string): Promise<void>
}

/** 可执行项必须同时是 active 且目录 available；不可用目录只允许查看。 */
export function isProjectExecutable(project: ProjectSummary | null | undefined): boolean {
  return Boolean(
    project && project.status === 'active' && project.availability.state === 'available'
  )
}

export function createWorkbenchLoadState(
  revision = 0,
  status: WorkbenchLoadStatus = 'idle',
  errorMessage = ''
): WorkbenchLoadState {
  return { status, errorMessage, revision }
}

function pickDefaultExecutableProjectId(projects: ProjectSummary[]): string {
  return projects.find((project) => isProjectExecutable(project))?.projectId ?? ''
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 管理持久 Project 列表与选中身份；不持有 Task 列表，也不把 unavailable 伪装成可执行。 */
export function useProjectRegistry(): ProjectRegistryState {
  const projects = ref<ProjectSummary[]>([])
  const selectedProjectId = ref('')
  const loadState = ref<WorkbenchLoadState>(createWorkbenchLoadState())
  let listRequestId = 0
  let selectionGeneration = 0

  const selectedProject = computed(
    () => projects.value.find((project) => project.projectId === selectedProjectId.value) ?? null
  )

  /**
   * 拉取 Project 列表。选择代次变化时丢弃整份旧列表，避免新选中项被过期摘要顶掉。
   * 失败只改 loadState，不清空已经展示的 projects。
   */
  async function loadProjects(): Promise<void> {
    const requestId = ++listRequestId
    const generationAtStart = selectionGeneration
    loadState.value = createWorkbenchLoadState(requestId, 'loading')
    try {
      const list = unwrapDesktopIpcResult(await window.app.listProjects())
      if (requestId !== listRequestId) return
      if (selectionGeneration !== generationAtStart) {
        if (projects.value.length === 0) projects.value = list
        loadState.value = createWorkbenchLoadState(requestId, 'ready')
        return
      }
      projects.value = list
      if (
        !selectedProjectId.value ||
        !list.some((item) => item.projectId === selectedProjectId.value)
      ) {
        selectedProjectId.value = pickDefaultExecutableProjectId(list)
      }
      loadState.value = createWorkbenchLoadState(requestId, 'ready')
    } catch (error) {
      if (requestId !== listRequestId) return
      loadState.value = createWorkbenchLoadState(requestId, 'error', readErrorMessage(error))
    }
  }

  async function initialize(): Promise<void> {
    selectedProjectId.value = ''
    await loadProjects()
  }

  async function refresh(): Promise<void> {
    await loadProjects()
  }

  /**
   * 没有单独 retry IPC：重新 listProjects，只用新摘要替换对应项。
   * 替换后仍按真实 availability/status 判断，不可用目录不得变成可执行项。
   */
  async function retryAccess(projectId: string): Promise<void> {
    const requestId = ++listRequestId
    const generationAtStart = selectionGeneration
    loadState.value = createWorkbenchLoadState(requestId, 'loading')
    try {
      const list = unwrapDesktopIpcResult(await window.app.listProjects())
      if (requestId !== listRequestId) return
      if (selectionGeneration !== generationAtStart) {
        loadState.value = createWorkbenchLoadState(requestId, 'ready')
        return
      }
      const updated = list.find((item) => item.projectId === projectId)
      if (updated) {
        const exists = projects.value.some((item) => item.projectId === projectId)
        projects.value = exists
          ? projects.value.map((item) => (item.projectId === projectId ? updated : item))
          : [...projects.value, updated]
      }
      loadState.value = createWorkbenchLoadState(requestId, 'ready')
    } catch (error) {
      if (requestId !== listRequestId) return
      loadState.value = createWorkbenchLoadState(requestId, 'error', readErrorMessage(error))
    }
  }

  async function chooseProject(
    isCurrent: () => boolean = () => true
  ): Promise<ProjectSummary | null> {
    const project = unwrapDesktopIpcResult(await window.app.chooseProject())
    if (!project || !isCurrent()) return null
    projects.value = [
      project,
      ...projects.value.filter((item) => item.projectId !== project.projectId)
    ]
    await selectProject(project.projectId, isCurrent)
    return isCurrent() ? project : null
  }

  /** 只切换选中身份并推进 revision；旧 list 响应不得据此回写默认选择。 */
  async function selectProject(
    projectId: string,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    if (!projectId || !isCurrent()) return
    selectionGeneration += 1
    selectedProjectId.value = projectId
    loadState.value = {
      ...loadState.value,
      revision: selectionGeneration
    }
  }

  async function removeProject(projectId: string): Promise<void> {
    unwrapDesktopIpcResult(await window.app.removeProject(projectId))
    await refresh()
    if (selectedProjectId.value === projectId) {
      selectedProjectId.value = pickDefaultExecutableProjectId(projects.value)
    }
  }

  async function previewProjectDeletion(projectId: string): Promise<DeletionPreview> {
    return unwrapDesktopIpcResult(await window.app.previewProjectHistoryDeletion(projectId))
  }

  async function deleteProjectHistory(projectId: string, token: string): Promise<void> {
    unwrapDesktopIpcResult(await window.app.deleteProjectHistory(projectId, token))
  }

  return {
    projects,
    selectedProjectId,
    selectedProject,
    loadState,
    initialize,
    refresh,
    retryAccess,
    chooseProject,
    selectProject,
    removeProject,
    previewProjectDeletion,
    deleteProjectHistory
  }
}
