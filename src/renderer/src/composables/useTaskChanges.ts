import {
  computed,
  ref,
  toValue,
  watch,
  type ComputedRef,
  type MaybeRefOrGetter,
  type Ref
} from 'vue'
import type { CommandExecutionEvidence } from '../../../shared/command'
import type {
  FileDiffResult,
  LatestTurnRestorePreview,
  LatestTurnRestoreResult,
  TaskChangeSetQueryResult
} from '../../../shared/git-review'
import type { DesktopIpcResult } from '../../../shared/ipc-result'
import {
  executeTurnRewind,
  type ExecuteTurnRewindResult
} from '../../../shared/turn-rewind-execute'
import type { TurnRewindPreview, TurnRewindSelection } from '../../../shared/turn-rewind-preview'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'
import { restoreAppliedNotice } from '../task-changes-presentation'

export interface TaskChangesQueryApi {
  getChangeSet: (taskId: string) => Promise<DesktopIpcResult<TaskChangeSetQueryResult>>
  getFileDiff: (taskId: string, path: string) => Promise<DesktopIpcResult<FileDiffResult>>
  getCommandEvidence: (
    taskId: string,
    commandId: string
  ) => Promise<DesktopIpcResult<CommandExecutionEvidence>>
  previewLatestTurnRestore?: (taskId: string) => Promise<DesktopIpcResult<LatestTurnRestorePreview>>
  restoreLatestTurn?: (taskId: string) => Promise<DesktopIpcResult<LatestTurnRestoreResult>>
  startTurn?: (taskId: string, prompt: string) => Promise<DesktopIpcResult<unknown>>
}

interface QuerySlot<T> {
  loading: boolean
  errorMessage: string
  result: T | null
}

export interface TaskChangesController {
  changeSet: Ref<TaskChangeSetQueryResult | null>
  loading: Ref<boolean>
  errorMessage: Ref<string>
  selectedPath: Ref<string>
  selectedDiff: ComputedRef<FileDiffResult | null>
  selectedDiffLoading: ComputedRef<boolean>
  selectedDiffError: ComputedRef<string>
  selectedCommandId: Ref<string>
  selectedCommandEvidence: ComputedRef<CommandExecutionEvidence | null>
  selectedCommandLoading: ComputedRef<boolean>
  selectedCommandError: ComputedRef<string>
  reload(): Promise<void>
  selectPath(path: string): Promise<void>
  retryFileDiff(): Promise<void>
  selectCommand(commandId: string): Promise<void>
  retryCommandEvidence(): Promise<void>
  restorePreview: Ref<LatestTurnRestorePreview | null>
  restoreBusy: Ref<boolean>
  restoreError: Ref<string>
  restoreMessage: Ref<string>
  openRestorePreview(): Promise<void>
  cancelRestorePreview(): void
  confirmRestore(): Promise<void>
  confirmTurnRewind(preview: TurnRewindPreview, selection: TurnRewindSelection): Promise<void>
  dispose(): void
}

function defaultApi(): TaskChangesQueryApi {
  return {
    getChangeSet: (taskId) => window.task.getChangeSet(taskId),
    getFileDiff: (taskId, path) => window.task.getFileDiff(taskId, path),
    getCommandEvidence: (taskId, commandId) => window.task.getCommandEvidence(taskId, commandId),
    previewLatestTurnRestore: (taskId) => window.task.previewLatestTurnRestore(taskId),
    restoreLatestTurn: (taskId) => window.task.restoreLatestTurn(taskId),
    startTurn: (taskId, prompt) => window.agent.startTurn(taskId, prompt)
  }
}

/** 允许 App 注入对话 startTurn，同时保留默认的变更审阅 IPC。 */
export function createTaskChangesQueryApi(
  overrides: Partial<TaskChangesQueryApi> = {}
): TaskChangesQueryApi {
  return { ...defaultApi(), ...overrides }
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function emptySlot<T>(): QuerySlot<T> {
  return { loading: false, errorMessage: '', result: null }
}

/**
 * 按需拉取 Task 变更审阅。选 Task 才 getChangeSet；点文件才 getFileDiff，不预取全部 Diff。
 */
export function useTaskChanges(
  taskId: MaybeRefOrGetter<string>,
  api: TaskChangesQueryApi = defaultApi()
): TaskChangesController {
  const changeSet = ref<TaskChangeSetQueryResult | null>(null)
  const loading = ref(Boolean(toValue(taskId)))
  const errorMessage = ref('')
  const selectedPath = ref('')
  const selectedCommandId = ref('')
  const fileDiffs = ref<Record<string, QuerySlot<FileDiffResult>>>({})
  const commandEvidence = ref<Record<string, QuerySlot<CommandExecutionEvidence>>>({})
  const restorePreview = ref<LatestTurnRestorePreview | null>(null)
  const restoreBusy = ref(false)
  const restoreError = ref('')
  const restoreMessage = ref('')
  let changeSetGeneration = 0
  let disposed = false

  const selectedDiff = computed(() => fileDiffs.value[selectedPath.value]?.result ?? null)
  const selectedDiffLoading = computed(() => fileDiffs.value[selectedPath.value]?.loading === true)
  const selectedDiffError = computed(() => fileDiffs.value[selectedPath.value]?.errorMessage ?? '')
  const selectedCommandEvidence = computed(
    () => commandEvidence.value[selectedCommandId.value]?.result ?? null
  )
  const selectedCommandLoading = computed(
    () => commandEvidence.value[selectedCommandId.value]?.loading === true
  )
  const selectedCommandError = computed(
    () => commandEvidence.value[selectedCommandId.value]?.errorMessage ?? ''
  )

  function resetSelection(): void {
    selectedPath.value = ''
    selectedCommandId.value = ''
    fileDiffs.value = {}
    commandEvidence.value = {}
    restorePreview.value = null
    restoreError.value = ''
    restoreMessage.value = ''
  }

  /** 丢弃过期请求，避免切 Task 后把旧快照写进新面板。 */
  async function loadChangeSet(id: string, keepSelection: boolean): Promise<void> {
    const generation = ++changeSetGeneration
    if (!keepSelection) resetSelection()
    if (!id) {
      changeSet.value = null
      loading.value = false
      errorMessage.value = ''
      return
    }
    loading.value = true
    errorMessage.value = ''
    try {
      const result = unwrapDesktopIpcResult(await api.getChangeSet(id))
      if (disposed || generation !== changeSetGeneration) return
      changeSet.value = result
    } catch (error) {
      if (disposed || generation !== changeSetGeneration) return
      changeSet.value = null
      errorMessage.value = readErrorMessage(error)
    } finally {
      if (!disposed && generation === changeSetGeneration) loading.value = false
    }
  }

  async function loadFileDiff(path: string): Promise<void> {
    const id = toValue(taskId)
    if (!id || !path) return
    const generation = changeSetGeneration
    fileDiffs.value = {
      ...fileDiffs.value,
      [path]: { loading: true, errorMessage: '', result: null }
    }
    try {
      const result = unwrapDesktopIpcResult(await api.getFileDiff(id, path))
      if (disposed || generation !== changeSetGeneration) return
      fileDiffs.value = {
        ...fileDiffs.value,
        [path]: { loading: false, errorMessage: '', result }
      }
    } catch (error) {
      if (disposed || generation !== changeSetGeneration) return
      fileDiffs.value = {
        ...fileDiffs.value,
        [path]: { loading: false, errorMessage: readErrorMessage(error), result: null }
      }
    }
  }

  async function loadCommandEvidence(commandId: string): Promise<void> {
    const id = toValue(taskId)
    if (!id || !commandId) return
    const generation = changeSetGeneration
    commandEvidence.value = {
      ...commandEvidence.value,
      [commandId]: { loading: true, errorMessage: '', result: null }
    }
    try {
      const result = unwrapDesktopIpcResult(await api.getCommandEvidence(id, commandId))
      if (disposed || generation !== changeSetGeneration) return
      commandEvidence.value = {
        ...commandEvidence.value,
        [commandId]: { loading: false, errorMessage: '', result }
      }
    } catch (error) {
      if (disposed || generation !== changeSetGeneration) return
      commandEvidence.value = {
        ...commandEvidence.value,
        [commandId]: { loading: false, errorMessage: readErrorMessage(error), result: null }
      }
    }
  }

  async function selectPath(path: string): Promise<void> {
    selectedPath.value = path
    const cached = fileDiffs.value[path]
    if (cached?.result || cached?.loading) return
    await loadFileDiff(path)
  }

  async function retryFileDiff(): Promise<void> {
    const path = selectedPath.value
    if (!path) return
    fileDiffs.value = { ...fileDiffs.value, [path]: emptySlot() }
    await loadFileDiff(path)
  }

  async function selectCommand(commandId: string): Promise<void> {
    selectedCommandId.value = commandId
    const cached = commandEvidence.value[commandId]
    if (cached?.result || cached?.loading) return
    await loadCommandEvidence(commandId)
  }

  async function retryCommandEvidence(): Promise<void> {
    const commandId = selectedCommandId.value
    if (!commandId) return
    commandEvidence.value = { ...commandEvidence.value, [commandId]: emptySlot() }
    await loadCommandEvidence(commandId)
  }

  async function reload(): Promise<void> {
    const path = selectedPath.value
    const commandId = selectedCommandId.value
    fileDiffs.value = {}
    commandEvidence.value = {}
    restorePreview.value = null
    restoreError.value = ''
    await loadChangeSet(toValue(taskId), true)
    if (path) await selectPath(path)
    if (commandId) await selectCommand(commandId)
  }

  async function openRestorePreview(): Promise<void> {
    const id = toValue(taskId)
    const previewApi = api.previewLatestTurnRestore
    if (!id || !previewApi || restoreBusy.value) return
    restoreBusy.value = true
    restoreError.value = ''
    restoreMessage.value = ''
    try {
      restorePreview.value = unwrapDesktopIpcResult(await previewApi(id))
    } catch (error) {
      restorePreview.value = null
      restoreError.value = readErrorMessage(error)
    } finally {
      restoreBusy.value = false
    }
  }

  function cancelRestorePreview(): void {
    restorePreview.value = null
    restoreError.value = ''
  }

  async function confirmRestore(): Promise<void> {
    const id = toValue(taskId)
    const restoreApi = api.restoreLatestTurn
    if (!id || !restoreApi || restoreBusy.value) return
    if (restorePreview.value?.revertible.kind !== 'latest-turn') {
      restoreError.value = '当前不能自动恢复上一轮文件。'
      return
    }
    restoreBusy.value = true
    restoreError.value = ''
    try {
      const result = unwrapDesktopIpcResult(await restoreApi(id))
      const notice = restoreAppliedNotice(result)
      restorePreview.value = null
      if (!result.ok) {
        if (result.appliedPaths?.length) await reload()
        restoreError.value = notice
        return
      }
      await reload()
      restoreMessage.value = notice
    } catch (error) {
      restoreError.value = readErrorMessage(error)
    } finally {
      restoreBusy.value = false
    }
  }

  /**
   * 按勾选执行整次回退：先文件后对话。
   * 文件失败不再发对话；对话失败不回滚已恢复文件；未预览不得直接 restore。
   */
  async function confirmTurnRewind(
    preview: TurnRewindPreview,
    selection: TurnRewindSelection
  ): Promise<void> {
    if (restoreBusy.value) return
    restoreBusy.value = true
    restoreError.value = ''
    restoreMessage.value = ''
    try {
      const result = await executeTurnRewind({
        preview,
        selection,
        restoreLatestTurn: async () => {
          const id = toValue(taskId)
          const restoreApi = api.restoreLatestTurn
          if (!id || !restoreApi) {
            return { ok: false, message: '当前不能自动恢复上一轮文件。' }
          }
          return unwrapDesktopIpcResult(await restoreApi(id))
        },
        startTurn: async (prompt) => {
          const id = toValue(taskId)
          const send = api.startTurn
          if (!id || !send) {
            throw new Error('当前不能发送对话回退。')
          }
          unwrapDesktopIpcResult(await send(id, prompt))
        }
      })
      await applyTurnRewindResult(result)
    } catch (error) {
      restoreError.value = readErrorMessage(error)
    } finally {
      restoreBusy.value = false
    }
  }

  /** 成功/失败分开展示，禁止一侧失败时假装另一侧没发生。 */
  async function applyTurnRewindResult(result: ExecuteTurnRewindResult): Promise<void> {
    if (result.status === 'noop') return
    if (result.status === 'completed') {
      if (result.files) {
        restorePreview.value = null
        await reload()
        restoreMessage.value = restoreAppliedNotice({
          message: result.files.message ?? '已恢复上一轮文件。',
          appliedPaths: result.files.appliedPaths
        })
      }
      if (result.conversationPrompt) {
        const conversationNotice = '已发送对话回退。'
        restoreMessage.value = restoreMessage.value
          ? `${restoreMessage.value} ${conversationNotice}`
          : conversationNotice
      }
      return
    }
    if (result.status === 'files-failed') {
      if (result.files?.appliedPaths?.length) {
        restorePreview.value = null
        await reload()
      }
      restoreError.value = result.files
        ? restoreAppliedNotice({
            message: result.error,
            appliedPaths: result.files.appliedPaths
          })
        : result.error
      return
    }
    if (result.files?.ok) {
      restorePreview.value = null
      await reload()
      restoreMessage.value = restoreAppliedNotice({
        message: result.files.message ?? '已恢复上一轮文件。',
        appliedPaths: result.files.appliedPaths
      })
    }
    restoreError.value = result.error
  }

  function dispose(): void {
    disposed = true
    changeSetGeneration += 1
  }

  watch(
    () => toValue(taskId),
    (id) => {
      void loadChangeSet(id, false)
    },
    { immediate: true }
  )

  return {
    changeSet,
    loading,
    errorMessage,
    selectedPath,
    selectedDiff,
    selectedDiffLoading,
    selectedDiffError,
    selectedCommandId,
    selectedCommandEvidence,
    selectedCommandLoading,
    selectedCommandError,
    reload,
    selectPath,
    retryFileDiff,
    selectCommand,
    retryCommandEvidence,
    restorePreview,
    restoreBusy,
    restoreError,
    restoreMessage,
    openRestorePreview,
    cancelRestorePreview,
    confirmRestore,
    confirmTurnRewind,
    dispose
  }
}
