# P0-19g Task 完全接管（Always-approve）实施计划

> **致执行者：** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。
>
> **状态：** 任务 1–3 代码已落地；开发版 GUI 走查未跑。接管默认关，Composer 三档 ask/assist/takeover。
>
> **插入点：** [P0-19](p0-19-grok-host-capability-polish.md) 在 GACP-03 之后、Plan mode 之前。2026-08-31 产品更正：通用 Agent 要能完全接管，因此**要写** always-approve，但必须是当前 Task 的显式开关，不是静默默认 yolo。

**优先级：** P0-A / 权重 5（通用 Agent 能否自己干活，取决于能不能摘掉逐次审批）

**Goal：** 用户可以为**当前 Task** 打开「完全接管」：Grok 按 always-approve 跑工具，不再弹普通权限卡。桌面始终显示接管中，并能一键停。默认仍是询问 + GACP-03 少打断。

**Architecture：** 接管是 Task 快照上的模式，不是进程全局 `--always-approve`，也不是向每条 `request_permission` 回 `allow_always`。

- **新建 session：** `session/new` 增加桌面自己写的 `_meta.yoloMode: true`（见 Grok `15-agent-mode.md`）。不得把 Renderer 任意 `_meta` 透传。
- **已有 session 中途打开：** 任务 1 先观察 `/always-approve` 是否广告且能切换当前 session。能则空闲时发该命令；不能则提示「下一轮新建 session 后生效」，禁止为了开关丢掉可恢复上下文。
- **关掉：** 对偶观察 `/always-approve` 再发一次，或 Grok 提供的回到 ask 的命令。失败则保持 HUD 为「接管可能仍在」，不得假装已回到询问。
- **单条权限 RPC：** Normal 模式仍只回 `allow_once` / `reject_once`。用户确认完全访问后，Grok 即使仍发 `request_permission`，桌面也必须自动 `allow-once`、**零确认卡**。禁止因此把 `takeoverApplied` 打回 false（`/always-approve` 是 toggle，再发一次会把接管关掉）。产品路径仍然不回 `allow_always`。

**Tech Stack：** 现有 `GrokAcpAdapter.createSession` / `newSession`、Task 快照、Composer footer、执行中停止条。不改 Electron `sandbox`。

**Spec：** [P0-19](p0-19-grok-host-capability-polish.md) 2026-08-31 更正；Grok `22-permissions-and-safety.md`（deny / hooks 在 always-approve 下仍生效）。

## Global Constraints

- 沿用 P0-19，但覆盖其中「不接 always-approve」旧句。
- **默认关闭。** 新 Task、新用户都是询问模式。
- **范围是当前 Task**，不是 App 永久默认，不写进用户 `~/.grok`，不把 `[ui] permission_mode` 设成全局 always-approve。
- 打开前必须确认文案，写明：将不再询问；Broker 看不到 Grok 没上报的副作用；已装的浏览器/电脑插件会一起执行；deny 规则和 Hooks 仍由 Grok 执行。
- 执行中可保持接管，但**打开/关闭开关**只允许空闲（与切模型相同）。
- Renderer 不得自己设 yolo；只有主进程在 Task 快照为接管时写入布尔 `_meta.yoloMode`。
- 不得把 `allow_always` 当作单次权限的回复选项重新打开。
- 中文注释写清：这是把审批交给 Grok always-approve，不是 Permission Broker 沙箱。

---

## 非目标

- 不做进程级 `grok agent --always-approve stdio` 作为默认启动（那会让这条连接上所有 Task 一起 yolo）。仅当任务 1 证明 `session/new` 的 `yoloMode` 无效时，才允许**在该 Task 的连接策略里**加旗标，并必须随断开而消失。
- 不做「永远接管」设置项（可在确认后再议）。
- 不把 Plan 和接管合成一个开关。Plan 仍是 19a；互斥：开 Plan 则关掉接管，开接管则退出 Plan。
- 不在接管里静默允许桌面自己的 git reset / 用户 PTY。

## 数据流

```text
Composer「完全接管」
  → 空闲 + 确认对话框
  → Task 快照 takeoverEnabled = true
  → 若尚无 session：下次 createSession 带 _meta.yoloMode=true
  → 若已有 session：按任务 1 的策略发 /always-approve 或等下一次可安全的 session
  → HUD：「完全访问中，不再询问权限」+ 停止
Grok 工具
  → 预期无 request_permission
  → 若仍有：Broker 自动 allow-once，不弹卡；HUD「完全访问中，不再询问权限」
停止 / 关接管
  → cancelTurn（若 busy）
  → 快照 takeoverEnabled = false
  → 按观察关闭 Grok 模式
```

## 安全边界

- 产品必须诚实：接管 = **Grok 不再问桌面**。P0-07 Broker 不是进程沙箱，此时更不是。
- L3 浏览器/屏幕在接管下**不会再弹卡**。这是通用 Agent 接管的本意。HUD 在已安装相关插件时要提到屏幕/浏览器。
- 审计：打开/关闭接管写一条 Task 审计（无密钥、无 prompt 全文），便于事后知道为什么没有权限卡。
- 确认框默认焦点不要放在「开启」上；`prefers-reduced-motion` 下 HUD 仍必须可见。
- Titlebar/HUD 按钮 `no-drag`，有 `title` / `aria-label`。

## 文件范围

- 修改：`src/main/runtime/grok/grok-acp-adapter.ts` 的 `newSession` 参数
- 修改：Task 快照类型（`src/shared` / TaskStore），只存布尔与更新时间
- 修改：`TaskComposer.vue` 开关 + 确认
- 修改：执行中 HUD（与 19f 共用一条停止条，文案按模式区分）
- 测试：默认 newSession **没有** `_meta`；接管 Task 才有 `yoloMode: true`；Renderer 不能注入其它 _meta 键；Normal 模式仍拒绝回 `allow_always`

### 任务 1: 冻结生效路径

- [x] **第 1 步: 观察 session/new yoloMode**

说明：隔离 grok-home 下 `newSession({ cwd, mcpServers, _meta: { yoloMode: true } })`，再让 Grok 写文件/跑命令，确认不再 `request_permission`。把请求 JSON 记入 observations。失败则试文档中的 `grok agent --always-approve`，并记录「连接级」副作用。

- [x] **第 2 步: 观察中途开关**

说明：普通 session 里发 `/always-approve`（若广告），看是否当轮生效、如何关。无命令则中途打开只能「下一 session」。把策略写成纯函数 `resolveTakeoverApply({ hasSession, advertisedCommands, idle })`。

### 任务 2: Task 快照与 session/new

- [x] **第 1 步: 快照字段**

说明：`takeoverEnabled: boolean`，默认 false。进历史重开时仍在，但 resume 成功后必须按任务 1 再应用一次；应用失败 HUD 为未生效，不得假装已接管。

- [x] **第 2 步: Adapter**

说明：仅当该 Task `takeoverEnabled` 时 `newSession` 带 `_meta: { yoloMode: true }`。测试：普通 Task 调用参数严格等于今天的 `{ cwd, mcpServers }`（可加 mcp，但无 _meta）。禁止把未知 _meta 字段传给 Grok。

### 任务 3: 开关、确认、HUD

- [x] **第 1 步: 确认文案（固定，禁止改成软化）**

说明：标题「让 Grok 完全接管当前任务？」正文必须包含：不再询问工具权限；桌面看不到未上报的操作；命令、改文件、出网都会自己做；若已启用浏览器或 Computer Use 插件，也会自己点。按钮：「取消」主按钮，「开始接管」次要危险按钮。

- [x] **第 2 步: Composer + HUD**

说明：footer 在模型旁；执行中开关禁用，HUD 仍显示。停止 = 现有 stop Turn。关接管走任务 1 策略。与 Plan 互斥。

- [ ] **第 3 步: 走查**

说明：默认写文件仍可能弹卡（或 GACP-03 本任务一次）。打开接管后同一类操作不再弹卡，Grok 仍问也由桌面代批。停止后面板不再写「完全访问中」。重开 Task 若快照为开，resume 后继续零确认卡。

## 验收标准

- [ ] 默认询问；未确认不能进接管。
- [ ] 接管 Task 的 `session/new` 带且仅带 `yoloMode: true` 这一个 _meta 键（若任务 1 走该路径）。
- [ ] 普通权限路径仍然从不回复 `allow_always`。
- [ ] HUD 在接管期间可见且可停。
- [ ] 不写入 `~/.grok`，不把全局 config 设成 always-approve。
- [ ] 自动验证 + 开发版走查。
