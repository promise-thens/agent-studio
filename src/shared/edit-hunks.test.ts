import { describe, expect, it } from 'vitest'
import { buildPublicEditDiffs } from './edit-hunks'
import type { AgentDiff } from './agent'

function snapshot(path: string, before: string | null, after: string): AgentDiff {
  return { format: 'snapshot', path, before, after }
}

describe('buildPublicEditDiffs', () => {
  it('单行替换带前后上下文，并统计增删行', () => {
    const before = ['fn main() {', '  let x = 1;', '}'].join('\n')
    const after = ['fn main() {', '  let x = 2;', '}'].join('\n')
    const [edit] = buildPublicEditDiffs([snapshot('src/main.rs', before, after)])

    expect(edit).toMatchObject({
      path: 'src/main.rs',
      added: 1,
      deleted: 1
    })
    expect(edit?.hunks).toHaveLength(1)
    expect(edit?.hunks[0]).toEqual([
      { kind: 'ctx', text: 'fn main() {', oldLine: 1, newLine: 1 },
      { kind: 'del', text: '  let x = 1;', oldLine: 2 },
      { kind: 'add', text: '  let x = 2;', newLine: 2 },
      { kind: 'ctx', text: '}', oldLine: 3, newLine: 3 }
    ])
  })

  it('新建文件（before 为 null）全部为增行，行号从 1 起', () => {
    const [edit] = buildPublicEditDiffs([snapshot('src/new.ts', null, 'export const n = 1;\n')])

    expect(edit).toMatchObject({ path: 'src/new.ts', added: 1, deleted: 0 })
    expect(edit?.hunks[0]).toEqual([{ kind: 'add', text: 'export const n = 1;', newLine: 1 }])
  })

  it('两处远离的改动拆成两个 hunk，中间超过 3 行上下文的部分丢掉', () => {
    const before = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join('\n')
    const after = before.replace('line-2', 'line-2-new').replace('line-11', 'line-11-new')
    const [edit] = buildPublicEditDiffs([snapshot('a.txt', before, after)])

    expect(edit?.hunks).toHaveLength(2)
    expect(edit?.hunks[0]?.some((line) => line.text === 'line-2')).toBe(true)
    expect(edit?.hunks[0]?.some((line) => line.text === 'line-11')).toBe(false)
    expect(edit?.hunks[1]?.some((line) => line.text === 'line-11-new')).toBe(true)
  })

  it('含 NUL 的正文当二进制，不产出假文本行', () => {
    const [edit] = buildPublicEditDiffs([snapshot('blob.bin', 'a\0b', 'a\0c')])

    expect(edit).toEqual({
      path: 'blob.bin',
      added: 0,
      deleted: 0,
      unavailable: 'binary',
      hunks: []
    })
  })

  it('没有改动的 snapshot 不进入结果', () => {
    expect(buildPublicEditDiffs([snapshot('same.ts', 'keep\n', 'keep\n')])).toEqual([])
  })

  it('unified patch 能解析成 hunk 行', () => {
    const [edit] = buildPublicEditDiffs([
      {
        format: 'unified',
        paths: ['src/a.ts'],
        patch: [
          '--- a/src/a.ts',
          '+++ b/src/a.ts',
          '@@ -1,2 +1,2 @@',
          ' keep',
          '-old',
          '+new'
        ].join('\n')
      }
    ])

    expect(edit).toMatchObject({ path: 'src/a.ts', added: 1, deleted: 1 })
    expect(edit?.hunks[0]).toEqual([
      { kind: 'ctx', text: 'keep', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'old', oldLine: 2 },
      { kind: 'add', text: 'new', newLine: 2 }
    ])
  })

  it('对路径和行文本做脱敏，不回传完整未知字段', () => {
    const [edit] = buildPublicEditDiffs(
      [snapshot('secret/path.ts', 'const k = secret-token\n', 'const k = ok\n')],
      {
        redactText: (text) =>
          text.replaceAll('secret-token', '[REDACTED]').replaceAll('secret/', '')
      }
    )

    expect(edit?.path).toBe('path.ts')
    expect(JSON.stringify(edit)).toContain('[REDACTED]')
    expect(JSON.stringify(edit)).not.toContain('secret-token')
  })
})
