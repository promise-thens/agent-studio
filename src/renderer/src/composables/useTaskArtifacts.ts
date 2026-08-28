import { ref, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue'
import type { ArtifactContent, ArtifactDescriptor } from '../../../shared/artifact'
import type { DesktopIpcResult } from '../../../shared/ipc-result'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'

export interface TaskArtifactsQueryApi {
  listArtifacts: (taskId: string) => Promise<DesktopIpcResult<ArtifactDescriptor[]>>
  getArtifactContent: (
    taskId: string,
    artifactId: string
  ) => Promise<DesktopIpcResult<ArtifactContent>>
}

export interface TaskArtifactsController {
  items: Ref<ArtifactDescriptor[]>
  loading: Ref<boolean>
  errorMessage: Ref<string>
  selectedId: Ref<string>
  selectedContent: Ref<ArtifactContent | null>
  contentLoading: Ref<boolean>
  contentError: Ref<string>
  reload(): Promise<void>
  select(artifactId: string): Promise<void>
  retryContent(): Promise<void>
  dispose(): void
}

function defaultApi(): TaskArtifactsQueryApi {
  return {
    listArtifacts: (taskId) => window.task.listArtifacts(taskId),
    getArtifactContent: (taskId, artifactId) => window.task.getArtifactContent(taskId, artifactId)
  }
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 选中 Task 后拉产物列表；点开某一项才读取正文，避免一次把所有图片塞进内存。
 */
export function useTaskArtifacts(
  taskId: MaybeRefOrGetter<string>,
  api: TaskArtifactsQueryApi = defaultApi()
): TaskArtifactsController {
  const items = ref<ArtifactDescriptor[]>([])
  const loading = ref(Boolean(toValue(taskId)))
  const errorMessage = ref('')
  const selectedId = ref('')
  const selectedContent = ref<ArtifactContent | null>(null)
  const contentLoading = ref(false)
  const contentError = ref('')
  let generation = 0
  let disposed = false

  function resetSelection(): void {
    selectedId.value = ''
    selectedContent.value = null
    contentError.value = ''
  }

  async function loadList(id: string): Promise<void> {
    const current = ++generation
    resetSelection()
    if (!id) {
      items.value = []
      loading.value = false
      errorMessage.value = ''
      return
    }
    loading.value = true
    errorMessage.value = ''
    try {
      const listed = unwrapDesktopIpcResult(await api.listArtifacts(id))
      if (disposed || current !== generation) return
      items.value = listed
    } catch (error) {
      if (disposed || current !== generation) return
      items.value = []
      errorMessage.value = readErrorMessage(error)
    } finally {
      if (!disposed && current === generation) loading.value = false
    }
  }

  async function loadContent(artifactId: string): Promise<void> {
    const id = toValue(taskId)
    if (!id || !artifactId) return
    const current = generation
    contentLoading.value = true
    contentError.value = ''
    selectedContent.value = null
    try {
      const content = unwrapDesktopIpcResult(await api.getArtifactContent(id, artifactId))
      if (disposed || current !== generation || selectedId.value !== artifactId) return
      selectedContent.value = content
    } catch (error) {
      if (disposed || current !== generation || selectedId.value !== artifactId) return
      contentError.value = readErrorMessage(error)
    } finally {
      if (!disposed && current === generation && selectedId.value === artifactId) {
        contentLoading.value = false
      }
    }
  }

  async function reload(): Promise<void> {
    await loadList(toValue(taskId))
  }

  async function select(artifactId: string): Promise<void> {
    selectedId.value = artifactId
    await loadContent(artifactId)
  }

  async function retryContent(): Promise<void> {
    if (selectedId.value) await loadContent(selectedId.value)
  }

  function dispose(): void {
    disposed = true
  }

  watch(
    () => toValue(taskId),
    (id) => {
      void loadList(id)
    },
    { immediate: true }
  )

  return {
    items,
    loading,
    errorMessage,
    selectedId,
    selectedContent,
    contentLoading,
    contentError,
    reload,
    select,
    retryContent,
    dispose
  }
}
