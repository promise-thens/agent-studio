import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** App grok-home 里的技能目录名，须与 SKILL.md frontmatter name 一致。 */
export const HOST_BROWSER_GROK_SKILL_NAME = 'host-browser'

/**
 * 内置页操作技能正文。
 * 必须短：Grok 按 description 决定是否塞进上下文；写长了它不读，写飘了它去跑 OCR。
 */
export const HOST_BROWSER_GROK_SKILL_MARKDOWN = `---
name: host-browser
description: Drive Agent Studio built-in browser via agent-studio-browser MCP. Use when opening tabs, clicking pages, filling forms, 内置浏览器, 企业资质, snapshot, click_xy, dropdowns, or GUI automation. Do not use OCR, Python, or chrome-devtools click_at.
---

# 内置浏览器

只用 MCP \`agent-studio-browser\`。目标是少步、少截图、用 ref 点框。

## 必做

1. 自己 \`browser_navigate\` / \`browser_tabs_open\`。桌面会打开右栏。不要等地球图标。
2. 先 \`browser_snapshot\`。节点若有 \`x,y,width,height\`，用 \`browser_click\` 的 \`ref\`，不要猜像素。
3. 打开下拉、弹窗、日期面板后立刻再 snapshot，点新出现的 \`option\` / \`menuitem\` / \`gridcell\`。
4. 输入走 \`browser_type\`（带 snapshot ref）。
5. 整页确认最多 \`browser_screenshot\` 一次；不要逐步截图。

## 禁止

- OCR，或终端 Python/PIL/\`read_file\` 去算点击坐标
- 为点一下就 \`search_tool\`
- \`browser_click_xy\` / \`click_at\` 点普通按钮、菜单、表单（只留给 iframe / canvas，或 snapshot 没有该 option）
- chrome-devtools 的 \`click_at\`（viewport-css 不可映射，不得发明光标）
- 0-1000 归一化坐标、桌面全局坐标
- 假装能填原生文件选择器
- 等用户点地球图标才开右栏

页面变了就重新 snapshot。有框就点 ref。
`

/**
 * 把技能写进 App grok-home/skills，所有 Task（含非本仓库 cwd）都能发现。
 * 不写用户 ~/.grok。内容变了才覆盖，避免无谓 IO。
 */
export async function ensureHostBrowserGrokSkill(grokHome: string): Promise<string> {
  const skillDir = join(grokHome, 'skills', HOST_BROWSER_GROK_SKILL_NAME)
  const skillFile = join(skillDir, 'SKILL.md')
  await fs.mkdir(skillDir, { recursive: true, mode: 0o700 })
  let previous = ''
  try {
    previous = await fs.readFile(skillFile, 'utf8')
  } catch {
    previous = ''
  }
  if (previous !== HOST_BROWSER_GROK_SKILL_MARKDOWN) {
    await fs.writeFile(skillFile, HOST_BROWSER_GROK_SKILL_MARKDOWN, {
      encoding: 'utf8',
      mode: 0o600
    })
  }
  return skillFile
}
