import { describe, expect, it } from 'vitest'
import {
  AVAILABLE_COMMAND_NAME_PATTERN,
  MAX_AVAILABLE_COMMANDS,
  parseAvailableCommandSnapshot
} from './agent-available-command'

/** 构造刚好超过 4 KiB 的 ASCII 串，用于字段字节上限断言。 */
function oversizeAscii(prefix = 'x'): string {
  return prefix.repeat(4 * 1024 + 1)
}

describe('可用命令快照契约', () => {
  it('解析正常命令列表，保留可选 inputHint', () => {
    expect(
      parseAvailableCommandSnapshot({
        taskId: 'task-1',
        revision: 3,
        commands: [
          { name: 'help', description: 'Show help' },
          { name: 'run:test', description: 'Run tests', inputHint: '[filter]' }
        ]
      })
    ).toEqual({
      taskId: 'task-1',
      revision: 3,
      commands: [
        { name: 'help', description: 'Show help' },
        { name: 'run:test', description: 'Run tests', inputHint: '[filter]' }
      ]
    })
  })

  it('命令对象上的 _meta 与未知字段被丢弃，不整项失败', () => {
    expect(
      parseAvailableCommandSnapshot({
        taskId: 'task-1',
        revision: 1,
        commands: [
          {
            name: 'status',
            description: 'Show status',
            inputHint: 'verbose',
            _meta: { vendor: 'grok' },
            extra: true
          }
        ],
        noise: 'drop-me'
      })
    ).toEqual({
      taskId: 'task-1',
      revision: 1,
      commands: [{ name: 'status', description: 'Show status', inputHint: 'verbose' }]
    })
  })

  it('非法 name 被跳过，其余合法项保留', () => {
    expect(AVAILABLE_COMMAND_NAME_PATTERN.test('ok')).toBe(true)
    expect(AVAILABLE_COMMAND_NAME_PATTERN.test('-bad')).toBe(false)
    expect(AVAILABLE_COMMAND_NAME_PATTERN.test('bad name')).toBe(false)

    expect(
      parseAvailableCommandSnapshot({
        taskId: 'task-1',
        revision: 0,
        commands: [
          { name: '-bad', description: 'illegal leading dash' },
          { name: 'ok', description: 'kept' },
          { name: 'bad name', description: 'space not allowed' }
        ]
      })
    ).toEqual({
      taskId: 'task-1',
      revision: 0,
      commands: [{ name: 'ok', description: 'kept' }]
    })
  })

  it('缺 description 或 description 非字符串时跳过该项', () => {
    expect(
      parseAvailableCommandSnapshot({
        taskId: 'task-1',
        revision: 1,
        commands: [
          { name: 'no-desc' },
          { name: 'bad-desc', description: 12 },
          { name: 'kept', description: 'yes' }
        ]
      })
    ).toEqual({
      taskId: 'task-1',
      revision: 1,
      commands: [{ name: 'kept', description: 'yes' }]
    })
  })

  it('单字段 UTF-8 超过 4 KiB 时跳过该项', () => {
    const huge = oversizeAscii()
    expect(
      parseAvailableCommandSnapshot({
        taskId: 'task-1',
        revision: 1,
        commands: [
          { name: 'ok', description: huge },
          { name: 'ok2', description: 'fine', inputHint: huge },
          { name: 'kept', description: 'short' }
        ]
      })
    ).toEqual({
      taskId: 'task-1',
      revision: 1,
      commands: [{ name: 'kept', description: 'short' }]
    })
  })

  it('inputHint 存在但不是非空字符串时跳过该项', () => {
    expect(
      parseAvailableCommandSnapshot({
        taskId: 'task-1',
        revision: 1,
        commands: [
          { name: 'a', description: 'd', inputHint: '' },
          { name: 'b', description: 'd', inputHint: 1 },
          { name: 'c', description: 'd', inputHint: null },
          { name: 'kept', description: 'd', inputHint: 'hint' },
          { name: 'no-hint', description: 'd' }
        ]
      })
    ).toEqual({
      taskId: 'task-1',
      revision: 1,
      commands: [
        { name: 'kept', description: 'd', inputHint: 'hint' },
        { name: 'no-hint', description: 'd' }
      ]
    })
  })

  it('先过滤非法项再截断到 MAX_AVAILABLE_COMMANDS 条有效命令', () => {
    expect(MAX_AVAILABLE_COMMANDS).toBe(200)
    const commands = [
      { name: '-illegal', description: 'skip first junk' },
      ...Array.from({ length: MAX_AVAILABLE_COMMANDS }, (_, index) => ({
        name: `cmd${index}`,
        description: `d${index}`
      })),
      { name: 'overflow', description: 'should be capped away' }
    ]

    const parsed = parseAvailableCommandSnapshot({
      taskId: 'task-1',
      revision: 2,
      commands
    })

    expect(parsed).not.toBeNull()
    expect(parsed!.commands).toHaveLength(MAX_AVAILABLE_COMMANDS)
    expect(parsed!.commands[0]).toEqual({ name: 'cmd0', description: 'd0' })
    expect(parsed!.commands[MAX_AVAILABLE_COMMANDS - 1]).toEqual({
      name: `cmd${MAX_AVAILABLE_COMMANDS - 1}`,
      description: `d${MAX_AVAILABLE_COMMANDS - 1}`
    })
    expect(parsed!.commands.some((item) => item.name === 'overflow')).toBe(false)
  })

  it('全部命令非法时仍返回空 commands 合法快照', () => {
    expect(
      parseAvailableCommandSnapshot({
        taskId: 'task-1',
        revision: 9,
        commands: [
          { name: '-x', description: 'bad name' },
          { name: 'ok' },
          { name: 'y', description: oversizeAscii() }
        ]
      })
    ).toEqual({
      taskId: 'task-1',
      revision: 9,
      commands: []
    })
  })

  it('commands 缺失或非数组时视为已同步的空快照', () => {
    expect(parseAvailableCommandSnapshot({ taskId: 'task-1', revision: 1 })).toEqual({
      taskId: 'task-1',
      revision: 1,
      commands: []
    })
    expect(
      parseAvailableCommandSnapshot({ taskId: 'task-1', revision: 1, commands: null })
    ).toEqual({
      taskId: 'task-1',
      revision: 1,
      commands: []
    })
    expect(
      parseAvailableCommandSnapshot({ taskId: 'task-1', revision: 1, commands: 'nope' })
    ).toEqual({
      taskId: 'task-1',
      revision: 1,
      commands: []
    })
  })

  it('非对象、缺/空/超长 taskId、非法 revision 返回 null', () => {
    expect(parseAvailableCommandSnapshot(null)).toBeNull()
    expect(parseAvailableCommandSnapshot('x')).toBeNull()
    expect(parseAvailableCommandSnapshot([])).toBeNull()
    expect(parseAvailableCommandSnapshot({ revision: 1, commands: [] })).toBeNull()
    expect(parseAvailableCommandSnapshot({ taskId: 1, revision: 1, commands: [] })).toBeNull()
    expect(parseAvailableCommandSnapshot({ taskId: '', revision: 1, commands: [] })).toBeNull()
    expect(
      parseAvailableCommandSnapshot({
        taskId: oversizeAscii('t'),
        revision: 1,
        commands: []
      })
    ).toBeNull()
    expect(parseAvailableCommandSnapshot({ taskId: 'task-1', commands: [] })).toBeNull()
    expect(
      parseAvailableCommandSnapshot({ taskId: 'task-1', revision: Number.NaN, commands: [] })
    ).toBeNull()
    expect(
      parseAvailableCommandSnapshot({
        taskId: 'task-1',
        revision: Number.POSITIVE_INFINITY,
        commands: []
      })
    ).toBeNull()
    expect(
      parseAvailableCommandSnapshot({ taskId: 'task-1', revision: '1', commands: [] })
    ).toBeNull()
  })

  it('有限浮点 revision 可接受', () => {
    expect(
      parseAvailableCommandSnapshot({ taskId: 'task-1', revision: 1.5, commands: [] })
    ).toEqual({
      taskId: 'task-1',
      revision: 1.5,
      commands: []
    })
  })
})
