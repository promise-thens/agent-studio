# P0-01 统一 Agent 领域契约 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0 / 权重 5（全部 Runtime 的阻塞性基础）

**目标：** 定义 Runtime、Task、Session、Turn、Event、Permission、Diff 与 Usage 的可序列化中性类型，消除共享层对 Grok 的命名依赖。

**核心数据流：** Renderer 只消费 shared 中的 Agent 摘要和事件；主进程把 Adapter 输出转换为领域类型；Adapter 保留协议原始字段在私有实现层，不泄漏到共享层。

**约束与边界：** 只定义稳定语义和序列化边界，不建立抽象工厂或多 Runtime 注册框架；原始协议载荷不得进入历史、日志或 Renderer。

**主要风险：** 若字段过于贴合 ACP，Codex 接入会再次分叉；以“能被两个 Runtime 消费的最小字段”为准，并为不对称能力保留 capability 标记。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；需要 Runtime 协议时以当期官方 schema 与本机实测为准。

---

## 实施范围

**前置依赖：**
- 无；必须先于中性 IPC、事件归一化和第二个 Runtime。

**文件范围：**
- `src/shared/agent.ts`、`src/shared/agent.test.ts`、`src/main/grok-agent.ts`、`src/main/grok-agent.test.ts`；渐进修改 `src/shared/grok.ts`、Preload 和 Renderer 的类型引用，不在本计划改名 `grok:*` IPC。

**安全策略：**
- 安全是与操作风险匹配的护栏：低风险只读操作可在任务范围授权；写入与命令需展示目标和影响；删除、外发数据、登录态、屏幕和剪贴板始终显式确认。
- Renderer 不接触密钥、任意 IPC、文件系统或子进程；所有跨进程数据须可序列化、限长并脱敏。

### 任务 1: 盘点现有 Grok 共享类型

**任务目标：**
- 列出 `src/shared/grok.ts` 中状态、事件、权限、会话字段，逐项标记为中性语义、Grok 专属或未确认。

**涉及范围：**
- `src/shared/agent.ts`、`src/shared/agent.test.ts`、`src/main/grok-agent.ts`、`src/main/grok-agent.test.ts`；渐进修改 `src/shared/grok.ts`、Preload 和 Renderer 的类型引用，不在本计划改名 `grok:*` IPC。

**前置依赖：**
- 无；必须先于中性 IPC、事件归一化和第二个 Runtime。

- [x] **第 1 步: 落地本任务**
说明：列出 `src/shared/grok.ts` 中状态、事件、权限、会话字段，逐项标记为中性语义、Grok 专属或未确认。

- [x] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [x] **第 3 步: 边界与风险检查**
说明：检查 只定义稳定语义和序列化边界，不建立抽象工厂或多 Runtime 注册框架；原始协议载荷不得进入历史、日志或 Renderer。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 2: 建立最小中性契约

**任务目标：**
- 创建 `AgentRuntimeId`、`AgentTaskSummary`、`AgentEvent`、`AgentPermissionRequest`、`AgentCapabilityState` 等可序列化类型；每个安全和状态边界写中文 TSDoc。

**涉及范围：**
- `src/shared/agent.ts`、`src/shared/agent.test.ts`、`src/main/grok-agent.ts`、`src/main/grok-agent.test.ts`；渐进修改 `src/shared/grok.ts`、Preload 和 Renderer 的类型引用，不在本计划改名 `grok:*` IPC。

**前置依赖：**
- 依赖本计划任务 1 的可验证输出。

- [x] **第 1 步: 落地本任务**
说明：创建 `AgentRuntimeId`、`AgentTaskSummary`、`AgentEvent`、`AgentPermissionRequest`、`AgentCapabilityState` 等可序列化类型；每个安全和状态边界写中文 TSDoc。

- [x] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [x] **第 3 步: 边界与风险检查**
说明：检查 只定义稳定语义和序列化边界，不建立抽象工厂或多 Runtime 注册框架；原始协议载荷不得进入历史、日志或 Renderer。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 3: 渐进式替换与测试

**任务目标：**
- 让现有 Grok 适配输出可映射到新类型，编写序列化与不支持能力的单元测试，不删除旧类型直到所有调用点迁移。

**涉及范围：**
- `src/shared/agent.ts`、`src/shared/agent.test.ts`、`src/main/grok-agent.ts`、`src/main/grok-agent.test.ts`；渐进修改 `src/shared/grok.ts`、Preload 和 Renderer 的类型引用，不在本计划改名 `grok:*` IPC。

**前置依赖：**
- 依赖本计划任务 2 的可验证输出。

- [x] **第 1 步: 落地本任务**
说明：让现有 Grok 适配输出可映射到新类型，编写序列化与不支持能力的单元测试，不删除旧类型直到所有调用点迁移。

- [x] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [x] **第 3 步: 边界与风险检查**
说明：检查 只定义稳定语义和序列化边界，不建立抽象工厂或多 Runtime 注册框架；原始协议载荷不得进入历史、日志或 Renderer。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

## 验收标准

- [x] 共享层不导入 Electron、Node 或 ACP；Grok 当前事件能无损映射为中性事件；未支持能力明确为 `unsupported`，而不是伪造空结果。
- [x] 相关新增核心函数、IPC Handler、密钥/权限边界均有中文注释，且新增测试只使用假凭据和本地 Mock。
- [x] 目标文件 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 在 Node.js 20+、pnpm 10.x 下完成；UI/Electron 改动另有对应开发版手工走查记录。

## 实施记录

### 现有 Grok 共享字段盘点

| 现有字段或类型 | 分类 | 本次处理 |
|---|---|---|
| `GrokConnectionState` | 中性语义 | 迁移为 `AgentRuntimeState`，保留 deprecated 别名 |
| `GrokStatus.state/message/workspace` | 中性语义 | 迁移为 `AgentRuntimeStatus`，补充独立 `runtimeId` |
| `GrokStatus.sessionId` | Grok Runtime 专属标识 | 改为中性字段 `runtimeSessionId` |
| 消息、思考、工具、计划、Usage、Turn 完成事件 | 中性语义 | 建立严格的 `AgentEvent` 判别联合并逐字段映射 |
| `payload?: unknown`、`raw`、`stderr` 事件 | Grok/ACP 私有或未声明语义 | 从共享契约移除，不再进入 Renderer |
| Permission 的 `id/title/options` | 中性语义 | 迁移为 `AgentPermissionRequest`，逐字段剥离 `_meta` |
| ACP 非文本消息、未知 update、实验性 plan update | 未确认 | 保留在 Adapter 私有边界，不伪造展示结果；由 P0-02 统一降级 |
| `GrokDesktopApi` 与 `grok:*` channel | Grok 迁移期兼容边界 | 本次保留，统一 IPC 改名由 P0-04 完成 |

### 已完成实现

- 新增 Runtime、Task、Session、Turn、Event、Permission、Diff、Usage 和 Capability 中性类型。
- Grok Adapter 显式映射消息、思考、工具、Diff、计划、Usage、权限与 Turn 终态；协议 `_meta`、`rawInput`、`rawOutput` 和未知原始对象不跨越主进程。
- Renderer 与 Preload 改为消费中性 Agent 类型；`window.grok` 和 `grok:*` channel 保持兼容。
- `src/shared/grok.ts` 只保留 deprecated 类型别名和迁移期桌面 API。

### 验证证据

- 环境：Node.js `v22.22.0`、pnpm `10.33.0`。
- 目标 ESLint：通过，无 warning。
- 目标 Vitest：`2` 个文件、`13` 个测试通过。
- 全量 ESLint：通过；全量 Vitest：`7` 个文件、`57` 个测试通过。
- `pnpm typecheck`、`pnpm build`、`git diff --check`：通过。
- 开发版手工走查：应用启动、Runtime 状态监听、检查器开关、Provider 设置页进入与返回均正常；未调用真实付费模型。

### 后续边界

- taskId、sequence、时间戳、乱序/重复处理和超大事件限制由 P0-02 统一实现。
- `window.agent`、`agent:*` channel、IPC 参数限长与集中注册由 P0-04 实现。
- `GrokAgentBridge` 的 Runtime Adapter 目录迁移由 P0-05 实现。
