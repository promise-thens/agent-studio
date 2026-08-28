import { nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { ArtifactContent, ArtifactDescriptor } from '../../../shared/artifact'
import type { DesktopIpcResult } from '../../../shared/ipc-result'
import { useTaskArtifacts, type TaskArtifactsQueryApi } from './useTaskArtifacts'

function ok<T>(value: T): DesktopIpcResult<T> {
  return { ok: true, value }
}

function descriptor(overrides: Partial<ArtifactDescriptor> = {}): ArtifactDescriptor {
  return {
    artifactId: 'art-1',
    projectId: 'project-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    kind: 'markdown',
    title: 'README.md',
    mimeType: 'text/markdown',
    source: 'git-review',
    environmentId: 'local:env',
    location: { kind: 'file', relativePath: 'README.md' },
    size: 12,
    contentHash: 'abc',
    createdAt: '2026-08-28T00:00:00.000Z',
    trustLevel: 'verified',
    availability: 'ready',
    revision: 1,
    ...overrides
  }
}

function createApi(overrides: Partial<TaskArtifactsQueryApi> = {}): TaskArtifactsQueryApi {
  return {
    listArtifacts: vi.fn(async () => ok([descriptor()])),
    getArtifactContent: vi.fn(async () =>
      ok({
        kind: 'markdown',
        markdown: '# hi',
        descriptor: descriptor()
      } satisfies ArtifactContent)
    ),
    ...overrides
  }
}

describe('useTaskArtifacts', () => {
  it('选中 Task 后拉列表，点开才读正文', async () => {
    const api = createApi()
    const controller = useTaskArtifacts('task-1', api)
    await nextTick()
    await Promise.resolve()
    expect(controller.items.value).toEqual([descriptor()])
    expect(api.getArtifactContent).not.toHaveBeenCalled()

    await controller.select('art-1')
    expect(controller.selectedContent.value).toMatchObject({ kind: 'markdown', markdown: '# hi' })
    expect(api.getArtifactContent).toHaveBeenCalledWith('task-1', 'art-1')
    controller.dispose()
  })

  it('切换 Task 丢弃旧选择', async () => {
    const api = createApi()
    const taskId = ref('task-1')
    const controller = useTaskArtifacts(taskId, api)
    await nextTick()
    await Promise.resolve()
    await controller.select('art-1')
    taskId.value = 'task-2'
    await nextTick()
    await Promise.resolve()
    expect(controller.selectedId.value).toBe('')
    expect(controller.selectedContent.value).toBeNull()
    controller.dispose()
  })
})
