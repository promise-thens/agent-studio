import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractCssRuleBlock } from './task-list-overflow'

const mainCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'assets/main.css'),
  'utf8'
)

describe('用户句靠右', () => {
  it('发送的对话贴阅读列右侧，助手回复仍左起阅读', () => {
    const user = extractCssRuleBlock(mainCss, '.conversation-user')
    const assistant = extractCssRuleBlock(mainCss, '.conversation-assistant')

    expect(user).toMatch(/justify-self:\s*end/)
    expect(user).toMatch(/width:\s*fit-content/)
    expect(user).toMatch(/max-width:\s*min\(\s*100%\s*,\s*72%\s*\)/)
    expect(assistant).not.toMatch(/justify-self:\s*end/)
  })
})
