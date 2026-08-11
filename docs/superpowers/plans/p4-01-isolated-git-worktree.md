# P4-01 多 Runtime Worktree 与子任务编排 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P4 / 权重 4（多脑对比与接力共用的执行环境编排层）

**目标：** 复用 P0-14 的单 Task Worktree、P2-04A TaskLaunchDecision 和 P2-04B 已接通的 Scheduler，为上层对比/接力请求创建多个独立子 Task、分配环境、提交调度并处理部分失败；本计划不定义比较输入、比较维度、赢家选择或接力包内容。

**核心数据流：** P4-02 或 P4-03 提交主进程已验证的 `RuntimeTaskGroupRequest`，包含 Project、base commit、purpose、幂等键和若干引用 P2-04A decision 的不可变 ChildTaskLaunchSpec；Orchestrator 逐项调用 P0-14 创建 Worktree 和 Task，按 startMode 通过 P2-04B/P0-17 立即入队或停在可信服务可激活的 preparing 状态；GroupStore 只保存环境/子任务关系和操作状态，上层通过 childTaskId 查询各自 Timeline、Changes、Validation、Usage 和 Artifact。

**约束与边界：** 不解释 Prompt 或 HandoffPackage，不决定公平条件、评分维度或谁更好；不聚合/复制子 Task 结果内容，只返回引用与运行状态。不直接调用 `git worktree add/remove`，不对原工作区 reset/stash/clean，不自动合并、提交、推送或批量扩大授权。

**主要风险：** 部分 Worktree 已创建但 Task 创建失败、重复请求创建两组环境、停止一个 group 误杀其它任务，以及恢复时 registry 与真实 Git 状态漂移；使用幂等键、逐子项状态机、严格 ownership、分阶段补偿和从既有服务重建事实。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest。

---

## 实施范围

**前置依赖：**

- 依赖 P0-B 验收门、P2-04B；P2-04B 已依赖 P0-17 和 P2-04A。

**文件范围：**
- 创建 `src/main/agent/runtime-task-group-orchestrator.ts`、`runtime-task-group-store.ts` 及就近测试。
- 创建 `RuntimeTaskGroupRequest`、`ChildTaskLaunchSpec`、`RuntimeTaskGroupSnapshot` 共享 DTO 和固定查询/控制 IPC。
- 复用 P0-14 TaskWorktreeService、P2-04A TaskLaunchService、P2-04B Scheduler/Runtime pool、TaskStore 和 Permission Broker；不创建 comparison result store 或 handoff package store。

**安全策略：**
- 只有 P4-02/P4-03 的可信主进程服务可提交 group request；Renderer 只能提交对应上层已定义的用户选择，不得直接构造任意 ChildTaskLaunchSpec、cwd 或 Runtime 进程数。
- 每个 child 保持独立 taskId、turnId、environmentId、runtimeInstanceId 和权限生命周期；group 级取消逐 Task 调用既有控制接口，不持有批量全局授权。
- Worktree 创建/清理沿用 P0-14 ownership 和 dirty 保护；Scheduler 并发沿用 P0-17 能力/资源门禁。

### 任务 1: 定义 RuntimeTaskGroup 操作契约

**任务目标：**
- 建立不掺杂比较/接力业务语义的环境与子任务状态机。

**涉及范围：**
- Group/Child DTO、store、幂等与状态测试。

**前置依赖：**

- P2-04A 能为每个 child 生成合法、版本化的 TaskLaunchDecision，P2-04B 能消费该 decision 调度 Turn。

- [ ] **第 1 步: 定义 Group 与 Child 状态**
说明：Group 字段包含 groupId、purpose=`comparison|handoff`、requestId/idempotencyKey、projectId、baseCommit、createdAt、requestedChildren、状态和失败摘要；Child 字段包含 childKey、launchDecisionRef、startMode=`immediate|prepared`、taskId、environmentId、allocation/launch/schedule 状态和错误码。
预期：Group 不保存 Prompt 全文、比较维度、HandoffPackage 内容或复制的 Task 历史。

- [ ] **第 2 步: 固定状态机与幂等语义**
说明：Group 状态包含 validating、allocating、ready、scheduling、running、partial、completed、cancelled、error；Child 逐项记录 pending/environment-ready/task-created/preparing/queued/running/terminal/cleanup-pending。相同 idempotencyKey 返回原 group，不重复创建资源。
预期：重试、窗口重复点击和 IPC 重放不会多建 Worktree 或 Task。

- [ ] **第 3 步: 校验编排前提**
说明：验证同一 Project/base commit、child 数量上限、不同 runtime/profile/model 快照、每个 launch decision 未过期、Worktree 可用和资源策略；purpose 专属字段只作为 opaque reference/hash 保存。
预期：非法或过期请求在创建首个 Worktree 前拒绝，上层收到具体可修复原因。

### 任务 2: 编排 Worktree、Task 与 Scheduler

**任务目标：**
- 通过既有服务为每个 child 建立独立执行环境并提交运行。

**涉及范围：**
- orchestrator、TaskWorktreeService、TaskLaunchService、Scheduler 和故障测试。

**前置依赖：**
- 依赖任务 1 的合法 Group request。

- [ ] **第 1 步: 分配独立 environment**
说明：按稳定 child 顺序逐项调用 P0-14，从同一 baseCommit 创建 detached Worktree；记录 environmentId/ownership。任一失败停止继续分配，已创建项进入可补偿清单。
预期：不存在两个 child 写同一 Worktree，原项目工作区不被修改。

- [ ] **第 2 步: 创建不可变子 Task**
说明：环境全部就绪后，使用各自 TaskLaunchDecision 和上层 opaque payloadRef 创建 Task；Task snapshot 固定 Runtime/runtimeBindingSnapshot/model/environment/groupId/purpose，Profile 只在 app-provider 分支存在，不能由 Renderer 二次改写。
预期：比较/接力业务内容由上层服务提供，Orchestrator 只建立身份和引用。

- [ ] **第 3 步: 提交或等待有界调度**
说明：`startMode=immediate` 的 child 向 P0-17 入队，遵守 Runtime 并发证据和资源上限；`startMode=prepared` 的 child 停在 preparing，只有原请求服务提交与 group/child/payload hash 匹配的 `activatePreparedChild` 后才创建 Turn 并入队。Group 取消逐 child 请求 prepared cancel/queued cancel/running stop，不直接杀死共享进程。
预期：Comparison 可直接调度，Handoff 可先物化结果再启动；单个 Runtime 崩溃、等待权限或取消不串扰其它 child。

### 任务 3: 实现补偿、恢复与操作状态查询

**任务目标：**
- 在部分失败、应用重启和用户外部修改时保留可理解、可安全处理的编排事实。

**涉及范围：**
- GroupStore、补偿流程、查询/控制 API、恢复与集成测试。

**前置依赖：**
- 依赖任务 2 的资源分配和任务创建路径。

- [ ] **第 1 步: 实现分阶段失败补偿**
说明：目标 Task 尚未创建时，只有 ownership 匹配且 clean 的新 Worktree 才可经 P0-14 安全清理；dirty/unknown 或 Task 已启动的环境标记 cleanup-pending/retained，由用户处理。任何补偿不修改源 Project 或其它 child。
预期：失败不会留下假 ready 状态，也不会为了“回滚干净”强删未知结果。

- [ ] **第 2 步: 从既有事实恢复 Group**
说明：启动时从 GroupStore、TaskStore、WorktreeRegistry 和 Scheduler 交叉重建 child 状态；缺失、HEAD 漂移、环境 error 和 interrupted Task 显式标记，不复制事件流。
预期：Group 页面/上层服务与单 Task 页面使用同一状态，重启后不虚构仍在运行。

- [ ] **第 3 步: 提供窄操作查询**
说明：API 只提供 create/get/list/cancel/retry-allocation/activate-prepared/request-cleanup 和 child refs；activate 必须由原 requester service 携带预期 payload hash 调用，Renderer 无法直接触发。结果详情由 P4-02/P4-03 按 childTaskId 查询核心服务。retry 只能处理尚未启动且前提仍匹配的 child。
预期：P4-01 没有比较结果、评分、赢家选择或 HandoffPackage 编辑 UI。

- [ ] **第 4 步: 完成部分失败走查**
说明：覆盖第二个 Worktree 创建失败、第二个 Task 创建失败、入队失败、一个 child 等待权限/崩溃/取消、App 重启、外部移除 Worktree 和逐项清理。
预期：每个资源归属、状态和补偿动作可追溯，原项目及成功 child 不受失败 child 影响。

## 验收标准

- [ ] P4-01 只负责环境、子 Task、调度和补偿，不定义比较 Prompt/维度/结果 UI，也不定义 HandoffPackage 内容。
- [ ] 多 Runtime Group 复用 P0-14/P2-04A/P2-04B，不直接重复 Git Worktree、Runtime launch 或 Scheduler 实现。
- [ ] 每个 child 使用独立 Task/Turn/environment/runtime identity；一个 child 失败、等待权限、停止或清理不会污染其它 child。
- [ ] 重复请求幂等；部分失败只清理 ownership 明确且 clean 的未启动环境，dirty/unknown/已启动资源安全保留。
- [ ] `prepared` child 在可信请求服务激活前不会创建 Turn 或入队；Renderer 无法绕过物化/校验步骤直接启动。
- [ ] Group 只返回操作状态与 child 引用，Timeline、Changes、Validation、Usage 和 Artifact 始终来自各 Task 核心事实源。
- [ ] 目标 ESLint、相关 Vitest/集成测试、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过，并完成多阶段失败补偿 Electron 走查。
