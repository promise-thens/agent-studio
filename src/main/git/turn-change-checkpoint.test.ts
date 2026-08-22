import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TurnChangeCheckpoint } from '../../shared/git-review'
import { TurnChangeCheckpointStore } from './turn-change-checkpoint'

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
    expect(listed.map((item) => item.turnId)).toEqual(['turn-1', 'turn-2'])
    expect(JSON.stringify(listed)).not.toContain('/Users/')
    expect(JSON.stringify(listed)).not.toContain('fingerprint')
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
