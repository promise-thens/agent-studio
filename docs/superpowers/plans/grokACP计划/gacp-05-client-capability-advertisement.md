# GACP-05 Client 能力广告

> **致执行者：** 这是最晚、也最容易做错的一项。只有产品真的实现了对应 Client 方法之后，才允许改 `initialize.clientCapabilities`。P0-A / P0-B 都不依赖本计划。
>
> **状态：** 待开始（前置：P0-15 完成且产品确认要做 Client 托管 I/O；MCP 另走 P3-04）
>
> **插入点：** P0-15 之后；默认不进入 P0-A 开发序列

**优先级：** P0+ / 权重 3（完整 ACP 宿主能力，不是当前 Grok 闭环的阻塞项）

**目标：** 给 Agent Studio 一条合法的 ACP Client 能力广告规则：实现了什么就声明什么，没实现就保持 `{}`。避免“为了看起来像 Zed”提前打开 `fs` / `terminal`，导致 Grok 开始回调桌面端并不存在的方法。

**核心数据流：**

```text
产品确认要做的 Client 能力
  → 主进程真实 handler（fs/read_text_file 等）
  → 方言模块里的 ClientCapabilities 构造器
  → initialize() 广告
  → Grok 才被允许调用对应方法
  → 每次调用仍进 PermissionBroker
```

**约束与边界：**

- **当前正确状态就是 `clientCapabilities: {}`。** 见 `GrokAcpAdapter.initializeConnection()`。Grok 作为 Agent 自己读文件、跑命令，并不需要 Client 文件系统才能工作。
- ACP 规范：Agent **MUST NOT** 在 Client 未广告时调用 `fs/*` 或 `terminal/*`。提前广告却没有 handler，属于协议违规。
- 本计划不实现 MCP。`mcpServers: []` 的解除权在 P3-04。
- 本计划不实现 elicitation、NES、plan_update 广告。
- 即使用户交互终端（P0-15）已经存在，也不自动等于 ACP `terminal/*`。P0-15 是用户自己的 PTY；ACP terminal 是 Agent 向 Client 申请托管命令。两者默认隔离。

**主要风险：**

- 把 P0-15 终端“复用”成 ACP terminal，会让 Agent 往用户 PTY 里写命令，绕过 P0-11 证据和 P0-07 审批。
- 实现 `fs/read_text_file` 后，Grok 可能读取未保存缓冲或 execution root 以外的路径；必须按 Task environment 再校验。
- 广告 `fs.writeTextFile` 等于把文件写入从“Grok 自己写磁盘”变成“桌面端代写”，权限模型和 Changes 归因都要重做。

**技术栈：** Electron 39、TypeScript、`@agentclientprotocol/sdk` 1.3.x、Vitest；实现阶段才引入具体 fs/terminal handler。

---

## 实施范围

**前置依赖：**

- P0-A 已通过（至少 GACP-01、P0-10、P0-11 完成），否则不要扩 Client 面。
- 若广告 `terminal: true`：P0-15 已完成，并且单独设计了 **Agent 专用** 终端会话，不是用户 PTY。
- 若广告 `fs.readTextFile` / `fs.writeTextFile`：必须先有 Task execution root 校验和 PermissionBroker 操作类型。
- MCP 注入明确排除，见 P3-04。

**文件范围（只有开工后才创建）：**

- `src/main/runtime/grok/grok-acp-client-handlers.ts`
- `src/main/runtime/grok/grok-acp-dialect.ts` 中的 ClientCapabilities 工厂
- Adapter 的 `ClientSideConnection` 回调从只实现 `requestPermission` + `sessionUpdate` 扩展到 fs/terminal
- 对应测试与权限审计
- **现在禁止改** `clientCapabilities: {}`

**安全策略：**

- 每个 Agent→Client 请求都是一次 `OperationIntent`，initiator 为 `{ kind: 'runtime', runtimeId: 'grok' }`。
- path 必须落在当前 Task `environment.rootSnapshot`（或未来 Worktree root）内。
- write/execute 默认至少 L1/L2，delete/write 越界直接拒绝。
- handler 返回给 Agent 的文件内容和终端输出要限长、脱敏；不得把 Provider Key 读回给 Agent。
- 不实现“读取用户未保存的任意编辑器缓冲”，除非产品以后真有编辑器并且用户明确授权。

## 何时应该做 / 何时不该做

| 想法 | 结论 |
| --- | --- |
| 想让 Grok 现在就能改代码 | 不需要本计划。Grok 已经用自己的工具改磁盘，桌面端靠 permission + Timeline |
| 想显示未保存缓冲给 Agent | 需要本计划的 `fs.readTextFile`，且先有编辑器 |
| 想让 Agent 命令出现在工作台终端里 | 需要独立 ACP terminal 会话 + P0-11 证据，不能复用 P0-15 用户 PTY |
| 想接 MCP | 走 P3-04，把 server 配进 `session/new` 的 `mcpServers`，不是本计划 |
| 只是觉得 Client 能力为空不完整 | **不要做**。空广告是诚实 |

开工前必须先写一页产品确认：要广告哪些 key、对应哪个用户可见能力、权限文案是什么。没有确认不得改 initialize。

---

## 任务 1: 建立能力广告工厂（设计冻结，默认仍返回空）

**任务目标：** 即使还没实现 handler，也先规定“只有工厂说能广告才能广告”。

**涉及范围：** dialect 模块、单测。

- [ ] **第 1 步: 明确默认输出**
      说明：`buildGrokClientCapabilities()` 在没有任何 handler 注册时必须返回 `{}` 或等价空对象。Adapter 继续把这个对象传给 `initialize`。
      预期：现在行为零变化。

- [ ] **第 2 步: 注册表与广告的双检查**
      说明：广告 `fs.readTextFile: true` 的前提是 handler map 里真有 `readTextFile`。缺一不可。测试覆盖“只改广告不改 handler 会在启动时失败关闭”。
      预期：无法再出现半开 Client。

- [ ] **第 3 步: 与 P0-03 能力矩阵分开**
      说明：P0-03 描述的是 **Agent** 能力（Grok 会不会 load/resume）。Client 能力是另一张表，不得塞进 `AGENT_CAPABILITY_IDS` 冒充 Runtime 能力。
      预期：Renderer 不会把“桌面端能代读文件”显示成“Grok 支持 session.load”。

## 任务 2: fs 方法（仅产品确认后）

**任务目标：** 若确认要做编辑器协同，再实现读/写文本文件。

- [ ] **第 1 步: read_text_file**
      说明：校验 session 属于当前 Task，path 在 execution root 内，限大小。读磁盘（或未来编辑器缓冲）。进入 Audit。
      预期：越界路径拒绝；Agent 拿不到 root 以外文件。

- [ ] **第 2 步: write_text_file**
      说明：默认走 PermissionBroker `write-file`。写入后的事实交给未来 P0-12 Changes，不在 handler 里偷偷 git add。
      预期：拒绝批准则 ACP 返回错误，磁盘不变。

- [ ] **第 3 步: 广告**
      说明：两个 handler 都有测试后，才把对应布尔设 true。可以先只广告 read。
      预期：initialize 广告与 handler 一致。

## 任务 3: terminal 方法（仅产品确认后）

**任务目标：** 给 Agent 一个受管、非用户 PTY 的命令会话。

- [ ] **第 1 步: 与 P0-15 隔离**
      说明：ACP terminalId 不得指向用户交互终端。环境继续剥离模型 Key。
      预期：用户在自己的 Shell 里看不到 Agent 被注入的命令。

- [ ] **第 2 步: create / output / wait / kill / release**
      说明：按 ACP schema 实现最小集。输出进 P0-11 evidence，source 标 `runtime-tool` 或新的 `acp-terminal`，不要标 `user-terminal`。
      预期：取消 Turn 时对应 terminal 被 kill/release。

- [ ] **第 3 步: 广告 `terminal: true`**
      说明：五类方法齐了才能广告。缺 wait/kill 禁止广告。
      预期：规范要求的 all-or-nothing 得到遵守。

---

## 验收标准

- [ ] 在产品确认前，`clientCapabilities` 仍为空，现有 Grok 闭环回归全绿。
- [ ] 一旦广告某项能力，对应 handler、权限、测试同时存在；缺 handler 时应用拒绝启动或拒绝连接。
- [ ] ACP terminal 与 P0-15 用户终端身份隔离。
- [ ] MCP 仍不在本计划范围。
- [ ] 相关测试、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过。

## 非目标

- 不把 Agent Studio 做成通用 ACP Client SDK。
- 不广告 image/audio prompt、elicitation、NES。
- 不读取用户 Chrome / 系统剪贴板 / 屏幕，那些是 P3。
- 不因为“完整 ACP”改变当前 Grok 自己执行工具的模式。
