# P2-04B 跨 Runtime Scheduler 与并行整合 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P2 / 权重 4（把第二 Runtime 接入既有队列与有界并行）

**目标：** 将 P2-04A 已创建的不可变 runtime binding snapshot 接入 P0-17 Scheduler，使 Grok 与 Codex Task 可以统一排队，并且只有 Execution Environment、Runtime 并发证据和资源上限全部满足时才并行运行。

**核心数据流：** P2-04A 创建 Task 与 Turn 后，把 taskId、turnId、environmentId、launchDecisionRef/hash 和公开 binding fingerprint 交给 P0-17；Scheduler 在分配槽前重新验证 decision、账号/Provider 状态、environment 和 capability，通过 RuntimeInstanceFactory 创建对应 Adapter 实例；事件、权限和命令证据按 Task/Turn 路由，用户终端按 Task/Environment/Terminal 路由；终态、取消或崩溃只释放对应槽。

**约束与边界：** 本计划不重新定义 Runtime/模型选择器、Provider 协议、TaskLaunchDecision、通用队列状态或 Worktree 创建；这些分别由 P2-04A、P1、P0-17 和 P0-14 负责。不假设所有 Runtime 能多实例或共享进程；没有实测证据时退化为单槽。重启后不重放旧 Prompt、命令或登录副作用。

**主要风险：** 队列中的 decision 在真正运行前过期、不同槽共享账号/Key 明文环境、一个 Runtime 崩溃污染其它 Task，以及多 Runtime 分支复制 Scheduler；使用运行前二次校验、slot ownership、最小环境、统一 factory 和 P0-17 的 interrupted 恢复规则规避。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest。

---

## 实施范围

**前置依赖：**

- 依赖 P0-17、P2-04A。
- P0-15 Terminal 和 P0-16 HTML Preview 仍是可选增强，不是本计划硬依赖。

**文件范围：**

- 扩展 `src/main/agent/runtime-instance-pool.ts`、`task-scheduler.ts` 和 RuntimeInstanceFactory。
- 创建 `src/main/agent/runtime-launch-revalidator.ts` 及就近测试。
- 修改 Scheduler 队列 DTO、全局运行中心和 Task 状态展示。
- 复用 P2-04A TaskLaunchService/Decision、P2-01 Codex Supervisor、Grok Adapter factory 和 P0-17 冲突/资源策略。

**安全策略：**

- 队列项只保存公开身份、decision 引用/hash 和阻塞原因，不复制 Token、Key、Header、完整 Provider 配置或 Prompt payload。
- 每个运行槽拥有独立 runtimeInstanceId、Adapter/connection/session 和权限生命周期；停止、崩溃和授权不跨槽。
- Account token 继续只由 Codex app-server 管理；App Provider Key 只在主进程从 safeStorage 引用解析，并且不得进入工具子进程、用户终端或其它槽。
- 配置、账号、origin、environment 或 capability 漂移后进入 blocked/reconfirm-required，不静默使用旧 Secret 或旧 decision。

### 任务 1: 扩展 RuntimeInstanceFactory 与实例所有权

**任务目标：**

- 让 P0-17 可以按不可变 binding snapshot 创建正确且相互隔离的 Runtime 实例。

**涉及范围：**

- instance pool、factory、Adapter 生命周期、能力证据和测试。

**前置依赖：**

- P2-04A 已提供合法 TaskLaunchDecision 与 runtime binding snapshot。

- [ ] **第 1 步: 定义 RuntimeInstanceRequest**

说明：内部请求只引用 taskId、turnId、environmentId、runtimeId、binding kind、modelId、launchDecisionRef/hash 和 capability evidence；Profile 只在 app-provider 分支存在。

预期：Scheduler 不接触 Renderer 表单、明文凭据或 Runtime 私有配置。

- [ ] **第 2 步: 实现统一 Adapter Factory**

说明：按 runtimeId 和 binding kind 调用 Grok/Codex resolver，生成独立 Adapter/connection/session；Account-backed Codex 复用 P2-01 的账号所有权，App Provider 从 safeStorage 引用生成本槽配置。

预期：TaskExecutor/Scheduler 不写 Grok/Codex 业务分支，未知组合在创建进程前拒绝。

- [ ] **第 3 步: 固定 Slot Ownership**

说明：每个 slot 记录 runtimeInstanceId、taskId、turnId、environmentId、adapter instance、startedAt 和状态；任一控制操作必须匹配完整身份。

预期：停止 Task A 不会调用 Task B Adapter，事件和权限无法跨实例串流。

- [ ] **第 4 步: 验证并发能力**

说明：分别记录 Grok/Codex 多进程、多连接或单进程多 Thread 的实测证据；只有取消、事件、权限、Secret 和资源隔离均通过才允许并发。

预期：没有证据的 Runtime 自动退化为单实例排队，UI 显示具体原因。

### 任务 2: 接入 Scheduler 分配与运行前复核

**任务目标：**

- 让有效 Turn 在同一 Scheduler 中排队，并在真正占槽前再次确认所有关键事实。

**涉及范围：**

- Scheduler、launch revalidator、TaskStore 和故障测试。

**前置依赖：**

- 依赖任务 1 的 factory 与实例所有权。

- [ ] **第 1 步: 扩展跨 Runtime 队列项**

说明：在 P0-17 既有 queued 元数据中增加 runtimeId、binding kind、launchDecisionRef/hash 和公开 modelId；仍不持久化可自动执行的完整 Prompt/Runtime payload。

预期：重启后的磁盘记录只能解释当时为什么排队，不能直接再次启动。

- [ ] **第 2 步: 实现运行前 Revalidation**

说明：分配 slot 前重新验证 decision 未过期、账号 revision、Provider origin/config、model/protocol evidence、environment fingerprint、Worktree ownership、permission policy 和 Runtime capability。

预期：设置改变、账号退出、Profile 删除、origin 漂移或 Worktree 失效时进入 blocked/reconfirm-required。

- [ ] **第 3 步: 复用冲突与资源策略**

说明：同一 Local execution root 的写 Task 串行；不同 Worktree 只有在 Runtime 证据和全局资源上限允许时并行；不同 Runtime 也不绕过 CPU、内存、磁盘和启动速率上限。

预期：跨 Runtime 不等于自动并行，未知副作用继续按写 Task 处理。

- [ ] **第 4 步: 原子分配与释放**

说明：单一调度循环先占用 slot，再创建 Runtime instance 并启动 Turn；创建失败释放本槽并记录有限原因。终态、取消和崩溃只释放对应槽，再选择下一项。

预期：重复调度不会启动两个实例，失败不会永久占槽或跳过队列事实。

### 任务 3: 收束故障、取消、登录变化与重启

**任务目标：**

- 让一个 Runtime 的异常只影响其 Task，并延续 P0-17 的不重放原则。

**涉及范围：**

- Scheduler、Supervisor、Permission Broker、TaskStore 和恢复测试。

**前置依赖：**

- 依赖任务 2 的跨 Runtime 调度路径。

- [ ] **第 1 步: 实现逐槽停止与取消**

说明：queued Task 直接收束 cancelled；running Task 只调用匹配的 Executor/Adapter；waiting-permission 的请求按 taskId/turnId 清理，不批量同意或拒绝其它槽。

预期：停止一个 Codex Task 不会退出 Grok Task，反之亦然。

- [ ] **第 2 步: 处理 Runtime/账号/Provider 故障**

说明：实例崩溃、登录失效、Provider origin 变化和模型证据过期只更新受影响 Task；共享 Supervisor 或 Provider 状态变化时逐 Task 重新评估，不直接杀死无关实例。

预期：故障范围、可重试条件和历史状态可追踪，不扩大权限或泄漏其它 session。

- [ ] **第 3 步: 清理临时环境与 Secret 引用**

说明：slot 终态后释放 Adapter、连接、pending request、权限请求、临时 Runtime 配置和 Secret 引用；Worktree 本身继续由 P0-14 ownership 管理，不由 Scheduler 删除。

预期：完成或失败后不保留可被其它 Task 复用的明文配置，也不误删任务结果。

- [ ] **第 4 步: 延续重启中断规则**

说明：应用重启后旧 queued/running 全部转 interrupted，清除内存 launch payload；用户必须创建或重新提交新 Turn。只恢复历史、阻塞原因和 runtime binding snapshot。

预期：不会因为 Scheduler 支持多 Runtime 就重放旧 Prompt、命令、登录或外部副作用。

### 任务 4: 实现跨 Runtime 运行中心与端到端验收

**任务目标：**

- 让用户理解每个 Task 的 Runtime、绑定模式、环境、排队原因和并发资格。

**涉及范围：**

- 全局运行中心、TaskList/TaskHeader、组件测试和 Electron 走查。

**前置依赖：**

- 依赖任务 1 至任务 3。

- [ ] **第 1 步: 展示跨 Runtime 队列事实**

说明：显示 Runtime、binding mode、model、Local/Worktree、queue position、等待权限、阻塞原因、并发证据和 slot 状态；account-backed 的 Profile 显示不适用，而不是缺失。

预期：用户能分辨忙、排队、配置需重确认、Runtime 不支持并发和资源不足。

- [ ] **第 2 步: 提供逐 Task 控制与修复入口**

说明：支持跳转、停止、移出队列和重新评估 decision；不提供 Renderer 自定义并发标志、进程数或运行路径。

预期：修复账号/Profile 后必须生成新 decision 或 revision，旧队列项不静默继续。

- [ ] **第 3 步: 完成跨 Runtime 并行走查**

说明：覆盖 Grok+Codex 不同 Worktree 并行、Local 写 Task 串行、未验证 Runtime 降级、一个等待权限、一个崩溃、单 Task 停止、账号退出、Provider origin 变化和重启 interrupted。

预期：事件、权限、Command Evidence、Changes、Artifact 和可选 Terminal 均按正确身份隔离。

- [ ] **第 4 步: 更新真实能力声明**

说明：只将通过多 Task/多 Runtime 实测的组合标记 parallel-capable；其它组合保持 queued-only 或 unverified。

预期：README、能力矩阵和 UI 不用选择器存在推断并行能力。

## 验收标准

- [ ] P2-04B 只消费 P2-04A decision 并扩展 P0-17，不重复定义 Runtime/Provider 选择、Task 启动契约或通用 Scheduler。
- [ ] 队列项和 TaskStore 不保存 Token、Key、Header、完整 Runtime 配置或可自动重放的 Prompt payload。
- [ ] 每个运行槽拥有独立 runtimeInstanceId、Task/Turn/Environment/Adapter 身份，事件、权限、停止和 Secret 不串槽。
- [ ] 运行前重新验证账号、Provider origin、模型/协议、environment 和 capability；漂移后 blocked/reconfirm-required，不静默使用旧配置。
- [ ] 同一 Local 写 Task 串行；不同 Worktree 只有在 Runtime 实测能力与资源上限允许时并行，未知组合退化排队。
- [ ] 停止、崩溃、登录失效和 Provider 变化只影响对应 Task；终态清理临时配置但不删除 Worktree 结果。
- [ ] 重启后旧 queued/running 全部 interrupted，用户必须重新提交，旧 Prompt、命令和登录副作用不能重放。
- [ ] P0-15/P0-16 保持可选增强，不成为跨 Runtime 队列的硬依赖。
- [ ] 新增核心函数、实例/Secret 边界、IPC Handler 和异常降级均有中文 TSDoc；测试只使用假凭据、本地 Mock 和临时目录。
- [ ] Node.js 20+、pnpm 10.x 下通过目标/完整 ESLint、相关 Vitest/组件测试、`pnpm typecheck`、`pnpm build` 与 `git diff --check`，并完成 Grok/Codex 队列与并行 Electron 走查。
