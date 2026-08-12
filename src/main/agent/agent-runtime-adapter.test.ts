import { describe, expect, it } from 'vitest'
import { AgentRuntimeAdapterError } from './agent-runtime-adapter'

describe('AgentRuntimeAdapter 契约', () => {
  it('只通过有限错误码和已脱敏文案跨越 Adapter 边界', () => {
    const error = new AgentRuntimeAdapterError('session-restore-unsupported', '会话恢复不可用。')

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('AgentRuntimeAdapterError')
    expect(error.code).toBe('session-restore-unsupported')
    expect(error.message).toBe('会话恢复不可用。')
    expect(error).not.toHaveProperty('cause')
    expect(error).not.toHaveProperty('raw')
  })
})
