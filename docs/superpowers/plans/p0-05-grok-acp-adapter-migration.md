# P0-05 Grok ACP Adapter 与任务编排边界 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0-A / 权重 5（保住现有闭环并建立 Codex-style 任务语义）

**目标：** 把 `GrokAgentBridge` 迁移为只负责 ACP 生命周期和协议转换的 `GrokAcpAdapter`，由 `AgentService` 创建并持有产品 `taskId`、`turnId` 与单 Runtime 执行状态，使同一个 Task 可以连续执行多个 Turn。

**核心数据流：** Renderer 通过固定 Agent IPC 创建 Task 并启动 Turn；`AgentService` 创建产品 ID、维护 `taskId → RuntimeSessionRef` 注册表并选择当前 Task；执行控制器占用唯一 Turn 槽；Grok Adapter 根据已验证能力创建/加载 session、发送 ACP 请求并映射事件，所有事件沿用服务分配的 `taskId` / `turnId` 返回 Renderer。

**约束与边界：** 本期只有一个 Grok Runtime、一个执行槽和内存态 Task；不实现历史持久化、后台队列、并行 Runtime、Runtime 注册中心或第二套 Adapter。P0-04 的窄 IPC、安全校验和 Provider 边界必须保持不回退。

**主要风险：** 当前 `GrokAgentBridge.sendPrompt()` 每次自行生成产品 ID，且 Bridge 只持有一个 `sessionId`；迁移会同时触及连接、Task 切换、事件、取消和权限关联。编码前必须对目标符号运行 GitNexus upstream impact；按 HIGH 跨进程回归风险保护 Task A → Task B → Task A、同 Task 第二轮、取消、权限、断开和 Provider 重连。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、Grok Build ACP。

---

## 实施范围

**前置依赖：**
- 依赖 P0-01 至 P0-04 全部完成。

**文件范围：**
- 创建 `src/main/agent/agent-runtime-adapter.ts`、`src/main/agent/agent-service.ts`、`task-execution-controller.ts` 及就近测试。
- 创建 `src/main/runtime/grok/grok-acp-adapter.ts` 及就近测试。
- 修改 `src/main/index.ts`、`src/main/agent/ipc.ts`、`src/shared/agent.ts`、`src/shared/agent-ipc.ts`、Preload 窄 API 和 Renderer 新任务入口。
- 在全部调用和测试迁移完成后删除 `src/main/grok-agent.ts`；不得保留两套活动状态源。

**安全策略：**
- Renderer 只提交项目引用、`taskId` 和 Prompt；不得提交 `runtimeSessionId`、任意 channel、文件系统路径扩权参数或 Provider Secret。
- `AgentService` 在调用 Adapter 前重新校验 Task、当前项目、活动 Turn 和字符串大小；Adapter 的原始 ACP 错误、stderr 与事件继续统一脱敏。
- Provider Key 仍只在主进程构造的 Runtime 环境中使用，并继续从 Agent 工具子进程环境中剥离。

## 已锁定产品语义

- `Task` 是用户可见的长期目标或对话；同一个 Task 可以包含多个 Turn。
- `Turn` 是一次 Prompt 对应的完整执行；同一时间首版只允许一个活动 Turn。
- `runtimeSessionId` 是 Task 的内部 Grok session 引用，不作为 Renderer 创建 Task 的依据。
- 新建 Task 才创建新的 Grok session；在同一 Task 内发送下一轮 Prompt 必须复用该 Task 绑定的 session。
- `AgentService` 保存 Task 与 Runtime session 的绑定；切换 Task 时由 Adapter 使用已验证的 `loadSession` / `resume` 能力恢复目标 session，能力不可用时明确阻断继续而不是复用错误上下文。
- `taskId`、`turnId` 只能由 `AgentService` 生成；Adapter 不得自行生成产品 ID。
- `AgentService` 是身份、session 绑定和查询门面；活动执行槽由 `TaskExecutionController` 持有，P0-08 将在不改变门面契约的情况下把它实现为后台 `TaskExecutor`。
- P0-02 已完成的“一次 Prompt 一组有界事件”保持成立，但事件中的 `taskId` 改为稳定 Task ID，`turnId` 每轮更新。

### 任务 1: 冻结迁移前行为与影响范围

**任务目标：**
- 建立可重复的迁移基线，并明确所有直接依赖当前 Bridge 状态的调用方。

**涉及范围：**
- `GrokAgentBridge.sendPrompt`、`cancel`、`connect`、`disconnect`、权限响应、事件发布和主进程组装。

**前置依赖：**
- P0-04 完整验证已结束，工作区不存在未收束的 IPC 双链路。

- [ ] **第 1 步: 运行影响分析并记录爆炸半径**
说明：对 `GrokAgentBridge`、`sendPrompt`、`cancel`、`registerIpcHandlers` 和 Renderer 新任务入口运行 GitNexus upstream impact，记录直接调用方、受影响执行流和风险等级；HIGH 或 CRITICAL 必须先向用户说明再编码。
预期：迁移文件清单和回归路径与真实调用图一致，不遗漏 Provider 切模重连或事件订阅。

- [ ] **第 2 步: 固定现有可观察行为测试**
说明：补齐或复用受控 ACP mock，覆盖连接、首轮 Prompt、第二轮 Prompt、权限、取消、断开、Runtime 异常和 Provider 重连。
预期：迁移前基线全部通过，失败用例能稳定复现旧行为而不依赖真实付费模型。

- [ ] **第 3 步: 确认 P0-04 边界未回退**
说明：检查 Renderer 仍只使用 `window.agent` / `window.app` / `window.provider`，不存在 `window.grok`、`grok:*`、通用 invoke 或 Renderer 直接 Runtime 操作。
预期：P0-05 只改变主进程编排和必要的静态 Agent DTO，不重新打开宽 IPC。

### 任务 2: 建立最小 AgentRuntimeAdapter 契约

**任务目标：**
- 定义仅覆盖当前已验证 Grok 能力的 Adapter 契约，不为尚未接入的 Runtime 猜测庞大接口。

**涉及范围：**
- `src/main/agent/agent-runtime-adapter.ts`、`src/shared/agent.ts`、Adapter contract 测试。

**前置依赖：**
- 依赖任务 1 的行为清单和影响结论。

- [ ] **第 1 步: 定义运行上下文与最小方法**
说明：契约只包含连接/断开、创建/加载/关闭 Runtime session、启动 Turn、取消活动 Turn、响应权限和读取能力快照；`startTurn` 必须接收服务层提供的 `taskId`、`turnId`、项目根和 Prompt。`loadSession` / `resume` 只有在握手能力和本机实测同时支持时开放。
预期：接口中不出现 Vue 状态、Provider UI 文案、任意 ACP 原对象或第二 Runtime 专属字段。

- [ ] **第 2 步: 定义事件和错误出口**
说明：Adapter 只能通过注入的中性事件 sink 发布 `AgentEvent`、状态和权限请求；错误先转为有限错误码和脱敏文案。
预期：Adapter 无法绕过 normalizer 直接向 Renderer 发送 ACP payload。

- [ ] **第 3 步: 验证契约没有过度泛化**
说明：逐项对照 P0-03 能力矩阵，未验证的 fork、search、resume、parallel、usage 或 native diff 只通过能力状态表达，不加入必实现方法。
预期：Grok 是唯一实现时接口仍足够小，未来 Codex Adapter 可扩展而不要求当前伪实现。

### 任务 3: 实现 AgentService 的 Task / Turn 所有权

**任务目标：**
- 将产品任务编排从 Runtime Bridge 收回主进程服务层。

**涉及范围：**
- `src/main/agent/agent-service.ts`、Agent IPC DTO、Preload API、Renderer 最小新 Task/发送入口及测试。

**前置依赖：**
- 依赖任务 2 的 Adapter 契约。

- [ ] **第 1 步: 实现内存 Task 状态机**
说明：服务维护 `taskId`、项目根、runtimeId 和 RuntimeSessionRef 注册表；新建 Task 分配稳定 `taskId` 并创建 session，每次 `startTurn` 只分配新的 `turnId`，切回旧 Task 时先加载其绑定 session。
预期：同一 Task 连续两个 Turn 的 `taskId` 相同、`turnId` 不同；新 Task 使用新的 Grok session；Task A → Task B → Task A 后 A 的第二轮继续 A 的原上下文。

- [ ] **第 2 步: 收口并发和收束动作**
说明：`TaskExecutionController` 首版只有一个活动 Turn；重复启动返回 `invalid-state`，取消、断开和权限响应保持可在收束阶段调用且幂等。AgentService 只通过该接口编排，不直接暴露或复制活动槽状态。
预期：活动 Turn 不会因 Renderer 重渲染或重复点击产生第二次 Prompt；终态后旧事件不能覆盖新状态。

- [ ] **第 3 步: 更新静态 Agent IPC**
说明：新增或调整固定 `createTask`、`startTurn`、`cancelTurn`、`getTaskRuntimeState` 方法，主进程拒绝未知 Task、跨项目 Task 和 Renderer 伪造的 Runtime session。
预期：所有请求均通过 P0-04 来源、形状、UTF-8 限长和脱敏错误封套。

### 任务 4: 迁移 Grok Adapter 并完成回归

**任务目标：**
- 删除 Bridge 对产品 ID 和 UI 状态的所有权，同时保持当前 Grok Runtime 行为不回归。

**涉及范围：**
- `src/main/runtime/grok/grok-acp-adapter.ts`、`src/main/index.ts`、旧 Bridge 删除和完整测试。

**前置依赖：**
- 依赖任务 3 的 AgentService。

- [ ] **第 1 步: 移动 ACP 生命周期与映射逻辑**
说明：将连接、session、Prompt、取消、权限和 Grok 事件映射迁入 `GrokAcpAdapter`；normalizer 使用服务传入的 Task / Turn 上下文。
预期：Grok 专属类型、`GROK_HOME`、ACP schema 和错误只存在于 Grok Runtime 目录。

- [ ] **第 2 步: 原子切换主进程组装**
说明：`src/main/index.ts` 只创建 AgentService、TaskExecutionController、Grok Adapter、Provider 服务并注册 IPC；删除旧 Bridge 注册和双事件出口。
预期：产品身份/session 绑定只有 AgentService 一份，活动执行槽只有 Controller 一份，权限请求只有 Broker/Adapter 映射链一份。

- [ ] **第 3 步: 完成自动与开发版验证**
说明：验证连接、Task A 第一轮、新建 Task B、切回 Task A 继续第二轮、真实新 Task、计划/工具/权限事件、取消、失败收束、断开、Provider 切模重连和应用关闭。
预期：用户可见行为不回归，且事件 ID 明确证明 Task / Turn 语义已经升级。

## 验收标准

- [ ] `AgentService` 是 `taskId`、`turnId` 和 RuntimeSessionRef 绑定的唯一所有者；`TaskExecutionController` 是活动 Turn 槽的唯一所有者；`GrokAcpAdapter` 不生成产品 ID。
- [ ] 同一 Task 连续两个 Turn 复用同一 Grok session；Task A → Task B → Task A 可以恢复 A 的原上下文；首版第二个并发 Turn 被主进程明确拒绝。
- [ ] Renderer、共享通用层和 Provider 层不出现 ACP 原始字段或 Grok 专属 UI 语义；旧 `GrokAgentBridge` 和双状态源已删除。
- [ ] 相关核心函数、IPC Handler、环境构造和异常降级均有中文 TSDoc，测试只使用假凭据和本地 Mock。
- [ ] Node.js 20+、pnpm 10.x 下通过目标 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build`、`git diff --check`，并完成对应 Electron 开发版走查。
- [ ] 运行 `detect_changes({ scope: "all" })`，受影响符号和执行流只覆盖预期的 Agent IPC、Runtime 编排、事件与 Renderer 新任务路径。
