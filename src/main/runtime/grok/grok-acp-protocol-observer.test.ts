import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createGrokAcpFileObserver,
  describeSessionIdShape,
  summarizeInitializeResponse,
  summarizePermissionRequest,
  summarizeSessionUpdate
} from './grok-acp-protocol-observer'

const FAKE_KEY = 'sk-fake-gacp01-observer'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('GACP-01 协议观察摘要', () => {
  it('initialize 只保留声明布尔，不复制 _meta 或 providers 内容', () => {
    const record = summarizeInitializeResponse(
      {
        protocolVersion: 1,
        agentInfo: { name: 'grok-build', version: '1.0.0', _meta: { secret: FAKE_KEY } },
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {}, close: {} },
          promptCapabilities: { image: false },
          providers: { secret: FAKE_KEY }
        },
        authMethods: [{ id: FAKE_KEY }],
        _meta: { secret: FAKE_KEY }
      },
      1
    )

    expect(record).toMatchObject({
      kind: 'initialize',
      protocolVersion: 1,
      protocolVersionMatches: true,
      hasAgentInfoName: true,
      hasAgentInfoVersion: true,
      loadSession: true,
      resumeDeclared: true,
      closeDeclared: true,
      promptImage: false,
      promptAudio: 'absent',
      hasAuth: true,
      hasProviders: true,
      hasMeta: true
    })
    expect(JSON.stringify(record)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(record)).not.toContain('providers')
  })

  it('session/update 只记类型和布尔，不记 path 或文本', () => {
    const record = summarizeSessionUpdate({
      sessionUpdate: 'tool_call',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: `C:\\\\Users\\\\secret\\\\${FAKE_KEY}.ts` }],
      content: [{ type: 'diff', path: '/secret', oldText: FAKE_KEY, newText: FAKE_KEY }]
    })

    expect(record).toMatchObject({
      sessionUpdate: 'tool_call',
      toolKind: 'edit',
      status: 'pending',
      hasLocations: true,
      locationHasPath: true,
      hasDiffContent: true
    })
    expect(JSON.stringify(record)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(record)).not.toContain('Users')
  })

  it('权限摘要只记 kind 集合，不记 optionId 或 rawInput', () => {
    const record = summarizePermissionRequest({
      options: [
        { optionId: 'allow-always', kind: 'allow_always' },
        { optionId: FAKE_KEY, kind: 'reject_once' }
      ],
      toolCall: {
        kind: 'execute',
        name: `bash-${FAKE_KEY}`,
        rawInput: { command: `echo ${FAKE_KEY}` },
        locations: [{ path: '/tmp/fixture/notes.txt' }]
      }
    })

    expect(record).toMatchObject({
      optionKinds: ['allow_always', 'reject_once'],
      uniqueAllowOnce: false,
      uniqueRejectOnce: true,
      toolCallKind: 'execute',
      hasLocationPath: true,
      hasRawInput: true,
      hasName: true
    })
    expect(JSON.stringify(record)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(record)).not.toContain('echo')
  })

  it('sessionId 只输出形态', () => {
    expect(describeSessionIdShape('550e8400-e29b-41d4-a716-446655440000')).toBe('uuid')
    expect(describeSessionIdShape('sess_abc')).toBe('opaque-nonempty')
    expect(describeSessionIdShape('')).toBe('empty')
  })

  it('文件观察器写入 JSONL 且不含密钥', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gacp01-observer-'))
    roots.push(root)
    const filePath = join(root, 'protocol.jsonl')
    const observer = createGrokAcpFileObserver(filePath)
    observer.record({
      kind: 'set-model',
      accepted: true,
      responseShape: 'object'
    })
    await observer.flush?.()
    const text = await readFile(filePath, 'utf8')
    expect(text).toContain('"responseShape":"object"')
    expect(text).not.toContain(FAKE_KEY)
  })
})
