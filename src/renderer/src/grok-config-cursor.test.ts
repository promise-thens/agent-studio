import { describe, expect, it } from 'vitest'
import { matchGrokConfigHint } from '../../shared/grok-config-hints'
import { parseTomlCursor } from './grok-config-cursor'

const sample = `[memory]
enabled = true

[session]
auto_compact_threshold_percent = 85
mystery = 1
`

describe('toml 光标扫描', () => {
  it('光标在 enabled = true 且上一表是 [memory] → 命中 memory.enabled', () => {
    const offset = sample.indexOf('enabled = true')
    const cursor = parseTomlCursor(sample, offset)
    expect(cursor).toEqual({ table: 'memory', key: 'enabled' })
    expect(matchGrokConfigHint(cursor.table, cursor.key)?.title).toBe('memory.enabled')
  })

  it('光标在未知键 → match 为表级', () => {
    const offset = sample.indexOf('mystery')
    const cursor = parseTomlCursor(sample, offset)
    expect(cursor).toEqual({ table: 'session', key: 'mystery' })
    expect(matchGrokConfigHint(cursor.table, cursor.key)?.title).toBe('表 session')
  })
})
