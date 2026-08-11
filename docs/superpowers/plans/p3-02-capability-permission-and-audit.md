# P3-02 Capability 执行、权限与审计扩展 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P3 / 权重 5（扩展高权限能力时保持单一权限与审计事实源）

**目标：** 让 Capability Pack 的每个 action 通过同一 CapabilityExecutor 和 P0-07 Permission Broker，并把结果路由到既有 Timeline、Command Evidence、Changes、Validation 与 Artifact 服务；在现有 `permission-audit-store.ts` 上扩展 capabilityId/version/actionId 归属，不创建第二套执行、权限、审计或结果事实源。

**核心数据流：** Capability Registry 返回已启用的不可变 CapabilityDescriptor 与 ActionDescriptor；CapabilityExecutor 将调用绑定 capabilityId、version、manifestHash、actionId、Project、Task、Turn 和 environment，生成标准 OperationIntent；Permission Broker 校验声明、授权与风险后执行；CapabilityResultRouter 按 ActionDescriptor 的 resultKinds 将有限摘要或引用交给既有核心服务，同一 permission audit store 写入版本化、脱敏的来源与结果摘要。

**约束与边界：** 不创建 `src/main/security/audit-store.ts`，不复制授权策略、审批 UI、Timeline、Diff、Validation、Artifact 或审计持久化；Capability 不能借用其它 capability、旧版本、其它 Project/Task/environment 的授权。审计不保存密钥、屏幕原图、剪贴板全文、完整网页响应、命令环境或无限输出；不做云端监控、行为画像或第三方遥测。

**主要风险：** Manifest 声明与实际 action 不一致、升级后沿用旧授权、审计 schema 迁移损坏 P0 历史，以及审计过多变成敏感数据仓库；使用不可变调用身份、版本绑定、原子迁移、字段白名单、容量/保留上限和故障只读降级。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest。

---

## 实施范围

**前置依赖：**
- 依赖 P0-A 验收门、P3-01；其中 P0-07 已提供 Permission Broker 和 `permission-audit-store.ts`。

**文件范围：**
- 创建 `src/main/capability/capability-executor.ts`、`capability-authorization.ts`、`capability-result-router.ts` 及就近测试。
- 修改 `src/main/security/permission-broker.ts`、`permission-audit-store.ts` 及测试；不得新增平行 audit store。
- 扩展 `src/shared/capability.ts`、Permission/Audit DTO、固定查询 IPC 和设置/Task 审计界面。

**安全策略：**
- CapabilityExecutor 只接受 Registry 返回的已验证 descriptor 和 actionId；Renderer/Runtime 不能提交 entry path、任意 executable、IPC channel 或伪造 capabilityId/version。
- OperationIntent 的 origin 固定包含 `originKind=capability`、capabilityId、version、actionId 和 manifestHash；Broker 在每次执行前重新校验启用状态、descriptor revision、ActionDescriptor 的 OperationIntent 模板以及实际目标/参数范围。
- handler 结果必须匹配 ActionDescriptor 的 resultKinds；Command、Changes、Validation 和 Artifact 只能由对应核心服务创建事实并返回引用，Capability 不得提交伪造 evidence/diff/artifact 记录。
- 授权键继续使用 P0-07 的 Task、Project、environment、operation、目标、参数和有效期，并增加 capabilityId/version/actionId；禁用、卸载或版本变化立即使命中失效。
- 审计查询按用户可见摘要返回，限制页大小、文本和时间范围；清除审计只删除记录，不伪称回滚已经发生的副作用。

### 任务 1: 定义 Capability 调用身份与归属契约

**任务目标：**
- 让 Broker 能证明“谁以哪个版本的哪个 action 发起了什么操作”。

**涉及范围：**
- CapabilityInvocation、OperationIntent origin 扩展、Registry 查询和 schema 测试。

**前置依赖：**
- P3-01 已定义 Manifest、版本、不可变 ActionDescriptor、OperationIntent 模板、resultKinds 和 Registry revision。

- [ ] **第 1 步: 定义 CapabilityInvocation**
说明：字段至少包含 invocationId、capabilityId、capabilityVersion、manifestHash、actionId、projectId、taskId、turnId、environmentId、requestedAt 和有限参数摘要；身份字段由主进程生成并不可被 action 改写。
预期：同名 action、不同版本或不同 Task 不会被当作同一调用来源。

- [ ] **第 2 步: 校验 action 与 Manifest 声明**
说明：Registry 返回不可变 ActionDescriptor；CapabilityExecutor 检查 action 存在、Capability 已启用、版本/hash/revision 匹配，并验证实际 operationType、目标类型、风险和 environmentScope 没有超出 OperationIntent 模板；未知或扩大目标在进入 Broker 前拒绝。
预期：Manifest 只声明 read-project 的 action 无法运行 execute-command、network-egress 或任意 IPC。

- [ ] **第 3 步: 扩展授权匹配键**
说明：在 P0-07 现有授权键上增加 capabilityId、version、actionId 和 manifestHash；禁用、卸载、升级、Project/Task/environment 变化或参数越界均不命中旧授权。
预期：插件不能借用其它插件或旧版本的“本 Task 允许”。

### 任务 2: 实现 CapabilityExecutor 与 Broker 闭环

**任务目标：**
- 为 Capability action 提供唯一、受控、可取消的主进程执行入口。

**涉及范围：**
- capability-executor、permission-broker、Capability Registry 和测试。

**前置依赖：**
- 依赖任务 1 的调用身份和归属校验。

- [ ] **第 1 步: 建立 authorize-and-execute 流程**
说明：CapabilityExecutor 根据 ActionDescriptor 构造完整 OperationIntent，将实际执行回调交给 P0-07 `authorizeOperation()`；只有 Broker 允许后才调用 capability handler，不返回可长期缓存的全局布尔权限。
预期：拒绝、取消、超时、Task 终止和 Capability 禁用都在副作用前收束。

- [ ] **第 2 步: 固定 handler 输入输出边界**
说明：handler 只接收 schema 校验、限长且与 invocation 绑定的参数和受限 Host Service；结果使用 P3-01 的 CapabilityActionResult，必须可序列化、限长、脱敏、匹配 resultKinds，并标明 completed/failed/cancelled/unknown。
预期：Capability 不能取得 ipcMain、文件系统根句柄、Provider Key、任意 Shell 或其它 Capability 实例。

- [ ] **第 3 步: 路由结果到既有事实服务**
说明：CapabilityResultRouter 只接受与 invocation、descriptor revision 和 environment 匹配的结果；有限摘要进入 AgentEvent/Timeline，命令只能引用 AppCommandRunner 产生的 CommandExecutionEvidence，文件变化与验证引用 P0-12，Artifact 通过 P0-13 Registry 注册。若所需核心服务尚未完成，该 action 保持 incompatible，而不是本地补一套存储。
预期：用户在同一 Task 时间线和审阅面板查看 Capability 结果，不会出现第二套命令、Diff、Validation 或 Artifact 事实。

- [ ] **第 4 步: 覆盖并发、重复和撤销状态**
说明：测试重复 invocationId、重复审批响应、运行中禁用、Task 取消、版本切换、handler throw/timeout 和进程退出；同一调用只产生一次终态。
预期：失败不会复用授权、重复执行副作用或卡住 TaskExecutor。

### 任务 3: 扩展 P0-07 审计 schema 与存储

**任务目标：**
- 在同一 audit store 中记录 Capability 来源并安全迁移既有 P0 数据。

**涉及范围：**
- `permission-audit-store.ts`、AuditRecord DTO、迁移/损坏配置测试。

**前置依赖：**
- 依赖任务 2 产生的 invocation/decision/outcome 事实。

- [ ] **第 1 步: 定义版本化 AuditRecord 扩展**
说明：保留 P0 字段，并增加 schemaVersion、originKind、capabilityId、capabilityVersion、manifestHash、actionId、invocationId、decisionReason、outcomeCode、redacted/truncated 标志；非 Capability 记录字段为空而不是复制另一类型。
预期：Runtime、App core 和 Capability 操作可在同一时间线查询，来源不会混淆。

- [ ] **第 2 步: 实现原子迁移与故障降级**
说明：旧 schema 迁移使用版本检查、临时文件、fsync/rename 和回滚；未知新版本、损坏记录或磁盘失败时切换只读/不可用状态并阻止需要持久审计的高风险长期授权，不覆盖原文件。
预期：升级不会丢失 P0 审计；失败原因可见且不会默认放行。

- [ ] **第 3 步: 固定容量、保留与清除**
说明：按全局/Project/Task 条数、总字节和保留期淘汰最旧记录，始终保留截断/淘汰计数；支持按 Project/Task/Capability/时间范围清除，清除动作自身写入最小本地管理记录或明确不可追溯边界。
预期：审计不会无界增长，也不会因为清除记录而恢复或撤销已执行操作。

### 任务 4: 实现统一权限与审计界面

**任务目标：**
- 让用户看清来源、决策、授权范围和结果，而不把“有审计”误说成“运行在沙箱”。

**涉及范围：**
- PermissionPrompt、Task Timeline、设置审计页、固定查询/清除 IPC 和组件测试。

**前置依赖：**
- 依赖任务 2、任务 3。

- [ ] **第 1 步: 扩展审批展示**
说明：显示 Capability displayName、id/version、action、Task、目标、影响、风险、授权范围和 Manifest 声明；未知或版本不匹配只允许拒绝/高风险单次处理，不展示长期授权。
预期：用户不会只看到模糊“插件请求权限”，也不会把 action 名称当作实际操作目标。

- [ ] **第 2 步: 实现统一筛选与详情**
说明：在同一审计页按 originKind、Project、Task、Runtime/Capability、operation、decision、outcome 和时间筛选；详情只展示白名单摘要、截断状态和关联 timeline/invocation ID。
预期：不需要打开第二个 Capability 审计页面即可追溯完整路径，Renderer 不能查询原始存储路径或敏感正文。

- [ ] **第 3 步: 完成权限隔离与迁移走查**
说明：覆盖两个 Capability、同 Capability 两版本、同 action 跨 Task/Worktree、禁用/升级、拒绝/超时、审计迁移失败、容量淘汰和用户清除。
预期：授权不串用、记录只有一个事实源，任何失败都不扩大权限。

## 验收标准

- [ ] Capability action 只能由 CapabilityExecutor 以 Registry 验证的 capabilityId/version/actionId 发起，并通过 P0-07 同一 Permission Broker。
- [ ] 授权绑定 Capability 版本、action、Task、Project、environment、目标和参数；禁用、升级或范围变化后旧授权不命中。
- [ ] Capability 结果严格匹配 P3-01 resultKinds，并只路由到既有 Timeline、Command Evidence、Changes、Validation 与 Artifact 服务；缺少对应核心服务时 action 不可用。
- [ ] P3-02 只扩展 `permission-audit-store.ts`，没有第二套 `audit-store.ts`、审批策略或 Renderer 权限事实源。
- [ ] 既有 P0 审计可原子迁移；未知/损坏/写入失败安全降级，不覆盖原数据或默认放行。
- [ ] 审计可按 Capability/Task/Project 筛选和清除，但不包含 Secret、完整敏感正文、屏幕/剪贴板原文或无限输出。
- [ ] 目标 ESLint、相关 Vitest/组件与迁移测试、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过，并完成多 Capability 授权隔离的 Electron 走查。
