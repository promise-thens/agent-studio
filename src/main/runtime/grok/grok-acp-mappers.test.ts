import type * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import {
  mapGrokAvailableCommands,
  mapGrokPermissionRequest,
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

describe('mapGrokPermissionRequest 读/写映射', () => {
  it('read/search 带可信 path 时映射为 read-project，不落入 unknown', () => {
    for (const kind of ['read', 'search'] as const) {
      const request = mapGrokPermissionRequest(
        {
          sessionId: SESSION_ID,
          options: [{ optionId: 'allow-once', name: '允许一次', kind: 'allow_once' }],
          toolCall: {
            toolCallId: `tool-${kind}`,
            title: `读取 ${kind}`,
            kind,
            locations: [{ path: '/tmp/fixture/src/notes.ts' }],
            rawInput: { command: 'cat /etc/passwd', apiKey: FAKE_KEY }
          }
        },
        `permission-${kind}`,
        'task-mapper',
        'turn-mapper',
        redactFakeText,
        true
      )

      expect(request).toMatchObject({
        operationType: 'read-project',
        targets: [{ kind: 'path', value: '/tmp/fixture/src/notes.ts' }],
        executionSupported: true
      })
      expect(request?.minimumRisk).toBeUndefined()
      expect(JSON.stringify(request)).not.toContain('rawInput')
      expect(JSON.stringify(request)).not.toContain(FAKE_KEY)
      expect(JSON.stringify(request)).not.toContain('allow_always')
    }
  })

  it('read 缺少 path 时仍是 unknown L3，rawInput 不能让它自动过', () => {
    const request = mapGrokPermissionRequest(
      {
        sessionId: SESSION_ID,
        options: [{ optionId: 'allow-once', name: '允许一次', kind: 'allow_once' }],
        toolCall: {
          toolCallId: 'tool-read-no-path',
          kind: 'read',
          rawInput: { kind: 'read', path: '/tmp/fixture/secret.ts' }
        }
      },
      'permission-read-no-path',
      'task-mapper',
      'turn-mapper',
      redactFakeText,
      true
    )

    expect(request).toMatchObject({
      operationType: 'unknown',
      minimumRisk: 'L3',
      targets: [{ kind: 'unknown', value: 'Runtime 未提供可验证的操作目标。' }]
    })
    expect(JSON.stringify(request)).not.toContain('secret.ts')
    expect(JSON.stringify(request)).not.toContain('rawInput')
  })

  it('read 没有 locations 时可用标题反引号路径映射为项目内读取', () => {
    const request = mapGrokPermissionRequest(
      {
        sessionId: SESSION_ID,
        options: [{ optionId: 'allow-once', name: '允许一次', kind: 'allow_once' }],
        toolCall: {
          toolCallId: 'tool-read-title-path',
          kind: 'read',
          title: 'Read `D:\\金坛\\czgs-report-ui\\src\\views\\pageDemo\\CavernVisualization.vue`'
        }
      },
      'permission-read-title-path',
      'task-mapper',
      'turn-mapper',
      redactFakeText,
      true
    )

    expect(request).toMatchObject({
      operationType: 'read-project',
      executionSupported: true,
      targets: [
        {
          kind: 'path',
          value: 'D:\\金坛\\czgs-report-ui\\src\\views\\pageDemo\\CavernVisualization.vue'
        }
      ]
    })
    expect(request?.minimumRisk).toBeUndefined()
  })

  it('只有 allow_always 时即使是项目内读取也不把 executionSupported 设为 true', () => {
    const request = mapGrokPermissionRequest(
      {
        sessionId: SESSION_ID,
        options: [{ optionId: 'allow-always', name: 'Always', kind: 'allow_always' }],
        toolCall: {
          toolCallId: 'tool-read-always',
          kind: 'read',
          locations: [{ path: '/tmp/fixture/src/a.ts' }]
        }
      },
      'permission-read-always',
      'task-mapper',
      'turn-mapper',
      redactFakeText,
      false
    )

    expect(request).toMatchObject({
      operationType: 'read-project',
      executionSupported: false,
      targets: [{ kind: 'path', value: '/tmp/fixture/src/a.ts' }]
    })
    expect(JSON.stringify(request)).not.toContain('allow_always')
    expect(JSON.stringify(request)).not.toContain('allow-always')
  })

  it('edit/delete 的 impact 说明本任务整类写/删，不把列出的 path 说成只改这几个文件', () => {
    const edit = mapGrokPermissionRequest(
      {
        sessionId: SESSION_ID,
        options: [{ optionId: 'allow-once', name: '允许一次', kind: 'allow_once' }],
        toolCall: {
          toolCallId: 'tool-edit-impact',
          title: '修改文件',
          kind: 'edit',
          locations: [{ path: '/tmp/fixture/src/a.ts' }, { path: '/tmp/fixture/src/b.ts' }]
        }
      },
      'permission-edit-impact',
      'task-mapper',
      'turn-mapper',
      redactFakeText,
      true
    )
    const deletion = mapGrokPermissionRequest(
      {
        sessionId: SESSION_ID,
        options: [{ optionId: 'allow-once', name: '允许一次', kind: 'allow_once' }],
        toolCall: {
          toolCallId: 'tool-delete-impact',
          title: '删除文件',
          kind: 'delete',
          locations: [{ path: '/tmp/fixture/src/a.ts' }]
        }
      },
      'permission-delete-impact',
      'task-mapper',
      'turn-mapper',
      redactFakeText,
      true
    )

    expect(edit).toMatchObject({
      operationType: 'write-file',
      impact: '本任务允许写入项目内文件。'
    })
    expect(edit?.impact).not.toContain('指定文件')
    expect(deletion).toMatchObject({
      operationType: 'delete-path',
      impact: '本任务允许删除项目内文件。'
    })
    expect(deletion?.impact).not.toContain('指定路径')
    expect(deletion?.impact).not.toContain('指定文件')
  })
})

describe('mapGrokSessionUpdate 子 Agent parentId', () => {
  it('Ask 工具缺 status 时按 pending 投影，避免主列显示状态未知', () => {
    const events = mapGrokSessionUpdate(
      {
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-ask-1',
          title: 'Ask: 你现在最想先解决哪一件事?'
        } as unknown as acp.SessionUpdate
      },
      redactFakeText
    )

    expect(events[0]).toMatchObject({
      kind: 'tool-call',
      toolCallId: 'call-ask-1',
      title: 'Ask: 你现在最想先解决哪一件事?',
      status: 'pending'
    })
  })

  it('标题含 subagent / 子 Agent 时不发明 parentId', () => {
    for (const title of ['subagent 探查测试结构', '子 Agent 改登录逻辑']) {
      const events = mapGrokSessionUpdate(
        {
          sessionId: SESSION_ID,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-subagent-title',
            title,
            status: 'in_progress'
          }
        },
        redactFakeText
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        kind: 'tool-call',
        toolCallId: 'tool-subagent-title',
        title
      })
      expect(events[0]).not.toHaveProperty('parentId')
      expect(JSON.stringify(events)).not.toContain('"parentId"')
    }
  })

  it('ACP 未知键 parentToolCallId / _meta / agentId 不得映射为 parentId', () => {
    const events = mapGrokSessionUpdate(
      {
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'child-1',
          title: '读取文件',
          status: 'pending',
          parentToolCallId: 'parent-1',
          parentId: 'parent-1',
          agentId: 'agent-child',
          rawInput: { apiKey: FAKE_KEY },
          _meta: { parentToolCallId: 'parent-1', secret: FAKE_KEY }
        } as unknown as acp.SessionUpdate
      },
      redactFakeText
    )

    expect(events[0]).toMatchObject({
      kind: 'tool-call',
      toolCallId: 'child-1',
      title: '读取文件'
    })
    expect(events[0]).not.toHaveProperty('parentId')
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('"parentId"')
    expect(serialized).not.toContain('parentToolCallId')
    expect(serialized).not.toContain('agentId')
    expect(serialized).not.toContain('_meta')
    expect(serialized).not.toContain('rawInput')
    expect(serialized).not.toContain(FAKE_KEY)
  })

  it('tool_call_update 同样不从未知键或标题发明 parentId', () => {
    const events = mapGrokSessionUpdate(
      {
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'child-1',
          title: 'subagent 探查测试结构',
          status: 'completed',
          parentToolCallId: 'parent-1',
          _meta: { agentId: 'agent-child' }
        } as unknown as acp.SessionUpdate
      },
      redactFakeText
    )

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'tool-update',
        toolCallId: 'child-1',
        title: 'subagent 探查测试结构',
        status: 'completed'
      })
    ])
    expect(events[0]).not.toHaveProperty('parentId')
    expect(JSON.stringify(events)).not.toContain('"parentId"')
    expect(JSON.stringify(events)).not.toContain('parentToolCallId')
  })

  it('plan 整表快照投影为 plan 事件并脱敏条目正文', () => {
    const events = mapGrokSessionUpdate(
      {
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: 'plan',
          entries: [
            {
              content: `定位接缝 ${FAKE_KEY}`,
              priority: 'high',
              status: 'completed'
            },
            {
              content: '融合两罐交界',
              priority: 'medium',
              status: 'in_progress'
            }
          ]
        }
      },
      redactFakeText
    )

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'plan',
        entries: [
          { content: '定位接缝 [REDACTED]', priority: 'high', status: 'completed' },
          { content: '融合两罐交界', priority: 'medium', status: 'in_progress' }
        ]
      })
    ])
  })

  it('plan_update items 同样投影为整表 plan；file/markdown 忽略', () => {
    const items = mapGrokSessionUpdate(
      {
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: 'plan_update',
          plan: {
            type: 'items',
            planId: 'plan-1',
            entries: [
              {
                content: `融合接缝 ${FAKE_KEY}`,
                priority: 'medium',
                status: 'completed'
              }
            ]
          }
        }
      } as acp.SessionNotification,
      redactFakeText
    )
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'plan',
        entries: [{ content: '融合接缝 [REDACTED]', priority: 'medium', status: 'completed' }]
      })
    ])

    expect(
      mapGrokSessionUpdate(
        {
          sessionId: SESSION_ID,
          update: {
            sessionUpdate: 'plan_update',
            plan: { type: 'file', planId: 'plan-1', uri: 'file:///tmp/plan.md' }
          }
        } as acp.SessionNotification,
        redactFakeText
      )
    ).toEqual([])
    expect(
      mapGrokSessionUpdate(
        {
          sessionId: SESSION_ID,
          update: {
            sessionUpdate: 'plan_update',
            plan: { type: 'markdown', planId: 'plan-1', content: '# 计划' }
          }
        } as acp.SessionNotification,
        redactFakeText
      )
    ).toEqual([])
  })
})
