import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  parseMarketplacePluginSummary,
  type MarketplacePluginSummary
} from './runtime-marketplace-plugin'

const validSummary: MarketplacePluginSummary = {
  name: 'chrome-devtools',
  displayName: 'Chrome DevTools MCP',
  description: 'Connect Grok to Chrome DevTools.',
  sourceName: 'plugin-marketplace',
  installed: false,
  skillCount: 0,
  mcpCount: 1,
  hookCount: 0
}

describe('市场插件条目契约', () => {
  it('MarketplacePluginSummary 只暴露货架可展示字段', () => {
    expectTypeOf<MarketplacePluginSummary>().toHaveProperty('name')
    expectTypeOf<MarketplacePluginSummary>().toHaveProperty('displayName')
    expectTypeOf<MarketplacePluginSummary>().toHaveProperty('description')
    expectTypeOf<MarketplacePluginSummary>().toHaveProperty('sourceName')
    expectTypeOf<MarketplacePluginSummary>().toHaveProperty('installed')
    expectTypeOf<MarketplacePluginSummary>().not.toHaveProperty('path')
    expectTypeOf<MarketplacePluginSummary>().not.toHaveProperty('sha')
    expectTypeOf<MarketplacePluginSummary>().not.toHaveProperty('url')
  })

  it('解析丢弃 path、sha、url 等敏感或越权字段', () => {
    expect(
      parseMarketplacePluginSummary({
        ...validSummary,
        path: '/Users/me/.grok/marketplace-cache/plugin-marketplace',
        sha: 'deadbeefcafebabe',
        url: 'https://github.com/xai-org/plugin-marketplace.git',
        extra: true
      })
    ).toEqual(validSummary)
  })

  it('非法 name 跳过：路径、NUL、超长与不符合货架 id 字符集', () => {
    expect(parseMarketplacePluginSummary({ ...validSummary, name: 'a/b' })).toBeNull()
    expect(parseMarketplacePluginSummary({ ...validSummary, name: 'a\\b' })).toBeNull()
    expect(parseMarketplacePluginSummary({ ...validSummary, name: '..' })).toBeNull()
    expect(parseMarketplacePluginSummary({ ...validSummary, name: 'evil\0name' })).toBeNull()
    expect(parseMarketplacePluginSummary({ ...validSummary, name: '' })).toBeNull()
    expect(parseMarketplacePluginSummary({ ...validSummary, name: '-leading-dash' })).toBeNull()
    expect(parseMarketplacePluginSummary({ ...validSummary, name: 'bad name' })).toBeNull()
    expect(parseMarketplacePluginSummary({ ...validSummary, name: 'x'.repeat(65) })).toBeNull()
  })

  it('sourceName 必须是源 id，拒绝 git URL 与路径形态', () => {
    expect(
      parseMarketplacePluginSummary({
        ...validSummary,
        sourceName: 'https://github.com/xai-org/plugin-marketplace.git'
      })
    ).toBeNull()
    expect(
      parseMarketplacePluginSummary({
        ...validSummary,
        sourceName: 'git@github.com:xai-org/plugin-marketplace.git'
      })
    ).toBeNull()
    expect(
      parseMarketplacePluginSummary({
        ...validSummary,
        sourceName: 'user:token@host'
      })
    ).toBeNull()
    expect(
      parseMarketplacePluginSummary({
        ...validSummary,
        sourceName: 'plugin/marketplace'
      })
    ).toBeNull()
    expect(
      parseMarketplacePluginSummary({
        ...validSummary,
        sourceName: 'C:\\cache\\marketplace'
      })
    ).toBeNull()
  })

  it('拒绝非对象与非法必填字段；可选计数缺失则省略', () => {
    expect(parseMarketplacePluginSummary(null)).toBeNull()
    expect(parseMarketplacePluginSummary([])).toBeNull()
    expect(parseMarketplacePluginSummary({ ...validSummary, displayName: 'bad\0name' })).toBeNull()
    expect(parseMarketplacePluginSummary({ ...validSummary, installed: 'yes' })).toBeNull()
    expect(parseMarketplacePluginSummary({ ...validSummary, skillCount: -1 })).toBeNull()
    expect(parseMarketplacePluginSummary({ ...validSummary, mcpCount: 1.5 })).toBeNull()

    expect(
      parseMarketplacePluginSummary({
        name: 'figma',
        displayName: 'Figma',
        description: 'Design handoff helper.',
        sourceName: 'xai-official',
        installed: true
      })
    ).toEqual({
      name: 'figma',
      displayName: 'Figma',
      description: 'Design handoff helper.',
      sourceName: 'xai-official',
      installed: true
    })
  })

  it('description 丢弃绝对路径与 NUL；安全相对说明可保留', () => {
    expect(
      parseMarketplacePluginSummary({
        ...validSummary,
        description: '/Users/me/secret.md'
      })
    ).toEqual({ ...validSummary, description: '' })
    expect(
      parseMarketplacePluginSummary({
        ...validSummary,
        description: '  Connect to browser tools  '
      })
    ).toMatchObject({ description: 'Connect to browser tools' })
  })
})
