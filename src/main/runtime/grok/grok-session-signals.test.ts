import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildGrokSessionSignalsPath,
  readGrokSessionContextUsage,
  type GrokSessionSignalsInput
} from './grok-session-signals'

const WORKSPACE = '/tmp/agent-studio-signals-workspace'
const SESSION_ID = 'runtime-session-1'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Grok session signals 上下文用量读取', () => {
  it('按编码 workspace 和 sessionId 读取有限字段', async () => {
    const grokHome = await createHome()
    await writeSignals(grokHome, {
      contextTokensUsed: 18941,
      contextWindowTokens: 32768,
      contextWindowUsage: 57,
      primaryModelId: 'grok-4.6',
      secret: 'must-not-leak'
    })

    await expect(readGrokSessionContextUsage(input(grokHome))).resolves.toEqual({
      scope: 'context',
      usedTokens: 18941,
      limitTokens: 32768
    })
  })

  it.each([
    ['missing file', undefined],
    ['broken json', '{"contextTokensUsed":'],
    ['array root', '[]'],
    ['negative used', JSON.stringify({ contextTokensUsed: -1, contextWindowTokens: 10 })],
    ['fractional used', JSON.stringify({ contextTokensUsed: 1.5, contextWindowTokens: 10 })],
    ['zero limit', JSON.stringify({ contextTokensUsed: 0, contextWindowTokens: 0 })],
    ['used exceeds limit', JSON.stringify({ contextTokensUsed: 11, contextWindowTokens: 10 })],
    [
      'invalid percentage',
      JSON.stringify({ contextTokensUsed: 1, contextWindowTokens: 10, contextWindowUsage: 101 })
    ]
  ])('异常 signals（%s）返回 null', async (_label, contents) => {
    const grokHome = await createHome()
    if (contents !== undefined) await writeSignalsRaw(grokHome, contents)

    await expect(readGrokSessionContextUsage(input(grokHome))).resolves.toBeNull()
  })

  it('百分比与 token 值有四舍五入差异时仍以 token 字段为准', async () => {
    const grokHome = await createHome()
    await writeSignals(grokHome, {
      contextTokensUsed: 1,
      contextWindowTokens: 3,
      contextWindowUsage: 34
    })

    await expect(readGrokSessionContextUsage(input(grokHome))).resolves.toEqual({
      scope: 'context',
      usedTokens: 1,
      limitTokens: 3
    })
  })

  it('不读取相邻 workspace/session 的文件', async () => {
    const grokHome = await createHome()
    await writeSignals(grokHome, {
      contextTokensUsed: 8,
      contextWindowTokens: 10
    })
    await writeSignals(
      grokHome,
      { contextTokensUsed: 99, contextWindowTokens: 100 },
      '/other',
      'other'
    )

    await expect(readGrokSessionContextUsage(input(grokHome, '/other', 'other'))).resolves.toEqual({
      scope: 'context',
      usedTokens: 99,
      limitTokens: 100
    })
    await expect(readGrokSessionContextUsage(input(grokHome))).resolves.toEqual({
      scope: 'context',
      usedTokens: 8,
      limitTokens: 10
    })
  })

  it('拒绝 signals.json 软链接到 Managed GROK_HOME 外部', async () => {
    const grokHome = await createHome()
    const outside = await mkdtemp(join(tmpdir(), 'grok-signals-outside-'))
    roots.push(outside)
    const outsideFile = join(outside, 'signals.json')
    await writeFile(outsideFile, JSON.stringify({ contextTokensUsed: 1, contextWindowTokens: 2 }))
    const signalsPath = buildGrokSessionSignalsPath(input(grokHome))
    await mkdir(join(grokHome, 'sessions', encodeURIComponent(WORKSPACE), SESSION_ID), {
      recursive: true
    })
    await symlink(outsideFile, signalsPath)

    await expect(readGrokSessionContextUsage(input(grokHome))).resolves.toBeNull()
  })

  it('文件过大时不解析原始内容', async () => {
    const grokHome = await createHome()
    await writeSignalsRaw(
      grokHome,
      '{"contextTokensUsed":1,"contextWindowTokens":2}' + 'x'.repeat(70 * 1024)
    )

    await expect(readGrokSessionContextUsage(input(grokHome))).resolves.toBeNull()
  })
})

async function createHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'grok-session-signals-'))
  roots.push(root)
  await mkdir(join(root, 'sessions'), { recursive: true })
  return root
}

async function writeSignals(
  grokHome: string,
  value: Record<string, unknown>,
  workspace = WORKSPACE,
  sessionId = SESSION_ID
): Promise<void> {
  await writeSignalsRaw(grokHome, JSON.stringify(value), workspace, sessionId)
}

async function writeSignalsRaw(
  grokHome: string,
  contents: string,
  workspace = WORKSPACE,
  sessionId = SESSION_ID
): Promise<void> {
  const path = buildGrokSessionSignalsPath({ grokHome, workspace, runtimeSessionId: sessionId })
  await mkdir(join(grokHome, 'sessions', encodeURIComponent(workspace), sessionId), {
    recursive: true
  })
  await writeFile(path, contents)
}

function input(
  grokHome: string,
  workspace = WORKSPACE,
  runtimeSessionId = SESSION_ID
): GrokSessionSignalsInput {
  return { grokHome, workspace, runtimeSessionId }
}
