# Grok ACP 加深计划

> 状态：已立项，P0-09 真机测试门已受限关闭，GACP-01 已于 2026-08-19 受限关闭，GACP-02 核心已落地；P0-10C 代码已落地（自动验证已过，GUI 未跑）。`available_commands_update` 现为 session 快照，不进 Timeline。
> 创建日期：2026-08-18
> 定位：在现有 `GrokAcpAdapter` 最小闭环之上，按真实 Grok ACP 方言补齐验证、恢复、审批可解释性和 Client 能力广告
> 产品愿景仍以 [product-vision.md](../../../product-vision.md) 为准；本目录不改 Runtime × Provider × Capability 分层

## 1. 为什么单独开这个目录

P0-05 已经把 `GrokAgentBridge` 收成 `GrokAcpAdapter`，P0-01 至 P0-08 把产品身份、事件、权限和单槽执行立住了。当前（2026-08-18 夜间）**P0-09 执行时间线真机验收已受限关闭**。

P0-09 真机测试门已于 2026-08-18 Windows 夜间补测后受限关闭。这时再扩 ACP，最容易犯两种错：

1. 打断 P0-09 的 persist-before-publish / 公开事件边界，把协议字段重新打进 Timeline。
2. 在还没看清真实 Grok 握手和 `session/update` 形状时，提前做 fs/terminal/MCP，或把 `rawInput` 重新打开当权限证据。

本目录只加深 **Grok 这一条 ACP 方言**，不提前建设第二 Runtime，也不替代 P0-10 工作台、P0-11 命令证据、P0-15 终端、P3-04 MCP。

## 2. 当前成熟度结论

Agent Studio 是 ACP **Client**，Grok Build 是 ACP **Agent**。成熟度必须分三层看：

| 层 | 问题 | 分数 | 含义 |
| --- | --- | ---: | --- |
| 协议宿主最小闭环 | 握手、session、文本 prompt、cancel、核心 update、permission RPC 是否正确 | 8 / 10 | 已经能安全养活第一个 Runtime |
| 完整 ACP Client | fs / terminal / MCP / 多模态 / mode / elicitation 是否实现并诚实广告 | 3 / 10 | 刻意很窄，`clientCapabilities: {}` |
| 真机 Grok 工作台 | 真实恢复、长任务、命令/外网审批可理解 | 6 / 10 | 代码路径在，产品验收未收口 |

一句话：

> 生产可用的 P0 ACP Client，不是成熟的 ACP 平台。

### 2.1 已经成熟、本目录不得回退的事实

这些实现必须被后续计划当作硬约束，而不是重写对象：

- 传输：`grok --no-auto-update agent --no-leader -m agent-studio-default stdio` + `acp.ndJsonStream` + `ClientSideConnection`。见 `src/main/runtime/grok/grok-acp-adapter.ts`。
- 握手：`initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}, clientInfo })`；版本不兼容立即拒绝；只读取 `protocolVersion`、`agentInfo.version`、`loadSession`、`sessionCapabilities.resume` / `close`。
- 身份：`taskId` / `turnId` / `executionId` 由 Agent Studio 持有；`runtimeSessionId` 只留在主进程 `AgentRuntimeSessionRef`。
- 事件：`mapGrokSessionUpdate()` 白名单投影；`rawInput` / `rawOutput` / `_meta` / tool `name` 不进授权事实。
- 权限：只回唯一 `allow_once` / `reject_once`；绝不回 `allow_always` / `reject_always`；证据冲突粘性 `invalid`，即使 UI 点允许也只能向 ACP 回 `cancelled`。
- 恢复：`activateTaskSession()` 优先 `resume`，失败且连接仍可信才 `load`；握手未声明则阻断。
- 密钥：独立 `GROK_HOME`，不改 `~/.grok`；`AGENT_STUDIO_MODEL_API_KEY` 只进 Runtime 环境，并由 `shell_environment_policy.exclude` 从工具子进程剥离。

### 2.2 本目录要补的缺口

| 缺口 | 现在的代码事实 | 不能怎么补 |
| --- | --- | --- |
| 真机 Grok 黑盒未全部走完 | GACP-01 已冻结握手、`set_model`、A→B→A `resume`、一次 `execute` 权限；load/close/退出三分支/崩溃仍为 `not-observed` | 不能用 fixture 绿替代真机；也不得用这些遗留挡住 GACP-02 |
| 点进历史还要再点「继续」 | 现有 `selectTask()` 只水合本地历史，发送被只读门禁拦住 | **已纠正：** 点进就是接着聊，恢复在后台自动做 |
| 权限要一个个点 | 每个 path / 未知 execute 都可能弹卡；grant 指纹可能过细 | **已纠正：** 能过的自动过，第一次最多点一次「本任务允许」 |
| Grok 方言没有版本契约 | `session/set_model` 是扩展方法；绑定失败会拆整条连接 | 不能猜响应形状，也不能改成宽松透传 |
| Client 能力面为空 | `clientCapabilities: {}`，Prompt 只发 text；`available_commands_update` 现为 session 快照，不进 Timeline | 未实现前不得广告 `fs` / `terminal`；命令板由 [P0-10C](../p0-10c-grok-host-surfaces.md) 消费广告，不手写菜单；`mcpServers` 由 [P0-10D](../p0-10d-grok-memory-and-mcp.md) 注入，不在本目录做 MCP Host |

## 3. 插入顺序：从 P0-09 后面开始

**最合适的起点是 P0-09 测试门关闭之后，P0-10 工作台主体之前。**

原因：

1. P0-09 正在把 Main 内部事件、公开事件、持久化事件拆开，并把 live 路径改成 persist-before-publish。这时候改 Adapter 事件面或权限投影，会让时间线测试无法收敛。
2. P0-09 完成后，才有稳定 Timeline 观察真实 `session/update`、权限卡和 Turn 终态。GACP-01 需要这块观察面。
3. 产品已确认点进历史即可接着聊。GACP-02 必须先规定自动 resume / 失败降级，P0-10 才能把侧栏做成「点进去就能打字」，而不是再做确认按钮。
4. 产品已确认能过的权限要自动过。GACP-03 依赖 P0-11 的证据和 GACP-01 的真实 kind，不能提前用 `rawInput` 放行。
5. fs/terminal 属于 P0-15 / GACP-05。Grok 会话的 MCP 列表由 P0-10D 注入；P3-04 仍是以后的通用 Host。未实现 fs/terminal 就广告，是 ACP 违规。

### 3.1 推荐开发顺序

```text
P0-09 测试门关闭
  → GACP-01 真机协议观察与能力核实
  → GACP-02 恢复能力产品契约
  → P0-10 单 Runtime 工作台
  → P0-10C 宿主表面（命令板 / 插件整页）
  → P0-10D 记忆与 MCP 设置（mcpServers 注入，不是 MCP Host）
  → P0-11 Command Evidence
  → GACP-03 结构化权限证据（只消费 P0-11 与 GACP-01 已冻结字段）
  → P0-12 Git Review
  → GACP-04 Grok ACP 方言兼容契约（可与 P0-12 并行，必须在 P2 前完成）
  → …P0-B / P0-15…
  → GACP-05 Client 能力广告（只有真做了 fs/terminal 才启动）
```

P0-A 主表因此变成：

| 开发顺序 | 计划 | 权重 | 能否开始 | 说明 |
| ---: | --- | ---: | --- | --- |
| 5 | P0-09 | 4 | 真机验收已受限关闭 | 本目录的前置观察面 |
| 5a | [GACP-01](gacp-01-real-grok-protocol-verification.md) | 5 | 已完成（受限关闭） | 2026-08-19 冻结观察表；遗留见该计划「遗留且不挡后续」 |
| 5b | [GACP-02](gacp-02-session-restore-capability-contract.md) | 5 | 核心已落地，待手工/e2e 收口 | 点进历史即可接着聊，无二次确认；load 仍按未核实降级 |
| 6 | P0-10 | 5 | GACP-02 后 | 工作台按「点进去就能发」来做，禁止加回继续按钮 |
| 6b | [P0-10C](../p0-10c-grok-host-surfaces.md) | 4 | 代码已落地（自动验证已过，GUI 未跑） | 命令板 + 插件整页；`available_commands_update` 为 session 快照，不进 Timeline |
| 6c | [P0-10D](../p0-10d-grok-memory-and-mcp.md) | 4 | P0-10C 后 | 设置记忆/MCP；Grok 执行 |
| 7 | P0-11 | 5 | 仍按原依赖 | 命令证据事实源 |
| 7a | [GACP-03](gacp-03-structured-permission-evidence.md) | 4 | P0-11 后 | 能过的自动过，不要一个个点 |
| 8 | P0-12 | 5 | 原依赖不变 | Diff 审阅 |
| 8a | [GACP-04](gacp-04-grok-acp-dialect-compat.md) | 4 | P0-10 后、P2 前 | 冻结 Grok 启动/握手/set_model |
| 5c | [GACP-06](gacp-06-subagent-timeline.md) | 3 | P0-10A 后；无父子字段只做扁平 | 子 Agent 嵌套卡片；不挡 GACP-02 / 换皮 |
| 晚 | [GACP-05](gacp-05-client-capability-advertisement.md) | 3 | P0-15 后且产品确认 | 未实现不得广告 |

P0-08 的真实 Grok 活动退出与重启 `interrupted` 已在 2026-08-18 Windows 夜间补测中见到产品终态。GACP-01 协议观察已受限关闭，不再回填 P0-08 的平台矩阵。Windows/Linux 生命周期平台差异仍记在 P0-08，不搬进本目录，也不挡 GACP-02。

### 3.2 明确不要提前做的事

- 不要在 P0-09 测试期间改 `mapGrokSessionUpdate()`、`projectPublicAgentEvent()` 或权限 option 选择。
- 不要为了“ACP 看起来更完整”把 `clientCapabilities.fs/terminal` 设为 true。
- 不要在 GACP-03 之前把 `rawInput.command` 当作 PermissionBroker 目标。
- 不要把 MCP、Skills、浏览器、Computer Use 写进 Grok Adapter 当桌面自己的执行器。
- 不要为 Codex 预留 ACP 方法；Codex 走 app-server，不是 ACP。
- `available_commands_update` 现为 session 快照由 P0-10C 消费，**不得**写进 Timeline。

## 4. 和现有计划的职责切分

| 已有计划 | 继续拥有 | 本目录不抢 |
| --- | --- | --- |
| P0-08 | 单槽 TaskExecutor、退出三选项、平台生命周期 | 只补真实 Grok ACP 观察证据 |
| P0-09 | Timeline reducer、公开事件、结果审阅入口 | 不改事件封套，不把协议原文送 Renderer |
| P0-10 | Project/Task 工作台 UI | 按点进去就能发来做，禁止加回继续按钮 |
| P0-11 | AppCommandRunner 与 CommandExecutionEvidence | GACP-03 负责少打断；P0-11 负责事后证据 |
| P1-05 | Provider 配置、密钥、`GROK_HOME` 隔离复核 | GACP-04 只冻结 ACP 启动方言 |
| P0-15 | 用户交互 PTY | GACP-05 只决定何时广告 `terminal` |
| P3-04 | 通用 Capability MCP Host（非 Grok 会话注入） | Grok 的 `mcpServers` 由 P0-10D 注入；本目录不实现 MCP 进程 |
| P0-10C | 斜杠命令板、插件整页、`available_commands` 快照（代码已落地） | 不把命令写进 Timeline |
| P0-10D | 设置里的记忆浏览与 MCP 配置 | 记忆引擎与 MCP 连接仍由 Grok 执行 |

## 5. 文档索引

| 文件 | 内容 |
| --- | --- |
| [gacp-01-real-grok-protocol-verification.md](gacp-01-real-grok-protocol-verification.md) | 真机协议观察（2026-08-19 受限关闭）；遗留不挡后续 |
| [gacp-02-session-restore-capability-contract.md](gacp-02-session-restore-capability-contract.md) | 点进历史即可接着聊，后台自动恢复 |
| [gacp-03-structured-permission-evidence.md](gacp-03-structured-permission-evidence.md) | 能过的自动过，第一次最多点一次 |
| [gacp-04-grok-acp-dialect-compat.md](gacp-04-grok-acp-dialect-compat.md) | 启动参数、握手、set_model、环境白名单 |
| [gacp-05-client-capability-advertisement.md](gacp-05-client-capability-advertisement.md) | 只有实现后才广告的 Client 能力 |
| [gacp-06-subagent-timeline.md](gacp-06-subagent-timeline.md) | 子 Agent 嵌套卡片；皮肤跟 P0-10A |
| [P0-10A](../p0-10a-claude-desktop-workbench-ui.md) | 整站按 Claude Code Desktop 便捷度大修 |
| [P0-10C](../p0-10c-grok-host-surfaces.md) | Grok 宿主表面：命令板、插件整页 |
| [P0-10D](../p0-10d-grok-memory-and-mcp.md) | 设置：记忆浏览、MCP 交给 Grok |

路线图入口见 [roadmap-index.md](../roadmap-index.md) 的 “Grok ACP 加深” 一节。

## 6. 已确认的产品意向（2026-08-18）

- **对话：** 点一条历史 = 进入这条还能发的对话。不要「只读 + 继续」两步。接不上 Grok 就在同一 Task 里降级，状态条说一声即可。
- **权限：** 不要每个工具点一次。读自动过；项目内写/普通删/命令，本任务点一次后自动过。真正危险的是越出项目、不可逆 Git、未知外网、屏幕/剪贴板/Computer Use。
- **子 Agent：** 分发由 Runtime 做；桌面用 Claude Code Desktop 那种嵌套卡片展示，见 [GACP-06](gacp-06-subagent-timeline.md)。不进侧栏当第二条 Task。
- **整站皮肤：** 当前三栏卡片+日志风时间线要大修，见 [P0-10A](../p0-10a-claude-desktop-workbench-ui.md)。**对话、计划、子 Agent 三件都按 Claude Code Desktop 做在主列一条流里**：对话是字，计划是一张原地打勾的清单，子 Agent 是嵌套任务卡。GACP-06 只负责子 Agent 分组，不另做皮。
- **先不做、以后再加的工作台能力：**
  - 切换模型：输入框已有 `ModelSelector`，空闲时可切；执行中仍禁止。P0-10 / GACP-04 把它收成工作台常驻能力，不另开 ACP 协议计划。
  - 当前上下文：ACP `usage_update` 已映射为实验性事件。P0-09/P0-10 Inspector 显示 used/limit 即可，数据不够就写「未提供」，不要假进度条。
  - 其它（本任务授权一览、手动中断自动过）等 P0-10 工作台稳定后再加，不挡 GACP-02/03。
