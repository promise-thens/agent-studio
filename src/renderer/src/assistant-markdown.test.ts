import { describe, expect, it } from 'vitest'
import { parseAssistantMarkdown } from './assistant-markdown'

describe('parseAssistantMarkdown', () => {
  it('把普通文本收成一段，不发明 HTML 节点', () => {
    expect(parseAssistantMarkdown('这些都不是「同时 N 路」。')).toEqual([
      {
        type: 'paragraph',
        children: [{ type: 'text', value: '这些都不是「同时 N 路」。' }]
      }
    ])
  })

  it('解析标题、强调、行内代码和安全外链', () => {
    expect(
      parseAssistantMarkdown(
        '## 用量\n\nSuperGrok 是**每周用量池**，SKU 为 `supergrok.pro.monthly.300`，见 [FAQ](https://docs.x.ai/grok/faq)。'
      )
    ).toEqual([
      {
        type: 'heading',
        level: 2,
        children: [{ type: 'text', value: '用量' }]
      },
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'SuperGrok 是' },
          { type: 'strong', children: [{ type: 'text', value: '每周用量池' }] },
          { type: 'text', value: '，SKU 为 ' },
          { type: 'code', value: 'supergrok.pro.monthly.300' },
          { type: 'text', value: '，见 ' },
          {
            type: 'link',
            href: 'https://docs.x.ai/grok/faq',
            children: [{ type: 'text', value: 'FAQ' }]
          },
          { type: 'text', value: '。' }
        ]
      }
    ])
  })

  it('危险链接降级为纯文本，原始 HTML 与图片不进入 AST', () => {
    expect(parseAssistantMarkdown('[点我](javascript:alert(1))')).toEqual([
      {
        type: 'paragraph',
        children: [{ type: 'text', value: '点我' }]
      }
    ])
    expect(parseAssistantMarkdown('<script>alert(1)</script>')).toEqual([
      {
        type: 'paragraph',
        children: [{ type: 'text', value: '<script>alert(1)</script>' }]
      }
    ])
    expect(parseAssistantMarkdown('![logo](https://evil.example/x.png)')).toEqual([
      {
        type: 'paragraph',
        children: [{ type: 'text', value: 'logo' }]
      }
    ])
  })

  it('解析无序列表、围栏代码和 GFM 表格', () => {
    const markdown = [
      '- 每周额度是一个共享池',
      '- 用完可买 Extra Usage Credits',
      '',
      '```ts',
      'const sku = 1',
      '```',
      '',
      '| 来源 | 结果 |',
      '| --- | --- |',
      '| [plans](https://grok.com/plans) | 档位 `superGrokPro` |'
    ].join('\n')

    expect(parseAssistantMarkdown(markdown)).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [
          [{ type: 'text', value: '每周额度是一个共享池' }],
          [{ type: 'text', value: '用完可买 Extra Usage Credits' }]
        ]
      },
      {
        type: 'code',
        language: 'ts',
        value: 'const sku = 1'
      },
      {
        type: 'table',
        header: [[{ type: 'text', value: '来源' }], [{ type: 'text', value: '结果' }]],
        rows: [
          [
            [
              {
                type: 'link',
                href: 'https://grok.com/plans',
                children: [{ type: 'text', value: 'plans' }]
              }
            ],
            [
              { type: 'text', value: '档位 ' },
              { type: 'code', value: 'superGrokPro' }
            ]
          ]
        ]
      }
    ])
  })

  it('未闭合围栏在流式输出中把剩余文本当作代码块', () => {
    expect(parseAssistantMarkdown('```json\n{"a": 1')).toEqual([
      {
        type: 'code',
        language: 'json',
        value: '{"a": 1'
      }
    ])
  })
})
