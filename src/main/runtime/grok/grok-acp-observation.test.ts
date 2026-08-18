import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import {
  createGrokCapabilitySnapshot,
  mapGrokInitializeCapabilitySnapshot,
  mapGrokPermissionRequest,
  mapGrokSessionUpdate
} from './grok-acp-mappers'

/**
 * GACP-01 方言回归：只冻结现有 Adapter 对已声明枚举的处理。
 * 夹具来自观察计划里的字段名，不连真实网络，也不把受控 fixture 写成真实 Grok。
 */
const FAKE_KEY = 'sk-fake-gacp01-observation'
const SESSION_ID = 'runtime-session-observation'

function redactFakeText(text: string): string {
  return text.replaceAll(FAKE_KEY, '[REDACTED]')
}

function discardedUpdate(
  sessionUpdate:
    | 'user_message_chunk'
    | 'plan_update'
    | 'plan_removed'
    | 'available_commands_update'
    | 'current_mode_update'
    | 'config_option_update'
    | 'session_info_update'
): acp.SessionNotification {
  return {
    sessionId: SESSION_ID,
    update: { sessionUpdate, content: { type: 'text', text: 'ignored' } } as acp.SessionUpdate
  }
}

describe('GACP-01 Grok ACP 方言夹具', () => {
  it('握手未声明 resume/load 时能力为 unsupported/declared，不得写成 verified', () => {
    const snapshot = mapGrokInitializeCapabilitySnapshot(
      createGrokCapabilitySnapshot(redactFakeText),
      { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} },
      redactFakeText,
      acp.PROTOCOL_VERSION
    )

    expect(snapshot.protocolVersion).toBe(String(acp.PROTOCOL_VERSION))
    expect(snapshot.capabilities['session.resume']).toMatchObject({
      support: 'unsupported',
      verification: 'declared',
      source: 'protocol'
    })
    expect(snapshot.capabilities['session.load']).toMatchObject({
      support: 'unsupported',
      verification: 'declared',
      source: 'protocol'
    })
    expect(snapshot.capabilities['session.resume'].verification).not.toBe('verified')
    expect(snapshot.capabilities['session.load'].source).not.toBe('runtime')
  })

  it('只有 allow_always 时 executionSupported 为 false，且不回传 optionId 或 rawInput', () => {
    const request = mapGrokPermissionRequest(
      {
        sessionId: SESSION_ID,
        options: [{ optionId: 'allow-always', name: 'Always', kind: 'allow_always' }],
        toolCall: {
          toolCallId: 'tool-always-only',
          title: `edit ${FAKE_KEY}`,
          kind: 'edit',
          rawInput: { apiKey: FAKE_KEY },
          locations: [{ path: '/tmp/fixture/notes.txt' }]
        }
      },
      'permission-always-only',
      'task-observation',
      'turn-observation',
      redactFakeText,
      false
    )

    expect(request).toMatchObject({
      executionSupported: false,
      operationType: 'write-file',
      taskId: 'task-observation',
      turnId: 'turn-observation'
    })
    const serialized = JSON.stringify(request)
    expect(serialized).not.toContain('allow-always')
    expect(serialized).not.toContain('rawInput')
    expect(serialized).not.toContain(FAKE_KEY)
  })

  it('未知 sessionUpdate 变成可恢复 unsupported-runtime-event，不带 payload', () => {
    const events = mapGrokSessionUpdate(
      {
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: 'not_a_supported_update',
          secret: FAKE_KEY
        } as unknown as acp.SessionUpdate
      },
      redactFakeText
    )

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'error',
        recoverable: true,
        code: 'unsupported-runtime-event'
      })
    ])
    expect(JSON.stringify(events)).not.toContain('not_a_supported_update')
    expect(JSON.stringify(events)).not.toContain(FAKE_KEY)
  })

  it('计划已声明丢弃的 sessionUpdate 不进入产品事件', () => {
    const kinds = [
      'user_message_chunk',
      'plan_update',
      'plan_removed',
      'available_commands_update',
      'current_mode_update',
      'config_option_update',
      'session_info_update'
    ] as const

    for (const sessionUpdate of kinds) {
      expect(mapGrokSessionUpdate(discardedUpdate(sessionUpdate), redactFakeText)).toEqual([])
    }
  })
})
