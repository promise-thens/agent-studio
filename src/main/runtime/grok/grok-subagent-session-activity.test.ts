import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  encodeGrokSessionWorkspaceDir,
  isGrokSubagentShortId,
  parseGrokSubagentSessionActivityUpdates,
  parseGrokSubagentSessionUpdates,
  readGrokSubagentSessionActivity
} from './grok-subagent-session-activity'

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
}

describe('Grok 子 session 工具落盘', () => {
  it('只抽出 tool_call 行，按首次出现排序，丢掉思想块和 rawInput', () => {
    const rows = parseGrokSubagentSessionUpdates(
      jsonl([
        {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: 'secret' }
            }
          }
        },
        {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 't-read',
              title: 'Read `index.html`',
              rawInput: { target_file: '/secret/index.html' }
            }
          }
        },
        {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 't-read',
              status: 'completed'
            }
          }
        },
        {
          method: '_x.ai/session/update',
          params: { update: { sessionUpdate: 'subagent_finished', tool_calls: 25 } }
        }
      ])
    )

    expect(rows).toEqual([
      { toolCallId: 't-read', title: 'Read `index.html`', status: 'completed' }
    ])
    expect(JSON.stringify(rows)).not.toContain('secret')
    expect(JSON.stringify(rows)).not.toContain('rawInput')
  })

  it('标题走脱敏回调，非法 shortId 直接 missing', async () => {
    expect(isGrokSubagentShortId('01a05bc9')).toBe(true)
    expect(isGrokSubagentShortId('../etc')).toBe(false)
    const rows = parseGrokSubagentSessionUpdates(
      jsonl([
        {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 't-1',
              title: 'Read `sk-fake-key`',
              status: 'in_progress'
            }
          }
        }
      ]),
      (text) => text.replace('sk-fake-key', '[REDACTED]')
    )
    expect(rows[0]?.title).toBe('Read `[REDACTED]`')

    const missing = await readGrokSubagentSessionActivity({
      grokHome: '/tmp/not-a-grok-home',
      workspacePath: '/tmp/project',
      parentRuntimeSessionId: '01a05b79-3518-7201-833a-a53f04640656',
      shortId: '../etc'
    })
    expect(missing).toEqual({ source: 'missing', tools: [] })
  })

  it('按 spawn 短 id 读子 session updates.jsonl，不跟符号链接逃出 GROK_HOME', async () => {
    const grokHome = await mkdtemp(join(tmpdir(), 'grok-subagent-'))
    temps.push(grokHome)
    const workspace = '/Users/demo/agentStudioTest'
    const parentId = '01a05b79-3518-7201-833a-a53f04640656'
    const childId = '01a05bc9-6c90-77a1-9fc7-3ec40063133d'
    const sessionsDir = join(grokHome, 'sessions', encodeGrokSessionWorkspaceDir(workspace))
    await mkdir(join(sessionsDir, parentId, 'subagents', childId), { recursive: true })
    await mkdir(join(sessionsDir, childId), { recursive: true })
    await writeFile(
      join(sessionsDir, parentId, 'subagents', childId, 'meta.json'),
      JSON.stringify({
        subagent_id: childId,
        child_session_id: childId,
        description: 'Analyze HTML files',
        status: 'completed'
      })
    )
    await writeFile(
      join(sessionsDir, childId, 'updates.jsonl'),
      jsonl([
        {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 't-list',
              title: 'List `/Users/demo/agentStudioTest`',
              status: 'completed'
            }
          }
        }
      ])
    )

    const activity = await readGrokSubagentSessionActivity({
      grokHome,
      workspacePath: workspace,
      parentRuntimeSessionId: parentId,
      shortId: '01a05bc9'
    })
    expect(activity.source).toBe('grok-session')
    expect(activity.tools).toEqual([
      {
        toolCallId: 't-list',
        title: 'List `/Users/demo/agentStudioTest`',
        status: 'completed'
      }
    ])
  })

  it('过程播报后继续用工具时只保留最后连续回复，并在拼接后统一脱敏', () => {
    const activity = parseGrokSubagentSessionActivityUpdates(
      jsonl([
        {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '我先读取 secret-' }
            }
          }
        },
        {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 't-read',
              title: 'Read `index.html`',
              status: 'completed'
            }
          }
        },
        {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '最终发现：key=' }
            }
          }
        },
        {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'sk-final-key' }
            }
          }
        },
        {
          method: 'session/update',
          params: { update: { sessionUpdate: 'turn_completed' } }
        }
      ]),
      (text) => text.replace('sk-final-key', '[REDACTED]')
    )

    expect(activity.tools).toHaveLength(1)
    expect(activity.result).toEqual({ text: '最终发现：key=[REDACTED]', truncated: false })
    expect(JSON.stringify(activity)).not.toContain('我先读取')
  })

  it('只在指定父 Runtime session 下找孩子，运行中不返回半截结果', async () => {
    const grokHome = await mkdtemp(join(tmpdir(), 'grok-subagent-parent-'))
    temps.push(grokHome)
    const workspace = '/Users/demo/agentStudioTest'
    const expectedParent = '01a05b79-3518-7201-833a-a53f04640656'
    const otherParent = '01a05b79-3518-7201-833a-a53f04640657'
    const childId = '01a05bc9-6c90-77a1-9fc7-3ec40063133d'
    const sessionsDir = join(grokHome, 'sessions', encodeGrokSessionWorkspaceDir(workspace))
    await mkdir(join(sessionsDir, otherParent, 'subagents', childId), { recursive: true })
    await mkdir(join(sessionsDir, childId), { recursive: true })
    await writeFile(
      join(sessionsDir, otherParent, 'subagents', childId, 'meta.json'),
      JSON.stringify({ child_session_id: childId, status: 'completed' })
    )
    await writeFile(
      join(sessionsDir, childId, 'updates.jsonl'),
      jsonl([
        {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '不属于当前 Task' }
            }
          }
        }
      ])
    )

    expect(
      await readGrokSubagentSessionActivity({
        grokHome,
        workspacePath: workspace,
        parentRuntimeSessionId: expectedParent,
        shortId: '01a05bc9'
      })
    ).toEqual({ source: 'missing', tools: [] })

    await mkdir(join(sessionsDir, expectedParent, 'subagents', childId), { recursive: true })
    await writeFile(
      join(sessionsDir, expectedParent, 'subagents', childId, 'meta.json'),
      JSON.stringify({ child_session_id: childId, status: 'running' })
    )
    const running = await readGrokSubagentSessionActivity({
      grokHome,
      workspacePath: workspace,
      parentRuntimeSessionId: expectedParent,
      shortId: '01a05bc9'
    })
    expect(running.source).toBe('grok-session')
    expect(running.result).toBeUndefined()
  })
})
