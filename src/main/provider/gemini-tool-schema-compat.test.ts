import { describe, expect, it } from 'vitest'
import {
  needsGeminiToolSchemaCompat,
  sanitizeChatCompletionsToolSchemas
} from './gemini-tool-schema-compat'

describe('needsGeminiToolSchemaCompat', () => {
  it('只把名称里带 gemini 的模型交给兼容清洗', () => {
    expect(needsGeminiToolSchemaCompat('gemini-3-flash')).toBe(true)
    expect(needsGeminiToolSchemaCompat('google/gemini-2.5-pro')).toBe(true)
    expect(needsGeminiToolSchemaCompat('models/gemini-2.0-flash')).toBe(true)
    expect(needsGeminiToolSchemaCompat('grok-4.6')).toBe(false)
    expect(needsGeminiToolSchemaCompat('claude-sonnet-4-6')).toBe(false)
  })
})

describe('sanitizeChatCompletionsToolSchemas', () => {
  it('去掉 todo_write status 与 isolation 里会让 Gemini 400 的空 enum', () => {
    const body = {
      model: 'gemini-3-flash',
      messages: [{ role: 'user', content: '早上好' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'todo_write',
            parameters: {
              type: 'object',
              properties: {
                todos: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      status: {
                        type: 'string',
                        enum: ['pending', 'in_progress', 'completed', 'cancelled', null]
                      }
                    }
                  }
                }
              }
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'run_command',
            parameters: {
              type: 'object',
              properties: {
                isolation: {
                  type: 'string',
                  enum: ['workspace', 'none', '']
                }
              }
            }
          }
        }
      ]
    }

    const sanitized = sanitizeChatCompletionsToolSchemas(body)

    expect(sanitized).toMatchObject({
      messages: [{ content: '早上好' }],
      tools: [
        {
          function: {
            parameters: {
              properties: {
                todos: {
                  items: {
                    properties: {
                      status: { enum: ['pending', 'in_progress', 'completed', 'cancelled'] }
                    }
                  }
                }
              }
            }
          }
        },
        {
          function: {
            parameters: {
              properties: {
                isolation: { enum: ['workspace', 'none'] }
              }
            }
          }
        }
      ]
    })
    expect(body.tools[0]).toMatchObject({
      function: {
        parameters: {
          properties: {
            todos: {
              items: {
                properties: {
                  status: { enum: ['pending', 'in_progress', 'completed', 'cancelled', null] }
                }
              }
            }
          }
        }
      }
    })
  })

  it('enum 全是空值时删除该字段，并保留 0 / false', () => {
    const sanitized = sanitizeChatCompletionsToolSchemas({
      tools: [
        {
          function: {
            parameters: {
              properties: {
                empty: { enum: [null, '', '   '] },
                flags: { enum: [0, false, 'on'] }
              }
            }
          }
        }
      ],
      functions: [{ parameters: { properties: { mode: { enum: [null] } } } }]
    })

    expect(sanitized).toEqual({
      tools: [
        {
          function: {
            parameters: {
              properties: {
                empty: {},
                flags: { enum: [0, false, 'on'] }
              }
            }
          }
        }
      ],
      functions: [{ parameters: { properties: { mode: {} } } }]
    })
  })
})
