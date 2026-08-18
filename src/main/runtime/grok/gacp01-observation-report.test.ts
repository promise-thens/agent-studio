import { describe, expect, it } from 'vitest'
import { renderGacp01ObservationMarkdown } from './gacp01-observation-report'

const FAKE_KEY = 'sk-fake-gacp01-report'

describe('renderGacp01ObservationMarkdown', () => {
  it('用观察记录填表，不把密钥或 sessionId 写进文档', () => {
    const markdown = renderGacp01ObservationMarkdown({
      product: {
        commit: '9d5894d',
        grokCliVersion: 'grok 1.0.0 (3cd0d0cbce)',
        nodeVersion: 'v24.11.0',
        pnpmVersion: '10.33.0',
        electronVersion: '39.8.10',
        sdkVersion: '1.3.0',
        protocolVersionConstant: '1',
        connectState: 'ready',
        connectMessage: 'Grok Build 已连接',
        sessionCreate: 'verified',
        sessionResume: 'declared',
        sessionLoad: 'unsupported',
        taskATurn2State: 'completed',
        resumeMethod: 'resume',
        publicEventKinds: ['agent-message', 'turn-complete'],
        permissionDecisions: ['allow-once']
      },
      records: [
        {
          kind: 'initialize',
          protocolVersion: 1,
          protocolVersionMatches: true,
          hasAgentInfoName: true,
          hasAgentInfoVersion: true,
          loadSession: false,
          resumeDeclared: true,
          closeDeclared: false,
          promptImage: 'absent',
          promptAudio: 'absent',
          promptEmbeddedContext: 'absent',
          hasAuth: false,
          hasProviders: false,
          hasMeta: false
        },
        {
          kind: 'session-update',
          sessionUpdate: 'agent_message_chunk',
          contentType: 'text'
        },
        {
          kind: 'permission',
          optionKinds: ['allow_once', 'reject_once'],
          uniqueAllowOnce: true,
          uniqueRejectOnce: true,
          toolCallKind: 'execute',
          hasLocationPath: false,
          hasDiffContent: false,
          hasRawInput: true,
          hasRawOutput: false,
          hasName: true,
          hasMeta: false
        }
      ]
    })

    expect(markdown).toContain('`1`')
    expect(markdown).toContain('`agent_message_chunk`')
    expect(markdown).toContain('allow_once/reject_once')
    expect(markdown).toContain('`resume`')
    expect(markdown).not.toContain(FAKE_KEY)
    expect(markdown).not.toContain('runtime-session')
  })
})
