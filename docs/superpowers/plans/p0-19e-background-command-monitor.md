# P0-19e 后台命令监视 实施计划

> **致执行者：** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。
>
> **状态：** 待开始。
>
> **插入点：** [P0-19](p0-19-grok-host-capability-polish.md) 在 Hooks 之后。命令事实仍归 P0-11；用户 PTY 仍归 P0-15，二者不得混用。

**优先级：** P0-A / 权重 3（Grok 能把命令丢到后台；桌面今天看起来像卡住或只是一条普通工具）

**Goal：** 当 Grok 把命令放到后台时，Timeline 工具行标明「后台运行」，能看到有限输出/退出，用户能停当前 Task（从而停这场执行）。桌面不实现第二套 process 管理器。

**Architecture：** 先观察 ACP `tool_call` / `tool_call_update` 是否有稳定后台字段（例如 background、task_id）。**没有稳定字段就只做弱提示**（标题/状态像 running 很久），禁止用正则猜命令行。有字段则投影到现有 Timeline tool 节点的可选 `execution: 'foreground' | 'background'`，输出继续进 Command Evidence，不进 Inspector Terminal 标签。

**Tech Stack：** `mapGrokSessionUpdate`、event normalizer、Timeline tool row、P0-11 evidence。

**Spec：** [P0-19](p0-19-grok-host-capability-polish.md)；Grok `20-background-tasks.md`。

## Global Constraints

- 沿用 P0-19。
- `_meta` / `rawInput` 默认仍丢掉；只有观察冻结的字段能进公开事件。
- Inspector `terminal` 标签不得用来显示 Agent 后台命令。
- 不实现 `get_command_or_subagent_output` 的桌面轮询器；Grok 自己取输出。
- 不新增 ACP client terminal 能力。

---

## 非目标

- 不做 `/loop`、scheduler、多 Task 并行（P0-17）。
- 不把后台命令提升成侧栏第二条 Task。
- 不在 Renderer 解析 ANSI 成第二套 xterm。

## 数据流

```text
Grok tool_call（观察后的后台字段）
  → GrokAcpAdapter 白名单投影
  → AgentEvent tool 节点 execution=background
  → Timeline 工具行徽章「后台」
  → 完成/失败走现有 tool 状态
  → P0-11 仍记 evidence（自动过的也记）
用户点停止
  → 现有 cancelTurn / 停 Task，不向用户 PTY 写 Ctrl+C
```

## 安全边界

- 输出进 evidence 前走现有脱敏与限长。
- 后台命令的权限仍在启动时走 Broker；不得因为「已经丢到后台」跳过未审批的 execute。
- 未知字段不得当后台。

## 文件范围

- 观察：`docs/superpowers/plans/grokACP计划/observations/`
- 可能修改：`src/main/runtime/grok/grok-acp-mappers.ts`、`src/shared/agent-event.ts`、`task-timeline-reducer.ts`、工具行组件
- 测试：有字段才标后台；无字段保持今天行为；cancel 不碰 PTY

### 任务 1: 观察后台字段

- [ ] **第 1 步: 真机或受控 fixture**

说明：让 Grok 跑一个长命令并后台化（若 ACP 暴露该能力）。记录 tool_call JSON 里哪些键稳定。没有键：本计划任务 2 只加「长时间 running 的工具行文案」，任务 3 跳过徽章，计划仍可关闭。

- [ ] **第 2 步: 冻结白名单**

说明：把允许投影的字段写进 mapper 测试。其它一概丢弃。

### 任务 2: Timeline 投影

- [ ] **第 1 步: 类型可选字段**

说明：默认 `foreground`，避免所有旧事件变成后台。

- [ ] **第 2 步: UI 徽章**

说明：折叠态也能看出后台还在跑。完成/失败颜色复用现有 tool 状态。

### 任务 3: 停止与证据

- [ ] **第 1 步: 停止仍走 Task 级 cancel**

说明：测试：busy 时点停止，不调用 terminal IPC（若 P0-15 尚未存在，则断言没有新 channel）。

- [ ] **第 2 步: 走查**

说明：后台测试命令（sleep）在 Timeline 标后台；停 Task 后状态不是永远 running；输出可在命令证据里看到有限文本。

## 验收标准

- [ ] 无稳定字段时行为与今天一致，不乱分组。
- [ ] 有字段时折叠态可见后台 + 状态。
- [ ] Agent 输出不进用户终端标签。
- [ ] 自动验证 + 开发版走查。
