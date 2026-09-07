import { describe, expect, it } from 'vitest'
import { readRendererErrorMessage } from './renderer-error-message'

describe('readRendererErrorMessage', () => {
  it('剥掉 Electron IPC 外壳，只保留主进程错误正文', () => {
    expect(
      readRendererErrorMessage(
        new Error(
          "Error invoking remote method 'provider:select-model': Error: 未找到 /chat/completions，请检查 Base URL：Requested entity was not found."
        )
      )
    ).toBe('未找到 /chat/completions，请检查 Base URL：Requested entity was not found.')
  })

  it('没有 IPC 外壳时原样返回，空值回退默认文案', () => {
    expect(
      readRendererErrorMessage(new Error('模型不存在或当前账号无权使用，请检查 Model ID'))
    ).toBe('模型不存在或当前账号无权使用，请检查 Model ID')
    expect(readRendererErrorMessage('')).toBe('操作失败。')
    expect(readRendererErrorMessage(null)).toBe('操作失败。')
  })
})
