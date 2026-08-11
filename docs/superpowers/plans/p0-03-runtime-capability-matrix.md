# P0-03 Runtime 能力矩阵实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0 / 权重 4（防止 UI 过度承诺）

**目标：** 为 Grok Runtime 建立完整、可验证的能力快照，使 Renderer 只开放真实可用的操作，并明确区分“尚未验证”和“明确不支持”。

**核心数据流：** `GrokAgentBridge` 在连接前提供静态能力画像，连接后将 ACP 标准握手字段和真实运行证据归一化为 `AgentRuntimeCapabilitySnapshot`；快照随现有 `AgentRuntimeStatus` 经 `grok:get-status` / `grok:status` 进入 Renderer；Renderer composable 只读取当前快照，统一控制 Prompt、新会话、Plan 和 Tool 的可用状态与说明。

**约束与边界：** 本期只覆盖 Grok Runtime；不新增 `agent:*` IPC，不创建 `AgentRuntimeAdapter`，不持久化快照，不读取 ACP `_meta`，不执行额外版本命令，不实现历史恢复和 Diff/Usage viewer。停止与权限响应属于在途收束动作，不得被能力矩阵禁用。

**主要风险：** `AgentRuntimeStatus`、`disconnect()` 和 `updateStatus()` 位于 HIGH 影响链；通过可选共享字段、主进程统一附加快照、旧连接身份检查、断开/失败恢复静态基线和完整回归测试控制。Runtime 未报告标准版本时保持“未报告”，不得读取私有字段补值。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、Grok Build ACP、GitNexus。

---

## 实施范围

**前置依赖：**
- P0-01 统一 Agent 领域契约与 P0-02 Agent 事件归一化已经完成。

**主要文件：**
- 共享契约与归一化：`src/shared/agent.ts`、`src/main/agent/runtime-capabilities.ts` 及测试。
- Grok 映射与生命周期：`src/main/grok-agent.ts` 及测试。
- Renderer 门禁与会话行为：`src/renderer/src/composables/useRuntimeCapabilities.ts`、`src/renderer/src/runtime-session-actions.ts`、`App.vue`、`WorkspaceSidebar.vue` 及测试。

**固定能力 ID：**
- `runtime.connect`、`session.create`、`session.prompt.text`、`session.cancel`、`session.load`、`session.resume`。
- `event.agent-message`、`event.agent-thought`、`event.plan`、`event.tool`、`event.diff`。
- `permission.request`、`usage.context`、`usage.turn`。

### 任务 1: 建立正交能力契约与完整矩阵

**任务目标：**
- 分离支持程度、成熟度、验证程度和证据来源，保证每个快照覆盖全部固定能力 ID。

**数据规则：**
- `support`: `native | simulated | unsupported | unknown`。
- `maturity`: `stable | experimental`，只允许已支持能力携带。
- `verification`: `unverified | declared | verified`。
- `source`: `static | protocol | runtime | fallback`。
- 缺项和非法组合统一回退为 `unknown + unverified + fallback`；`unsupported` 必须有明确静态或协议负证据。
- simulated、experimental、unsupported 和 unknown 必须有原因；原因先脱敏，再按 UTF-8 512 bytes 安全截断。

- [x] **第 1 步: 扩展共享领域契约**
说明：保留事件使用的 `AgentCapabilityState`；增加固定能力 ID、正交类型、`AgentCapability`、`AgentRuntimeCapabilitySnapshot`，并为 `AgentRuntimeStatus` 增加可选能力快照。

- [x] **第 2 步: 实现完整矩阵构造与单项提升**
说明：新增中性构造和更新函数，补齐全部 ID、拒绝非法证据组合、剥离未知字段并保持可序列化。

- [x] **第 3 步: 验证契约边界**
说明：单测覆盖完整性、非法输入、缺项、原因脱敏/限长、结构化克隆和 JSON 往返。
预期：未知能力不会被误标为不支持，Runtime 原始协议字段不会跨越主进程边界。

### 任务 2: 接入 Grok 握手与运行证据

**任务目标：**
- 在现有 `GrokAgentBridge` 内维护当前连接的能力快照，并复用现有状态通道发布。

**静态基线：**
- native/stable/declared/static：连接、创建会话、文本 Prompt、取消、消息、思考、计划、工具、Diff、权限请求。
- native/experimental/declared/static：Context Usage、Turn Usage。
- unknown/unverified/fallback：加载会话、恢复会话。

- [x] **第 1 步: 投影 ACP 标准握手字段**
说明：保存 `initialize()` 响应，校验协商协议版本；只读取 `protocolVersion`、`agentInfo.version`、`loadSession` 和 `sessionCapabilities.resume`，完全忽略 `_meta`、认证方式和扩展状态。

- [x] **第 2 步: 维护能力快照生命周期**
说明：新连接前恢复静态基线；`newSession()` 成功后验证连接和创建会话；Prompt、取消、事件、权限和 Usage 在真实发生后提升为 runtime verified；ready/busy 保持快照，断开、退出和失败清除握手结果。

- [x] **第 3 步: 验证连接与并发边界**
说明：测试协议不兼容、load/resume 支持与不支持、agentInfo 缺失、敏感 `_meta`、旧连接晚到、Provider 重连、执行状态保持以及断开/失败重置。
预期：不兼容协议不会创建会话，旧 Runtime 声明不会污染新连接或 Renderer。

### 任务 3: 接入 Renderer 门禁与真实会话行为

**任务目标：**
- 所有现有 Runtime 操作以能力快照和真实接线状态为准，杜绝本地 UI 状态伪装成 Runtime 会话行为。

**交互规则：**
- Prompt 发送由 ready、非空文本和 `session.prompt.text` 共同控制；按钮和 Enter 共用同一判断。
- 连接入口负责启动能力发现，不因连接前没有协议快照而死锁。
- Plan/Tool 有数据时始终展示；空态按支持、实验性、未知或不支持给出真实说明。
- 最近会话在 P0-06 前原生禁用并显示原因。
- 新对话在非 busy/connecting 状态下断开并重连；只有新状态为 ready 且带新 `runtimeSessionId` 后才清空旧视图。

- [x] **第 1 步: 实现 composable 与 UI 门禁**
说明：新增 `useRuntimeCapabilities`，接入 Prompt、Plan、Tool、新对话与侧栏；为禁用原因增加可见文字、`aria-describedby`、`aria-label`、`aria-pressed` 和状态提示。

- [x] **第 2 步: 实现并测试真实新会话重建**
说明：抽取可测试的重建函数，覆盖断开后重连、目录取消、连接失败保留旧记录，以及键盘发送不能绕过能力门禁。

- [x] **第 3 步: 完成开发版手工走查**
说明：验证连接前、握手后、执行中、取消后、断开后能力说明；确认新对话产生新的 Runtime session、最近会话不可点击、Plan/Tool 空态和键盘/焦点行为正确。

## 验收标准

- [x] 每个现有可点击 Runtime 操作都可追溯到能力声明或明确的接线状态；未知与不支持原因可见，停止和权限响应不被阻断。
- [x] 能力快照不包含 `_meta`、Secret、模型/设备/实例扩展状态；Runtime 版本仅来自标准 `agentInfo.version`，断开和失败不保留旧握手结果。
- [x] Node.js 20+、pnpm 10.x 下通过目标与完整 ESLint、全部 Vitest、typecheck、build、`git diff --check`、GitNexus `detect_changes()` 和对应 Electron 开发版走查。

## 当前验证证据

- Node.js `v22.22.0`、pnpm `10.33.0`。
- 完整 ESLint 通过；Vitest `12` 个文件、`108` 项测试通过；typecheck、build、`git diff --check` 通过。
- Electron 开发版已完成目录选择、连接、真实 Prompt、执行中门禁、停止收束、真实新会话重建、最近会话禁用、检查器显隐和断开走查。
- GitNexus 最终影响核对命中预期的共享状态、Grok 连接/事件、Renderer 门禁与 UI 流程；未发现 Provider、安全存储或其他无关模块改动。
