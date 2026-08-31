# P0-19a Session Plan Mode 实施计划

> **致执行者：** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。步骤使用复选框 (`- [ ]`) 跟踪。
>
> **状态：** 待开始。
>
> **插入点：** [P0-19](p0-19-grok-host-capability-polish.md) 在 GACP-03 收口之后。主列计划清单皮肤跟 [P0-10A](p0-10a-claude-desktop-workbench-ui.md)，不另做检查器「计划」页。

**优先级：** P0-A / 权重 4（Grok 已有 Plan mode，桌面缺的是切换与可见状态）

**Goal：** 用户能在输入框把下一轮切到 Plan：Grok 先读代码、写方案、征求确认，再改仓库。桌面不实现第二套规划引擎。

**Architecture：** 工作台持有 Task 级 `composerMode: 'normal' | 'plan'`。切到 Plan 后，下一次 `startTurn` 把用户正文交给 Grok 的 `/plan`（仅当 session 命令快照里存在 `plan`）。ACP `plan` 更新继续走现有 Timeline `plan` 节点与主列清单。Grok 调用 `enter_plan_mode` 时仍走 Permission Broker，不得桌面静默替用户同意。

**Tech Stack：** 现有 Vue Composer、slash 命令快照、`agent.startTurn`、Timeline reducer。不改 `clientCapabilities`。

**Spec：** [P0-19](p0-19-grok-host-capability-polish.md) 第 2 节 Plan 行。

## Global Constraints

- 沿用 P0-19 全部约束。
- 禁止手写「假 /plan」：Grok 没广告 `plan` 时，开关禁用并说明「当前会话未提供 Plan」。
- 执行中禁止改 mode；空闲才切。
- 不实现 `/view-plan` 独立编辑器；只展示 Runtime 推过来的 plan entries。
- 不把 Plan 当只读沙箱伪造：文件锁是 Grok 的事，桌面只显示 mode 与计划清单。

---

## 非目标

- 不在本计划实现 always-approve；完全接管见 [P0-19g](p0-19g-task-takeover-always-approve.md)，与 Plan 互斥。
- 不写 plan.md 到项目磁盘。
- 不在检查器增加 Plan 标签。

## 数据流

```text
Composer 点「Plan」
  → 仅当 availableCommands 含 name=plan
  → taskComposerMode = plan（本地 UI 状态，可进 Task 会话草稿，不进 Timeline）
用户发送
  → startTurn(prompt)
  → 若 mode=plan 且正文不是已以 / 开头的 Runtime 命令
        则实际 prompt = "/plan " + 用户正文（或单独先发 /plan 再发正文：以真机 Grok 行为为准，任务 1 必须先测）
  → Grok session/update plan
  → 现有 plan 节点 → 主列清单打勾
Grok 请求 enter_plan_mode
  → 现有 permission RPC → Broker
  → 用户允许后 Grok 进入其 plan mode
退出：用户切回 Normal，或 Grok exit_plan_mode 后桌面把开关拨回 Normal（不得在 Grok 仍处于 plan 时假装已退出）
```

## 安全边界

- `/plan` 仍走 `startTurn` 限长与现有 prompt 校验。
- Plan 期间写仓库若 Grok 上报权限，Broker 照常；不得因 UI 显示 Plan 就自动允许写文件。
- 命令快照字段仍只允许 `name` / `description` / `inputHint`。

## 文件范围

- 修改：`src/renderer/src/components/TaskComposer.vue`、`slash-command-palette.ts`
- 修改：`src/renderer/src/App.vue` 或持有 composer 状态的 composable（把 mode 留在 Renderer 即可，除非要跨重启恢复）
- 修改：主列对话把 `TimelinePlanNode` 画成可打勾清单（若 P0-10A 已有则只接线，不重做皮）
- 测试：`slash-command-palette.test.ts`、Composer 测、timeline/conversation 测
- 可选主进程：只有真机证明必须拆成两次 prompt 时才加 Adapter 辅助，默认不新 IPC

### 任务 1: 冻结 /plan 真机语义

**任务目标：** 写清「开关 + 一句用户话」在 Grok ACP 里要发什么，避免猜。

- [ ] **第 1 步: 对照 TUI 与 ACP**

说明：在 App `GROK_HOME` 开发版会话看 `available_commands_update` 是否包含 `plan` / `view-plan`。分别试：只发 `/plan`、发 `/plan 加登录`、先 `/plan` 再发正文。记录 Grok 是否进入 plan、是否出现 `enter_plan_mode` 权限、`plan` session/update 形状。写进 `docs/superpowers/plans/grokACP计划/observations/` 一小节，不重开 GACP-01 全表。

预期：后续任务只实现已观察路径。若 Grok 从未广告 `plan`，开关保持禁用，本计划不得伪造命令。

- [ ] **第 2 步: 选一条发送策略并写测试夹具**

说明：把选定策略写成纯函数，例如 `resolvePlanSubmit({ mode, prompt, hasPlanCommand })`，覆盖：normal 原样；plan + 普通正文；plan + 已是 `/compact`；无 plan 命令；执行中。

预期：无广告时永不改写 prompt。

### 任务 2: Composer 开关

**任务目标：** 输入框 footer 在模型选择器旁提供 Plan 开关，有 `title` / `aria-label`，Titlebar 外区域保持可点。

- [ ] **第 1 步: 失败测试**

说明：无 `plan` 命令时按钮 `disabled` 且说明原因；有命令且空闲时可切；执行中不可切；切到 plan 后提交走任务 1 的纯函数。

- [ ] **第 2 步: 实现最小 UI**

说明：复用现有 footer 变量，不要新颜色体系。小窗口可缩成图标，但必须留下模型选择器、输入、发送。

- [ ] **第 3 步: 退出对齐**

说明：用户切回 Normal 只影响下一轮。若观察里 Grok 有明确 exit 信号，再把开关拨回去；没有信号就保持用户选择，状态条可写「下一轮按 Plan 发送」。

### 任务 3: 主列计划清单

**任务目标：** Plan 条目在对话流里能看见 pending/completed，而不是只在 Timeline 调试卡。

- [ ] **第 1 步: 确认 P0-10A 是否已渲染 plan 节点**

说明：已有则补空态「Grok 还没给出计划」；没有则在 `conversation-turn-view.ts` 增加 plan block，复用已有 `TimelinePlanNode`。

- [ ] **第 2 步: 走查**

说明：开发版：开 Plan → 发「给设置页加一个开关」→ 看到计划清单 → 确认后才出现写文件工具。拒绝 `enter_plan_mode` 时仍停在未改代码。

## 验收标准

- [ ] Grok 广告了 `plan` 时，空闲可切，发送语义与观察一致。
- [ ] 没广告时不能发出桌面伪造的 `/plan`。
- [ ] 主列看得到计划条目状态。
- [ ] 目标文件 ESLint、相关 Vitest、`pnpm typecheck`；开发版走查有记录。
