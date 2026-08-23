import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import { toSerializableProviderModel } from './provider'

describe('toSerializableProviderModel', () => {
  it('把 Vue reactive 模型摊成可 structuredClone 的纯对象', () => {
    const model = reactive({
      modelId: 'deepseek-chat',
      displayName: 'DeepSeek Chat'
    })

    expect(() => structuredClone(model)).toThrowError(/could not be cloned/i)

    const payload = toSerializableProviderModel(model)
    expect(payload).toEqual({
      modelId: 'deepseek-chat',
      displayName: 'DeepSeek Chat'
    })
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype)
    expect(() => structuredClone(payload)).not.toThrow()
  })

  it('没有 displayName 时只保留 modelId，不带多余字段', () => {
    expect(toSerializableProviderModel({ modelId: 'grok-4.6' })).toEqual({ modelId: 'grok-4.6' })
  })
})
