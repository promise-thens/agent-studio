import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const rendererDir = dirname(fileURLToPath(import.meta.url))
const panelSource = readFileSync(join(rendererDir, 'components/GrokHooksPanel.vue'), 'utf8')

describe('设置 Hooks 独立页', () => {
  it('只读列表走 listHooks，不读盘、不执行钩子', () => {
    expect(panelSource).toContain('window.app.listHooks()')
    expect(panelSource).toContain('mapGrokHookSummariesToRowViews')
    expect(panelSource).toContain('GROK_HOOKS_EMPTY_COPY')
    expect(panelSource).toContain('GROK_HOOKS_INTRO')
    expect(panelSource).toContain('GROK_HOOKS_TITLE')
    expect(panelSource).not.toContain('child_process')
    expect(panelSource).not.toContain('os.homedir')
    expect(panelSource).not.toContain('executeHook')
    expect(panelSource).not.toContain('test-hook')
  })

  it('没有启用开关或执行按钮，重试同时有 title 与 aria-label', () => {
    expect(panelSource).not.toContain('type="checkbox"')
    expect(panelSource).not.toContain('role="switch"')
    expect(panelSource).not.toContain('<input')
    expect(panelSource).toContain(':title="GROK_HOOKS_RETRY_LABEL"')
    expect(panelSource).toContain(':aria-label="GROK_HOOKS_RETRY_LABEL"')
    expect(panelSource).toContain('row.enabledLabel')
    expect(panelSource).toContain('row.targetLabel')
    expect(panelSource).toContain('row.warning')
  })
})
