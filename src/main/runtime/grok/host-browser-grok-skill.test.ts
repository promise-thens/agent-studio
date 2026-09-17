import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ensureHostBrowserGrokSkill,
  HOST_BROWSER_GROK_SKILL_MARKDOWN,
  HOST_BROWSER_GROK_SKILL_NAME
} from './host-browser-grok-skill'

describe('ensureHostBrowserGrokSkill', () => {
  it('写入 App grok-home/skills，不把 OCR 当主路径', async () => {
    const grokHome = await mkdtemp(join(tmpdir(), 'agent-studio-skill-'))
    const skillFile = await ensureHostBrowserGrokSkill(grokHome)
    expect(skillFile).toBe(join(grokHome, 'skills', HOST_BROWSER_GROK_SKILL_NAME, 'SKILL.md'))
    const body = await readFile(skillFile, 'utf8')
    expect(body).toBe(HOST_BROWSER_GROK_SKILL_MARKDOWN)
    expect(body).toContain('browser_click')
    expect(body).toContain('x,y,width,height')
    expect(body).toContain('禁止')
    expect(body).toContain('OCR')
    const again = await ensureHostBrowserGrokSkill(grokHome)
    expect(again).toBe(skillFile)
    expect(await readFile(skillFile, 'utf8')).toBe(body)
  })
})
