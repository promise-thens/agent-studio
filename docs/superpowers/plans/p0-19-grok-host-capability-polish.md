# P0-19 Grok 宿主能力打磨 程序计划

> **致执行者：** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。本文件是**程序索引**，不是一次性写完的实现清单。每个子系统只在对应分计划里落地。
>
> **状态：** 已立项（2026-08-31 产品确认）。GACP-03 / P0-19g / P0-19a / GACP-06 代码已落地（开发版 GUI 未过）。下一步 P0-19b。
>
> **插入点：** 当前主线。P1 扩展与 P2 Codex 搁置期间，Grok 日用能力按本程序推进。P0-13 产物走查仍建议做，但 **2026-08-31 确认：P0-10C 至 P0-13 的开发版走查暂时可以通过，不挡 P0-19 新能力开工**。走查可并行补，未走查不得把对应计划标成「开发版 GUI 已过」。

**优先级：** P0-A 打磨 / 权重 5（把一个 Runtime 做成能天天用的产品）

**Goal：** 把 Agent Studio 打磨成 Grok Build 的桌面宿主：Grok 已经会做的事，用户在桌面上能看见、能切换、能审批、能停、能审阅；桌面不自己再做一套 Agent、MCP Host 或 Computer Use 引擎。

**Architecture：** 桌面仍是 ACP Client。Plan / Sandbox / Rewind / Hooks / 后台命令 / 浏览器与 Computer Use 都由 **Grok Runtime 执行**。桌面只做：配置写入 App `GROK_HOME`、受限 spawn 参数、Permission Broker、Timeline / Artifact / Changes 投影、可见停止。P3-05/06/07 桌面自建浏览器与 Helper **排在本程序 19f 之后**，本程序不启动。

**Tech Stack：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、现有 `@agentclientprotocol/sdk`、现有 Permission Broker / Task Inspector。不新增 UI 框架，不把桌面做成 MCP Host。

**Spec：** 2026-08-31 会话。先打磨一个 Runtime；P1-06～08 与 P2 搁置；P3 提前指的是 **摊开 Grok 已有能力**，不是跳去做桌面原生 Computer Use Helper。

## Global Constraints

- Node `>=20`，本机验证优先 22/24；pnpm 10。
- IPC 只用 `agent:*` / `app:*` / `task:*`，不得新增 `grok:*`。
- `clientCapabilities` 保持 `{}`，本程序不实现 ACP `fs` / `terminal`，不自己 Host MCP。
- 不修改用户 `~/.grok` 除 P0-10D 已允许的记忆 junction 与 `[mcp_servers.*]` 合并。
- Renderer 不读磁盘、不碰 CDP、不碰 Accessibility、看不到 `runtimeSessionId` 与明文密钥。
- 执行中禁止切换模型、Sandbox、Plan 以外会重启 Runtime 的设置；切换必须等主进程确认，禁止乐观 UI。
- 斜杠命令板继续只消费 Grok 广告，禁止手写假菜单。
- 中文注释写原因和边界；协议字段保持英文。
- 不得把「接口能调」写成「完整支持 Agent 工作流」。

---

## 1. 产品决定

2026-08-31 确认：

1. **只打磨一个 Runtime：Grok Build。**
2. **P1 搁置扩展：** 现有单 Provider 设置保留（Grok 仍要 URL / Key / 模型）。不开始 P1-06～08，不为开放模型再开一轮复核。
3. **P2 继续暂缓：** 不接 Codex app-server，不为它预留第二套工作台或插件页。
4. **P3 提前 = 宿主能力层，不是桌面自建引擎。** 先让 Grok 的 Plan、子 Agent、权限少点、Sandbox、回退、Hooks、后台命令、浏览器/电脑插件在桌面里可用。原 P3-01～07 Capability Pack / 受管浏览器 / Chrome 桥 / macOS Helper 排在 19f 之后。
5. **不搬 TUI 壳：** `/vim-mode`、`/theme`、`/doctor`、`/dashboard`、`/minimal`、`grok clone` 不做。
6. **完全接管要写，但默认关闭。** 通用 Agent 必须能接管当前 Task：显式确认后走 Grok always-approve（`session/new` 的 `_meta.yoloMode` 或观察后的 `/always-approve`）。不是静默默认 yolo，不向单条权限 RPC 回 `allow_always`，不写全局 config。见 [P0-19g](p0-19g-task-takeover-always-approve.md)。GACP-03 仍服务询问模式的少打断。

## 2. 缺口与分计划映射

| Grok 已有 | 桌面现状 | 本程序去向 |
|---|---|---|
| Plan mode（`/plan`，先方案再改代码） | 无模式切换；Timeline 已能画 `plan` 节点 | [P0-19a](p0-19a-session-plan-mode.md) |
| 子 Agent 并行 | 代码已落地扁平 + 可选 parentId 暗门；真机白名单仍空 | 既有 [GACP-06](grokACP计划/gacp-06-subagent-timeline.md)；无稳定字段禁止猜树 |
| 权限 ask / auto / always-approve | 只有 Broker，容易一个个点 | 询问模式收口 [GACP-03](grokACP计划/gacp-03-structured-permission-evidence.md)；完全接管 [P0-19g](p0-19g-task-takeover-always-approve.md) |
| Sandbox（workspace / read-only / strict） | 未暴露；spawn 无 `--sandbox` | [P0-19b](p0-19b-grok-sandbox-profile.md) |
| `/rewind` 回退一轮 | 只有 latest-turn 文件撤销 | [P0-19c](p0-19c-turn-rewind.md) 分清对话回退与文件恢复 |
| Hooks | 不展示 | [P0-19d](p0-19d-hooks-surface.md) 只展示，不由桌面执行 |
| 后台命令 / monitor | 当普通 tool_call | [P0-19e](p0-19e-background-command-monitor.md) |
| 浏览器、Computer Use | Grok 靠插件；无共享页、无 HUD | [P0-19f](p0-19f-browser-computer-use-surface.md)；自建 BrowserView 仍归 P3-05 |

已接上但几乎没走查（不算新功能，算 0 号门）：

- P0-10C/D/E 斜杠命令、插件/市场、MCP、记忆
- P0-11 命令证据
- P0-12 / 12A Git 审阅
- P0-13 Artifact 面板
- P0-18 附件柜

## 3. 开发顺序

```text
0. 已写未验走查（P0-13 优先，再 10C/D/E、11、12）
     2026-08-31：暂时可以通过，不挡下面开工；走查并行补
1. GACP-03 少打断权限收口（询问模式；代码声称已落地，真机/GUI 未跑）
     ↓
1b. P0-19g Task 完全接管（always-approve，默认关、显式确认）
     ↓
2. P0-19a Plan mode
     ↓
3. GACP-06 子 Agent（无父子字段只保持扁平 + 提示，禁止猜树）
     ↓
4. P0-19b Sandbox 配置与受限重启
     ↓
5. P0-19c 一轮回退（对话 /rewind 与文件 latest-turn 恢复分开）
     ↓
6. P0-19d Hooks 只读表面
     ↓
7. P0-19e 后台命令监视
     ↓
8. P0-19f 浏览器 / Computer Use 插件表面（截图 Artifact、L3 审批、可见停止）
     ↓
9. 若仍缺「和 Agent 看同一页」→ 才启动 P3-05 受管浏览器
```

**可穿插、不挡本程序：** P0-14 Worktree 仍是 P0-B 交付门，可与 GACP-06 并行，但不把 Worktree 当成「Grok 能力摊开」的前置。

**明确后置：** P0-15 用户 PTY、P0-16 HTML Preview、P0-17 并行调度、P1-06～08、P2、P3-01～07、GACP-05 Client 能力广告。

## 4. 0 号门：已写未验（暂时不挡开工）

**2026-08-31：** P0-10C 至 P0-13 开发版走查暂时可以通过，**不阻塞** GACP-03 / P0-19a 起的实现。未走查仍不当「开发版 GUI 已过」；失败就修，不另开功能号。有空再按表补记录：日期、开发版/解包版、通过或失败的具体路径。

| 顺序 | 走查 | 最低路径 |
| --- | --- | --- |
| 1 | P0-13 Artifacts | 文本 / Markdown / 图片 / Diff；恶意 Markdown 不执行；源文件变化后内容是否仍可信 |
| 2 | P0-10C 斜杠命令 | `/` 只出现 Grok 广告 ∪ 产品别名；执行中切插件页不停止 Task |
| 3 | P0-10D 记忆 / MCP | 记忆开关；MCP 添加后下一 session 才注入；Secret 不回填 |
| 4 | P0-10E 插件市场 | 从货架安装一项、信任勾选、卸载；不读 `~/.grok` |
| 5 | P0-11 命令证据 | Timeline 点开证据，不进用户终端 |
| 6 | P0-12/12A Diff | Changes 加宽审阅；latest-turn 撤销预览与漂移拒绝 |

走查失败就修，不另开功能号。走查通过后才能把对应计划标成「开发版 GUI 已过」。

## 5. 非目标（整条程序）

- 不自己实现记忆引擎、MCP 运行时、`/compact` / `/dream` 语义。
- 不把桌面做成 Marketplace Host 或 MCP Host。
- 不把 always-approve 做成静默默认或全局 config；接管只按 [P0-19g](p0-19g-task-takeover-always-approve.md) 做当前 Task 显式开关。
- 不在 Inspector 新增第五个顶层标签。现有 id 仍是 `timeline | changes | terminal | artifacts`；浏览器证据进 Timeline + Artifacts，终端标签继续留给 P0-15 用户 PTY，**不得**把 Agent 后台命令写进用户 Shell。
- 不做共享 BrowserView、CDP 任意转发、Chrome Profile 读取、macOS 虚拟光标。
- 不为 Codex 复制本程序的表面。

## 6. 安全总则

- 浏览器、屏幕、剪贴板、Computer Use 默认 L3，不能被「本任务允许写文件」捎带。
- Sandbox 是 Grok 内核策略，不是 Electron `webPreferences.sandbox`，UI 文案必须分开。
- `/rewind` 是 Grok 会话回退；`task:restore-latest-turn` 是文件检查点恢复。产品上两颗按钮或一张卡上的两行，禁止合成「撤销」一个词。
- Hooks 摘要不得包含命令原文里的 Secret、绝对路径可截断但不可外逃展示。
- 后台命令停止走现有 Task 停止 / 未来的受限 cancel，不向 PTY 注入 Ctrl+C 冒充。

## 7. 验收（程序级）

日常用 Grok 桌面时，用户可以：

1. 用 Plan 先出方案再改代码，主列看得到计划清单。
2. 询问模式：项目内读写和普通命令大多数 Turn 不弹卡（GACP-03）；危险操作仍打断。打开完全接管后普通权限卡不再出现，HUD 可见且可停。
3. 为 Task 选择 Sandbox 档位，空闲时重启 Runtime 生效，未授权不伪造已沙箱。
4. 回退上一轮时分得清「对话」和「文件」，漂移则拒绝自动改盘。
5. 看见本 GROK_HOME 里的 Hooks 是否启用，桌面不替 Grok 跑它们。
6. 后台命令在 Timeline 标成后台，可停，输出进证据而不是用户终端。
7. 安装并信任浏览器/电脑插件后，截图进 Artifacts，屏幕/浏览器动作走 L3 + 可见停止。

自动门禁仍是：目标文件 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build`、`git diff --check`。UI 改动必须有开发版走查记录。

## 8. 文档同步

立项后必须同步：

- [roadmap-index.md](roadmap-index.md) 增加本程序为当前主线，P1 扩展 / P2 / 原 P3 引擎后置。
- [grokACP计划/README.md](grokACP计划/README.md) 插入顺序接上 GACP-03 / GACP-06 与本程序。
- [product-vision.md](../../product-vision.md) 记录 2026-08-31 决定。
- `AGENTS.md` 与 `CLAUDE.md` 第 15 节快照。

实现与分计划冲突时改分计划，不允许文档描述不存在的行为。
