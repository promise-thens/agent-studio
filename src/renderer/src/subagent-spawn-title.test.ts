import { describe, expect, it } from 'vitest'
import { isSubagentSpawnTitle, parseSubagentSpawnTitle } from './subagent-spawn-title'

describe('parseSubagentSpawnTitle', () => {
  it('解析 Grok Build 药丸行：[subagent:type] 名称 (短 id)', () => {
    expect(
      parseSubagentSpawnTitle('[subagent:general-purpose] Demo subagent run (01a05b79)')
    ).toEqual({
      agentType: 'general-purpose',
      name: 'Demo subagent run',
      shortId: '01a05b79',
      heading: '[subagent:general-purpose] Demo subagent run (01a05b79)'
    })
  })

  it('没有短 id 时仍解析类型和名称', () => {
    expect(parseSubagentSpawnTitle('[subagent:explore] 探查测试结构')).toEqual({
      agentType: 'explore',
      name: '探查测试结构',
      heading: '[subagent:explore] 探查测试结构'
    })
  })

  it('普通 subagent / 子 Agent 标题不是 spawn 行', () => {
    expect(parseSubagentSpawnTitle('subagent 探查测试结构')).toBeNull()
    expect(parseSubagentSpawnTitle('子 Agent 改登录逻辑')).toBeNull()
    expect(parseSubagentSpawnTitle('读取 package.json')).toBeNull()
    expect(isSubagentSpawnTitle('[subagent:general-purpose] Demo (ab12)')).toBe(true)
    expect(isSubagentSpawnTitle('subagent 探查测试结构')).toBe(false)
  })
})
