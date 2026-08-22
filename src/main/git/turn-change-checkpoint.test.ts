import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TurnChangeCheckpoint } from '../../shared/git-review'
import { MAX_CHECKPOINT_LIST_ITEMS, TurnChangeCheckpointStore } from './turn-change-checkpoint'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('TurnChangeCheckpointStore', () => {
  it('按 taskId/turnId 往返，list 按 capturedBeforeAt 排序', async () => {
    const store = new TurnChangeCheckpointStore({ rootDir: await createTemporaryDirectory() })
    const first = sampleCheckpoint({
      turnId: 'turn-1',
      capturedBeforeAt: '2026-08-22T10:00:00.000Z',
      status: 'complete',
      capturedAfterAt: '2026-08-22T10:01:00.000Z',
      afterPaths: [{ path: 'README.md', kind: 'tracked', contentHash: 'a'.repeat(64) }],
      affectedPaths: ['README.md']
    })
    const second = sampleCheckpoint({
      turnId: 'turn-2',
      capturedBeforeAt: '2026-08-22T11:00:00.000Z',
      previousCheckpointId: 'turn-1',
      status: 'incomplete'
    })
    await store.put(second)
    await store.put(first)

    expect(await store.get('task-1', 'turn-1')).toMatchObject({
      turnId: 'turn-1',
      status: 'complete'
    })
    const listed = await store.list('task-1')
    expect(listed.truncated).toBe(false)
    expect(listed.items.map((item) => item.turnId)).toEqual(['turn-1', 'turn-2'])
    expect(JSON.stringify(listed)).not.toContain('/Users/')
    expect(JSON.stringify(listed)).not.toContain('fingerprint')
  })

  it('触达 list 上限时标记 truncated，不得把截断结果当成完整最新链', async () => {
    const store = new TurnChangeCheckpointStore({ rootDir: await createTemporaryDirectory() })
    for (let index = 0; index <= MAX_CHECKPOINT_LIST_ITEMS; index += 1) {
      const hour = String(Math.floor(index / 60)).padStart(2, '0')
      const minute = String(index % 60).padStart(2, '0')
      await store.put(
        sampleCheckpoint({
          turnId: `turn-${String(index).padStart(3, '0')}`,
          capturedBeforeAt: `2026-08-21T${hour}:${minute}:00.000Z`
        })
      )
    }
    const listed = await store.list('task-1')
    expect(listed.truncated).toBe(true)
    expect(listed.items.length).toBeLessThanOrEqual(MAX_CHECKPOINT_LIST_ITEMS)
  })

  it('拒绝路径穿越身份', async () => {
    const store = new TurnChangeCheckpointStore({ rootDir: await createTemporaryDirectory() })
    await expect(store.get('../escape', 'turn-1')).rejects.toThrow()
    await expect(store.list('..')).rejects.toThrow()
  })
})

function sampleCheckpoint(overrides: Partial<TurnChangeCheckpoint> = {}): TurnChangeCheckpoint {
  return {
    schemaVersion: 1,
    taskId: 'task-1',
    turnId: 'turn-1',
    environmentId: 'local:testenv',
    capturedBeforeAt: '2026-08-22T10:00:00.000Z',
    status: 'incomplete',
    beforePaths: [],
    affectedPaths: [],
    ...overrides
  }
}

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-studio-checkpoint-'))
  temporaryDirectories.push(path)
  return path
}
