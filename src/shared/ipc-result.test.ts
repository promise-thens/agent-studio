import { describe, expect, it } from 'vitest'
import type { DesktopIpcResult } from './ipc-result'

describe('DesktopIpcResult', () => {
  it('成功和失败结果都可结构化克隆并完成 JSON 往返', () => {
    const results: DesktopIpcResult<unknown>[] = [
      { ok: true, value: { state: 'ready', value: null } },
      { ok: false, error: { code: 'invalid-input', message: '请求参数无效。' } }
    ]

    for (const result of results) {
      expect(structuredClone(result)).toEqual(result)
      expect(JSON.parse(JSON.stringify(result))).toEqual(result)
    }
  })
})
