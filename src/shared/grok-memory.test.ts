import { describe, expect, it } from 'vitest'
import {
  isCurrentProjectMemoryDir,
  isGrokMemoryId,
  parseGrokMemoryId,
  parseGrokMemorySummary
} from './grok-memory'

describe('grok memory 标识', () => {
  it('接受三种已知布局并拒绝逃逸', () => {
    expect(isGrokMemoryId('global/MEMORY.md')).toBe(true)
    expect(isGrokMemoryId('project/demo-deadbeef/MEMORY.md')).toBe(true)
    expect(isGrokMemoryId('session/demo-deadbeef/note.md')).toBe(true)
    expect(isGrokMemoryId('../MEMORY.md')).toBe(false)
    expect(isGrokMemoryId('global/../MEMORY.md')).toBe(false)
    expect(isGrokMemoryId('C:/Users/x/MEMORY.md')).toBe(false)
    expect(parseGrokMemoryId('project/demo-deadbeef/MEMORY.md')).toEqual({
      memoryId: 'project/demo-deadbeef/MEMORY.md',
      scope: 'project',
      relativePosixPath: 'demo-deadbeef/MEMORY.md',
      projectKey: 'demo-deadbeef'
    })
  })

  it('摘要 DTO 不含绝对路径', () => {
    expect(
      parseGrokMemorySummary({
        memoryId: 'global/MEMORY.md',
        scope: 'global',
        title: '全局',
        updatedAt: '2026-08-20T00:00:00.000Z',
        absolutePath: 'C:/Users/x/.grok/memory/MEMORY.md'
      })
    ).toEqual({
      memoryId: 'global/MEMORY.md',
      scope: 'global',
      title: '全局',
      updatedAt: '2026-08-20T00:00:00.000Z'
    })
  })

  it('best-effort 匹配当前项目 slug，对不上不强造目录', () => {
    expect(isCurrentProjectMemoryDir('agent-studio-deadbeef', 'agent-studio')).toBe(true)
    expect(isCurrentProjectMemoryDir('other-aaaaaaaa', 'agent-studio')).toBe(false)
  })
})
