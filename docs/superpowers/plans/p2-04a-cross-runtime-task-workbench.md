# P2-04A 单执行槽跨 Runtime 选择与任务启动 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P2 / 权重 4（在成熟单 Runtime 工作台上开放第二个 Runtime）

**目标：** 在 P0-B 的 Project/Task 工作台中增加 Runtime 与模型绑定选择，支持 Grok `app-provider` 和 Codex `account-backed` 基础路径，并在条件满足时开放 Codex `app-provider`；所有组合先由主进程生成不可变 `TaskLaunchDecision`，再使用现有单执行槽 TaskExecutor 启动，不让队列或并行能力反向阻塞第二 Runtime 的基础接入。

**核心数据流：** 新建 Task 前，Renderer 只提交 projectId、runtimeId、binding kind、公开 Profile/model ID、environment choice 和 permission policy ref；TaskLaunchService 查询 Runtime capability、P2-01 账号状态、Provider/Profile 证据、模型状态和 execution environment，返回有版本和过期时间的 decision；Task 创建后保存不可变 runtime binding snapshot，首个 Turn 仍交给 P0-08 单槽 TaskExecutor。运行槽繁忙时返回 busy，不在本计划暗建队列。

**约束与边界：** Runtime、账号认证、App Provider、modelId、Capability、Execution Environment 和权限策略必须分开表达。启动输入使用 `account-backed | app-provider` 判别联合，不能无条件要求 `providerProfileId`。Task 创建后不能切换 Runtime、binding kind 或模型；跨 Runtime 接力属于 P4-03。P0-17、P2-04B、P0-15 和 P0-16 都不是本计划硬依赖。

**主要风险：** 账号模式与 Provider 模式混写、旧 decision 在账号/Provider 变化后仍被使用、Codex custom provider Secret 被工具子进程继承，以及 Renderer 自己拼兼容逻辑；所有判断集中在主进程，decision 带输入 hash/证据/expiry，App Provider Codex 只有在 Secret 隔离可证明时才允许。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest。

---

## 实施范围

**前置依赖：**

- 硬依赖 P0-B 验收门、P2-01 至 P2-03。
- `account-backed` Codex 不依赖 P1-07。
- Codex `app-provider` 是条件分支，另依赖 P1-06、P1-07、P1-08；这些计划未完成时隐藏/禁用该分支，不影响 Grok 与 Codex account-backed。

**文件范围：**

- 创建 `src/main/agent/task-launch-service.ts`、`runtime-binding-resolver.ts`、共享 `TaskLaunchRequest/Decision` DTO 和测试。
- 创建 `RuntimeSelector.vue`、`RuntimeBindingSelector.vue`、Task 创建表单与兼容状态组件；修改 P0-10 工作台和 Task snapshot。
- 修改 Grok/Codex Adapter factory，使其只消费已验证的不可变 runtime binding snapshot。
- 不修改 P0-17 Scheduler，不创建并行 Runtime pool；这些由 P2-04B 负责。

**安全策略：**

- Renderer 只提交公开 ID 和判别联合种类，不读取凭据、构造 Runtime 环境或指定 Codex 配置路径。
- account-backed snapshot 只保存账号状态/模型/能力证据引用，不保存 Token。
- app-provider snapshot 只保存 providerProfileId、origin、protocolKind、modelId 和健康证据，不保存 Key、Header 或解密材料。
- Provider origin、账号状态、协议、模型健康、capability 或 environment 变化后旧 decision 失效，必须重新评估。
- Codex app-provider 若不能证明模型 Secret 不会进入 Runtime 工具、Shell 或用户终端子进程，则返回 blocked，不用“功能先跑起来”绕过密钥边界。

## 已锁定启动契约

- `account-backed`：包含 runtimeId、公开 account revision 和可选 modelId；首期用于 Codex ChatGPT managed account。
- `app-provider`：包含 runtimeId、providerProfileId 和 modelId；用于现有 Grok，也可在条件依赖完成后用于 Codex。
- `TaskLaunchDecision` 包含 decisionId、requestHash、status=`allowed|experimental|blocked`、runtimeBindingSnapshot、capability evidence、environment snapshot、permission policy ref、有限原因、createdAt 和 expiresAt。
- 当前执行槽是否 busy 不写入不可变 decision；busy 是提交 Turn 时的瞬时结果。P2-04B 接入后才允许把有效 Turn 转为 queued。
- 历史 Task 只展示创建时 snapshot；当前设置、账号和 Profile 变化不改写历史事实。

### 任务 1: 定义判别联合与不可变启动快照

**任务目标：**

- 让账号模式和 App Provider 模式拥有互斥、可校验的输入与历史事实。

**涉及范围：**

- 共享 DTO、task launch service、Task snapshot 和契约测试。

**前置依赖：**

- P0-B 已提供 Project、Task、ExecutionEnvironmentRef 和不可变历史边界。

- [ ] **第 1 步: 定义 TaskLaunchRequest**

说明：公共输入只允许 projectId、runtime binding 判别联合、environmentChoice/environmentId 和 permissionPolicyRef；account-backed 不允许 providerProfileId，app-provider 必须提供 providerProfileId/modelId。所有 ID、字符串和 revision 限长。

预期：账号登录、Provider 配置、模型和 Runtime 身份不再塞进同一个可空字段集合。

- [ ] **第 2 步: 定义 TaskLaunchDecision**

说明：主进程生成 decisionId、requestHash、allowed/experimental/blocked、有限原因、证据 refs、expiry 和不可变 snapshot；Renderer 无法提交或改写 decision 内容。

预期：重复评估可幂等返回，过期/不匹配 decision 在 Task 创建前拒绝。

- [ ] **第 3 步: 固定 Task 历史快照**

说明：Task 创建时保存 runtimeId、binding kind、modelId、公开 Profile/账号摘要、capability evidence、environment 和 permission policy ref；Secret、Token 和临时 env 不进入 TaskStore。

预期：历史任务可以准确说明当时用哪个 Runtime、模型、绑定模式和环境执行，不随设置变化漂移。

### 任务 2: 实现 Account 与 App Provider Resolver

**任务目标：**

- 由主进程分别判断两类 binding 的可启动性和 Runtime 配置。

**涉及范围：**

- resolver、P2-01 account state、P1 evidence、Adapter factory 和测试。

**前置依赖：**

- 依赖任务 1 的契约，以及 P2-01/P2-03 的 Runtime 状态和完整操作映射证据。

- [ ] **第 1 步: 实现 Account-backed Resolver**

说明：消费 P2-01 的账号 revision、requiresOpenaiAuth、Runtime capability 和 app-server model list/默认模型事实；首期只允许已验证的 Codex account-backed 组合。

预期：未登录、账号状态过期、模型不可用、协议不兼容或 P2-03 未完成时在 Task 创建前 blocked。

- [ ] **第 2 步: 实现 Grok App-provider Resolver**

说明：消费 Provider Profile、origin、protocol evidence、model health 和 Grok requirement；复核 P1-01 至 P1-05 的 Secret、origin 和 Runtime 配置边界。

预期：现有 Grok 路径迁移到新契约后不回归，基础 Chat 成功不被当作完整 ACP 兼容。

- [ ] **第 3 步: 条件实现 Codex App-provider Resolver**

说明：只有 P1-06/P1-07/P1-08 和 Codex Adapter 均完成后，才将兼容 Profile 转为 App 专属 `CODEX_HOME` 下的短生命周期配置。Key 从 safeStorage 引用解析，不写用户默认配置；必须验证 config/env 和 shell environment policy 能阻止 Secret 进入工具子进程。

预期：无法证明协议或 Secret 隔离时该分支保持 blocked；不影响 account-backed Codex。

- [ ] **第 4 步: 实现 Decision 失效规则**

说明：账号 revision、Provider origin/config revision、protocol/model evidence、binary/schema capability、environment fingerprint 或 permission policy 改变后，旧 decision 标记 stale。

预期：不会用旧 Token 状态、旧 Key origin 或已删除 Worktree 启动 Task。

### 任务 3: 接入单执行槽 Task 创建与运行

**任务目标：**

- 让两种 Runtime 复用同一 TaskExecutor 和工作台，而不提前引入 Scheduler。

**涉及范围：**

- TaskLaunchService、AgentService、Adapter factory、TaskExecutor 和集成测试。

**前置依赖：**

- 依赖任务 2 的有效 decision 与 resolver。

- [ ] **第 1 步: 原子创建 Task**

说明：Handler 校验 decisionId/requestHash/expiry 后创建 TaskRecord 和 runtime binding snapshot；Adapter factory 只能从主进程 snapshot 构造 Runtime，不重新读取 Renderer 表单。

预期：Task 与 Runtime/模型/环境身份一一对应，重复提交不创建两个 Task。

- [ ] **第 2 步: 启动首个 Turn**

说明：首个 Prompt 继续由 AgentService 创建 Turn、TaskExecutor 占用唯一执行槽，再由对应 Adapter 启动；执行槽忙时返回 busy 和当前 Task 摘要，不排队、不替换当前 Runtime。

预期：P2-04A 可以顺序使用 Grok/Codex；并行能力缺失不会阻止第二 Runtime 基础使用。

- [ ] **第 3 步: 复用核心服务**

说明：两种 Runtime 的 Task 使用同一历史、Timeline、Permission、Command Evidence、Changes、Artifact 和 Worktree UI；P0-15 Terminal、P0-16 HTML 若已安装则按 environment/capability 接入，未安装不阻断基础 Task。

预期：Runtime 差异停留在 Adapter、binding resolver 和 capability，不出现第二套专属工作台。

- [ ] **第 4 步: 固定运行中锁定**

说明：活动 Task 的 Runtime、binding、model 和 environment 均只读；设置变化仅影响新 Task。需要换 Runtime 时创建新 Task或走 P4-03 有界接力。

预期：UI 和 IPC 都无法在原 Task 中途静默换脑、切模或换 Key。

### 任务 4: 实现选择 UI 与端到端验收

**任务目标：**

- 让用户清楚选择 Runtime、绑定模式和模型，并得到真实可修复状态。

**涉及范围：**

- Task 创建 UI、选择器、组件测试、Electron 走查和能力文档。

**前置依赖：**

- 依赖任务 1 至任务 3。

- [ ] **第 1 步: 分离选择器职责**

说明：Runtime 独立显示；binding mode 选择 account-backed/app-provider；模型标签只用 `displayName?.trim() || modelId`；只有 app-provider 才展示 Profile 与协议健康。

预期：account-backed 不出现必填 providerProfileId，模型名称不拼接 Grok/Codex 前缀。

- [ ] **第 2 步: 展示状态与修复路径**

说明：显示未安装、未登录、Profile 缺失、协议不匹配、模型未验证、decision stale、Worktree 不可用、experimental 和 busy；UI 只渲染主进程结论。

预期：失败在 Task 创建/Turn 启动前可理解、可修复，不先乐观显示已切换。

- [ ] **第 3 步: 完成合法与非法组合测试**

说明：覆盖 Grok app-provider、Codex account-backed、条件 Codex app-provider、账号退出、Provider origin 变化、模型证据过期、运行中锁定、单槽 busy 和 P0+ 能力缺失。

预期：每条失败都不泄漏 Secret、不改写已有 Task，也不会暗建队列。

- [ ] **第 4 步: 验证历史与真实 Task**

说明：分别完成 Grok/Codex 的真实 Task、第二轮、重启后历史审阅和原生恢复；只把通过完整 Task 流程的组合列为 Agent-compatible。

预期：基础连接、登录或聊天成功只列为较低验证级别，README/能力矩阵不夸大。

## 验收标准

- [ ] TaskLaunchRequest/Decision 使用 account-backed/app-provider 判别联合，不无条件要求 providerProfileId。
- [ ] P2-04A 只依赖 P0-B、P2-01 至 P2-03；P0-17、P2-04B 和 P1 扩展不阻塞 Codex account-backed 基础路径。
- [ ] account-backed Token 与 app-provider Key 所有权分离，TaskStore 不保存 Secret；Codex app-provider 只有在协议和工具子进程 Secret 隔离均可证明时开放。
- [ ] Grok 和 Codex 在同一 Project/Task 工作台顺序启动、运行、审阅和恢复，没有第二套 Runtime 专属工作台。
- [ ] 单执行槽繁忙时明确返回 busy，不暗建队列；Task 启动后 Runtime、binding、model 和 environment snapshot 不可变。
- [ ] Runtime、binding mode、模型、Provider Profile、Capability 和权限策略分开展示，所有兼容结论由主进程生成。
- [ ] 两种 Runtime 共享 Timeline、Permission、Command Evidence、Changes、Artifact 和 Worktree；P0+ Terminal/HTML 保持可选增强。
- [ ] 新增核心函数、binding/Secret 边界、IPC Handler 和异常降级均有中文 TSDoc；测试只使用假凭据和本地 Mock。
- [ ] Node.js 20+、pnpm 10.x 下通过目标/完整 ESLint、相关 Vitest/组件测试、`pnpm typecheck`、`pnpm build` 与 `git diff --check`，并完成两 Runtime 单槽真实 Task 走查。
