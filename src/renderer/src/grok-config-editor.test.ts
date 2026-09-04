import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const rendererDir = dirname(fileURLToPath(import.meta.url))
const editorSource = readFileSync(join(rendererDir, 'components/GrokConfigEditor.vue'), 'utf8')
const settingsSource = readFileSync(join(rendererDir, 'components/SettingsDialog.vue'), 'utf8')
const appSource = readFileSync(join(rendererDir, 'App.vue'), 'utf8')
const sandboxSettingsSource = readFileSync(join(rendererDir, 'grok-sandbox-settings.ts'), 'utf8')
const sandboxComposableSource = readFileSync(
  join(rendererDir, 'composables/useGrokSandboxSettings.ts'),
  'utf8'
)

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

  it('保存成功文案说明会重载 Grok 使原生配置生效', () => {
    expect(editorSource).toContain('空闲时会重载 Grok')
    expect(editorSource).toContain('context_window')
  })
})

describe('Grok 配置页沙箱选择器', () => {
  it('在本页提供四档 Grok 沙箱，不新开栏目，也不让 Renderer 拼 argv', () => {
    expect(editorSource).toContain('GROK_SANDBOX_TITLE')
    expect(editorSource).toContain('GROK_SANDBOX_OPTIONS')
    expect(editorSource).toContain('useGrokSandboxSettings')
    expect(sandboxSettingsSource).toContain("GROK_SANDBOX_TITLE = 'Grok 沙箱'")
    expect(editorSource).not.toContain('--sandbox')
    expect(editorSource).not.toContain('process.env.GROK_SANDBOX')
    expect(editorSource).not.toContain('GROK_SANDBOX=')
    expect(settingsSource).toContain(':runtime-busy')
    expect(settingsSource).not.toContain("section === 'sandbox'")
    expect(appSource).toContain(':runtime-busy="isBusy"')
  })

  it('选择器受控于已确认档，执行中禁用，错误关联字段', () => {
    expect(editorSource).toContain('runtimeBusy')
    expect(editorSource).toContain('sandbox.confirmed')
    expect(editorSource).toContain('aria-invalid')
    expect(editorSource).toContain('grok-sandbox-error')
    expect(editorSource).toContain('aria-label')
    expect(editorSource).toContain('title')
    expect(editorSource).not.toMatch(/outline:\s*none/)
    expect(editorSource).not.toMatch(/:focus[^{]*\{[^}]*outline:\s*0/)
  })

  it('保存选择器后刷新 toml，保存 toml 后刷新档位', () => {
    expect(editorSource).toContain('getGrokConfig')
    expect(editorSource).toContain('reloadFromSaved')
    expect(sandboxComposableSource).toContain('applied === true')
    expect(sandboxComposableSource).toContain('setGrokSandbox')
    expect(sandboxComposableSource).toContain('getGrokSandbox')
  })

  it('沙箱选择器紧凑，不把四档做成纵向大卡片挤掉 toml', () => {
    expect(editorSource).toMatch(/<select[\s\S]*id="grok-sandbox-select"/)
    expect(editorSource).not.toContain('role="radiogroup"')
    expect(editorSource).not.toContain('class="sandbox-option"')
    expect(editorSource).toMatch(/\.config-body\s*\{[^}]*min-height:\s*12rem/)
  })

  it('toml 未保存时禁用沙箱选择器，避免应用成功冲掉编辑器', () => {
    expect(editorSource).toMatch(/sandboxDisabled[\s\S]*dirty\.value/)
    expect(editorSource).toContain('GROK_SANDBOX_DIRTY_TITLE')
    expect(editorSource).toContain('if (applied) await refreshTomlFromDisk()')
  })
})
