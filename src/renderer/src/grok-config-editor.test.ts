import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const rendererDir = dirname(fileURLToPath(import.meta.url))
const editorSource = readFileSync(join(rendererDir, 'components/GrokConfigEditor.vue'), 'utf8')

describe('Grok 配置页布局', () => {
  it('长行折行显示，不用 pre 把 TOML 裁出编辑框', () => {
    expect(editorSource).toMatch(/white-space:\s*pre-wrap/)
    expect(editorSource).not.toMatch(/white-space:\s*pre;/)
    expect(editorSource).not.toContain('min-height: 280px')
  })

  it('编辑器和说明共用一张铺满卡片，保存栏不和编辑区抢满高', () => {
    expect(editorSource).toContain('class="config-body"')
    expect(editorSource).toContain('class="config-footer"')
    expect(editorSource).toMatch(/\.config-footer\s*\{[^}]*flex:\s*0\s+0\s+auto/)
  })
})
