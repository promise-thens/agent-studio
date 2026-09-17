---
name: host-browser
description: Drive Agent Studio built-in browser via agent-studio-browser MCP. Use when clicking pages, filling forms, 内置浏览器, 企业资质, snapshot, click_xy, dropdowns, or GUI automation. Do not use OCR or Python on screenshots.
---

# 内置浏览器

只用 MCP `agent-studio-browser`。目标是少步、少截图、用 ref 点框。

## 必做

1. 先 `browser_snapshot`。节点若有 `x,y,width,height`，用 `browser_click` 的 `ref`，不要猜像素。
2. 打开下拉、弹窗、日期面板后立刻再 snapshot，点新出现的 `option` / `menuitem` / `gridcell`。
3. 输入走 `browser_type`（带 snapshot ref）。
4. 整页确认最多 `browser_screenshot` 一次；不要逐步截图。

## 禁止

- OCR，或终端 Python/PIL/`read_file` 去算点击坐标
- 为点一下就 `search_tool`
- `browser_click_xy` / `click_at` 点普通按钮、菜单、表单（只留给 iframe / canvas，或 snapshot 没有该 option）
- 0-1000 归一化坐标、桌面全局坐标
- 假装能填原生文件选择器

页面变了就重新 snapshot。有框就点 ref。
