import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseCommandExecutionEvidence,
  parseCommandTranscriptRef,
  type CommandExecutionEvidence
} from '../../shared/command'
import { CommandEvidenceStore, MAX_COMMAND_TRANSCRIPT_BYTES } from './command-evidence-store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function createStore(): Promise<CommandEvidenceStore> {
  return new CommandEvidenceStore({ rootDir: await createStoreRoot() })
}

function sampleEvidence(
  overrides: Partial<CommandExecutionEvidence> = {}
): CommandExecutionEvidence {
  return {
    commandId: 'cmd-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    environmentId: 'env-1',
    source: 'app-runner',
    displayCommand: 'node -e process.stdout.write("ok")',
    cwd: '.',
    startedAt: '2026-08-22T10:00:00.000Z',
    endedAt: '2026-08-22T10:00:01.000Z',
    exitCode: 0,
    timedOut: false,
    status: 'succeeded',
    transcriptRef: {
      transcriptId: 'transcript-1',
      availableBytes: 2,
      totalBytes: 2,
      truncated: false,
      encoding: 'utf-8',
      retentionPolicy: 'bounded',
      retentionState: 'retained'
    },
    truncated: false,
    trustLevel: 'app-enforced',
    ...overrides
  }
}

describe('CommandEvidenceStore', () => {
  it('原子写入证据和有界 transcript，引用不含文件系统路径', async () => {
    const store = new CommandEvidenceStore({
      rootDir: await createStoreRoot()
    })
    const transcriptRef = await store.writeTranscript({
      transcriptId: 'transcript-1',
      commandId: 'cmd-1',
      taskId: 'task-1',
      chunks: [
        { stream: 'stdout', text: 'ok' },
        { stream: 'stderr', text: '' }
      ],
      totalBytes: 2,
      truncated: false
    })
    const evidence = sampleEvidence({ transcriptRef, truncated: transcriptRef.truncated })
    await store.writeEvidence(evidence)

    const loaded = await store.readEvidence('task-1', 'cmd-1')
    const transcript = await store.readTranscript('task-1', 'transcript-1')
    expect(parseCommandExecutionEvidence(loaded)).toEqual(loaded)
    expect(parseCommandTranscriptRef(loaded?.transcriptRef)).toEqual(transcriptRef)
    expect(transcriptRef).not.toHaveProperty('path')
    expect(transcriptRef).not.toHaveProperty('filePath')
    expect(JSON.stringify(loaded)).not.toContain(store.rootDir)
    expect(transcript?.chunks[0]?.text).toBe('ok')
    expect(transcript).not.toHaveProperty('path')
  })

  it('拒绝把路径穿越身份写进存储根之外', async () => {
    const store = await createStore()
    await expect(
      store.writeEvidence(sampleEvidence({ taskId: '../escape', commandId: 'cmd-1' }))
    ).rejects.toThrow()
    await expect(
      store.writeTranscript({
        transcriptId: '../escape',
        commandId: 'cmd-1',
        taskId: 'task-1',
        chunks: [],
        totalBytes: 0,
        truncated: false
      })
    ).rejects.toThrow()
  })

  it('导出的 transcript 字节上限与历史事件 256KiB 同量级', () => {
    expect(MAX_COMMAND_TRANSCRIPT_BYTES).toBe(256 * 1024)
  })

  it('直接写入超长正文时仍按字节上限截断并标记 truncated', async () => {
    const store = await createStore()
    const oversized = MAX_COMMAND_TRANSCRIPT_BYTES + 8 * 1024
    const transcriptRef = await store.writeTranscript({
      transcriptId: 'transcript-oversize',
      commandId: 'cmd-oversize',
      taskId: 'task-1',
      chunks: [{ stream: 'stdout', text: 'A'.repeat(oversized) }],
      totalBytes: oversized,
      truncated: false
    })
    const transcript = await store.readTranscript('task-1', 'transcript-oversize')
    const storedBytes = Buffer.byteLength(
      transcript?.chunks.map((chunk) => chunk.text).join('') ?? '',
      'utf8'
    )

    expect(transcriptRef.truncated).toBe(true)
    expect(transcriptRef.availableBytes).toBeLessThanOrEqual(MAX_COMMAND_TRANSCRIPT_BYTES)
    expect(transcriptRef.totalBytes).toBeGreaterThan(transcriptRef.availableBytes)
    expect(transcript?.truncated).toBe(true)
    expect(storedBytes).toBeLessThanOrEqual(MAX_COMMAND_TRANSCRIPT_BYTES)
    expect(storedBytes).toBe(transcriptRef.availableBytes)
  })

  it('按 taskId 列出证据，跳过临时文件并不泄漏其它 Task', async () => {
    const store = await createStore()
    await store.writeEvidence(
      sampleEvidence({ commandId: 'cmd-b', startedAt: '2026-08-22T10:00:02.000Z' })
    )
    await store.writeEvidence(
      sampleEvidence({ commandId: 'cmd-a', startedAt: '2026-08-22T10:00:01.000Z' })
    )
    await store.writeEvidence(
      sampleEvidence({
        taskId: 'task-2',
        commandId: 'cmd-other',
        transcriptRef: {
          transcriptId: 'transcript-other',
          availableBytes: 0,
          truncated: false,
          encoding: 'utf-8',
          retentionPolicy: 'bounded',
          retentionState: 'retained'
        }
      })
    )
    const commandsDir = join(store.rootDir, 'task-1', 'commands')
    await writeFile(join(commandsDir, '.pending.json.tmp'), '{"schemaVersion":1}\n')

    const listed = await store.listEvidence('task-1')
    expect(listed.map((item) => item.commandId)).toEqual(['cmd-a', 'cmd-b'])
    expect(listed.every((item) => item.taskId === 'task-1')).toBe(true)
    expect(JSON.stringify(listed)).not.toContain(store.rootDir)
  })

  it('拒绝把路径穿越身份用于 listEvidence', async () => {
    const store = await createStore()
    await expect(store.listEvidence('../escape')).rejects.toThrow()
    await expect(store.listEvidence('.')).rejects.toThrow()
  })
})

async function createStoreRoot(): Promise<string> {
  const rootDir = await realpath(await mkdtemp(join(tmpdir(), 'agent-studio-command-store-')))
  temporaryDirectories.push(rootDir)
  return rootDir
}
