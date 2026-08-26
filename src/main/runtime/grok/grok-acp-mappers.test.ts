import type * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import {
  mapGrokAvailableCommands,
  mapGrokRuntimeImageContent,
  mapGrokSessionUpdate
} from './grok-acp-mappers'

const FAKE_KEY = 'sk-fake-available-commands-mapper'
const SESSION_ID = 'runtime-session-available-commands'
const FAKE_PNG_BASE64 = 'iVBORw0KGgoBAgME'

function redactFakeText(text: string): string {
  return text.replaceAll(FAKE_KEY, '[REDACTED]')
}

describe('mapGrokAvailableCommands', () => {
  it('只投影 name/description/inputHint，丢弃 _meta 与未知字段', () => {
    const update = {
      availableCommands: [
        {
          name: 'compact',
          description: '压缩上下文',
          input: { hint: '可选说明', _meta: { vendor: 'x' } },
          _meta: { secret: FAKE_KEY },
          unknownField: 'drop-me'
        },
        {
          name: 'dream',
          description: '整理记忆'
        }
      ],
      _meta: { leak: FAKE_KEY }
    } as acp.AvailableCommandsUpdate

    const commands = mapGrokAvailableCommands(update, redactFakeText)

    expect(commands).toEqual([
      { name: 'compact', description: '压缩上下文', inputHint: '可选说明' },
      { name: 'dream', description: '整理记忆' }
    ])
    expect(JSON.stringify(commands)).not.toContain('_meta')
    expect(JSON.stringify(commands)).not.toContain('unknownField')
    expect(JSON.stringify(commands)).not.toContain(FAKE_KEY)
  })

  it('对 description 与 inputHint 调用 redactText，name 保持原样', () => {
    const update = {
      availableCommands: [
        {
          name: `cmd-${FAKE_KEY}`,
          description: `描述含 ${FAKE_KEY}`,
          input: { hint: `提示含 ${FAKE_KEY}` }
        }
      ]
    } as acp.AvailableCommandsUpdate

    expect(mapGrokAvailableCommands(update, redactFakeText)).toEqual([
      {
        name: `cmd-${FAKE_KEY}`,
        description: '描述含 [REDACTED]',
        inputHint: '提示含 [REDACTED]'
      }
    ])
  })

  it('input 缺失/null 或 hint 缺失/空时省略 inputHint', () => {
    const update = {
      availableCommands: [
        { name: 'a', description: 'no-input' },
        { name: 'b', description: 'null-input', input: null },
        { name: 'c', description: 'empty-hint', input: { hint: '' } },
        { name: 'd', description: 'missing-hint', input: {} as { hint: string } }
      ]
    } as acp.AvailableCommandsUpdate

    expect(mapGrokAvailableCommands(update, redactFakeText)).toEqual([
      { name: 'a', description: 'no-input' },
      { name: 'b', description: 'null-input' },
      { name: 'c', description: 'empty-hint' },
      { name: 'd', description: 'missing-hint' }
    ])
  })

  it('跳过 name 或 description 缺失/非字符串的项，不拖垮整份列表', () => {
    const update = {
      availableCommands: [
        { name: 1, description: 'bad-name' },
        { name: 'ok', description: null },
        { description: 'missing-name' },
        { name: 'valid', description: '保留' },
        null,
        'noise'
      ]
    } as unknown as acp.AvailableCommandsUpdate

    expect(mapGrokAvailableCommands(update, redactFakeText)).toEqual([
      { name: 'valid', description: '保留' }
    ])
  })

  it('不在此层截断到 200；投影结果可超过 preload 上限', () => {
    const update = {
      availableCommands: Array.from({ length: 201 }, (_, index) => ({
        name: `cmd${index}`,
        description: `d${index}`
      }))
    } as acp.AvailableCommandsUpdate

    expect(mapGrokAvailableCommands(update, redactFakeText)).toHaveLength(201)
  })

  it('available_commands_update 仍不经 mapGrokSessionUpdate 进入 Timeline', () => {
    const sessionUpdate = {
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          {
            name: 'compact',
            description: `含密钥 ${FAKE_KEY}`,
            input: { hint: 'hint' },
            _meta: { x: 1 }
          }
        ]
      }
    } as acp.SessionNotification

    expect(mapGrokSessionUpdate(sessionUpdate, redactFakeText)).toEqual([])
  })
})

describe('mapGrokRuntimeImageContent', () => {
  it('只提取白名单图片字节并忽略 ACP URI 与扩展元数据', () => {
    const mapped = mapGrokRuntimeImageContent({
      type: 'image',
      data: FAKE_PNG_BASE64,
      mimeType: 'image/png',
      uri: 'file:///private/secret.png',
      annotations: { audience: ['assistant'] },
      _meta: { privatePath: '/private/secret.png' }
    })

    expect(mapped).toMatchObject({
      mimeType: 'image/png',
      originalName: 'runtime-image.png'
    })
    expect(mapped?.bytes.equals(Buffer.from(FAKE_PNG_BASE64, 'base64'))).toBe(true)
    expect(JSON.stringify(mapped)).not.toContain('private')
  })

  it('拒绝脏 base64、未知 MIME 和非图片块', () => {
    expect(
      mapGrokRuntimeImageContent({ type: 'image', data: 'not base64', mimeType: 'image/png' })
    ).toBeNull()
    expect(
      mapGrokRuntimeImageContent({ type: 'image', data: FAKE_PNG_BASE64, mimeType: 'image/svg+xml' })
    ).toBeNull()
    expect(mapGrokRuntimeImageContent({ type: 'text', text: FAKE_PNG_BASE64 })).toBeNull()
  })
})
