# P0-08 Task Executor 与后台生命周期 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0-A / 权重 5（长任务不依赖当前 Renderer 视图）

**目标：** 在 Electron 主进程建立 `TaskExecutor`，让活动 Turn 的运行、等待审批、取消和终态不再由当前页面或选中 Task 持有；首版只支持一个执行槽，但允许用户切换查看其它 Task 而不终止正在运行的任务。

**核心数据流：** `AgentService.startTurn()` 创建不可变执行快照并交给 TaskExecutor；Executor 占用唯一执行槽、调用 Adapter、路由事件和权限、更新 TaskStore；Renderer 通过查询和订阅观察状态，页面切换或组件卸载只移除监听，不改变主进程任务。

**约束与边界：** 本期不实现多任务并行、远程守护进程或应用退出后继续运行；App 正常退出时请求取消并写入终态，异常退出后的活动 Turn 在下次启动标记为 `interrupted`。Renderer 不拥有可执行回调或 Runtime 实例。

**主要风险：** 事件可能在 Task 切换、窗口刷新或取消过程中丢失；以主进程 TaskStore 为事实源，订阅只传增量，Renderer 重新订阅后必须先获取当前快照再消费新事件。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest。

---

## 实施范围

**前置依赖：**
- 依赖 P0-05、P0-06、P0-07。

**文件范围：**
- 创建 `src/main/agent/task-executor.ts`、`task-execution-state.ts` 及就近测试。
- 修改 `AgentService`、TaskStore、Agent IPC、主进程生命周期和 Renderer 事件订阅。
- 创建 `src/shared/task-execution.ts`，保存可序列化状态和订阅 DTO。

**安全策略：**
- 执行快照只引用已注册 Project、已绑定 execution root、固定 Runtime/模型和权限策略；执行开始后不得由 Renderer 静默改写。
- TaskExecutor 不直接读取 Provider Key；只通过 Adapter 已构造的受限 Runtime 环境执行。
- 所有任务事件和错误进入 TaskStore 前先脱敏、限长和关联 Task/Turn。

### 任务 1: 定义主进程执行状态机

**任务目标：**
- 统一表达一个 Turn 从提交到收束的所有状态和合法迁移。

**涉及范围：**
- `task-execution-state.ts`、共享 DTO 和状态机测试。

**前置依赖：**
- P0-06 已定义 Task/Turn，P0-07 已定义等待审批语义。

- [ ] **第 1 步: 固定状态与迁移表**
说明：状态至少包含 `queued`、`running`、`waiting_permission`、`cancelling`、`completed`、`failed`、`cancelled`、`interrupted`；终态不可回退，等待审批可进入 running、cancelling、failed 或 cancelled。
预期：每个外部事件和用户动作都能映射到唯一合法迁移，非法迁移返回有限错误。

- [ ] **第 2 步: 定义 ExecutionSnapshot**
说明：快照固定 taskId、turnId、projectId、runtimeId、modelId、environmentId、executionRoot、能力快照和权限策略版本。
预期：任务执行过程中设置页切模、Project 重新命名或 UI 切换不会改写在途事实。

- [ ] **第 3 步: 定义恢复前状态修正**
说明：应用启动时扫描非终态记录，统一标记为 `interrupted` 并保存上次已知阶段；不得猜测子进程仍在运行。
预期：异常退出后没有幽灵 busy 状态，用户可查看最后记录并按 Runtime 能力决定是否继续新 Turn。

### 任务 2: 实现单执行槽 TaskExecutor

**任务目标：**
- 将活动 Turn 从 Adapter 私有字段提升为主进程可观察、可收束的执行对象。

**涉及范围：**
- `task-executor.ts`、AgentService、Adapter 调用和 mock 测试。

**前置依赖：**
- 依赖任务 1 的状态机。

- [ ] **第 1 步: 实现执行槽占用和释放**
说明：`start()` 原子检查执行槽与 Task 状态，成功后持有 ExecutionSnapshot 和取消控制器；任何终态路径在 finally 中释放槽并更新 TaskStore。
预期：重复启动、双击发送和不同 Task 同时启动不会创建第二个活动 Turn。

- [ ] **第 2 步: 路由事件与权限**
说明：Adapter 事件只能进入当前匹配的 taskId/turnId；权限等待更新 Executor 状态，Broker 决策后恢复或收束。
预期：旧 Runtime 事件、错误 Task ID 和 Turn 完成后的普通事件不会污染当前执行。

- [ ] **第 3 步: 实现取消和断开收束**
说明：取消先进入 `cancelling`，幂等调用 Adapter cancel；超时后标记有限失败并断开不可信 Runtime。App 退出使用同一收束路径。
预期：停止按钮可重复点击但只触发一次实际取消，终态和执行槽最终一致。

### 任务 3: 建立快照查询与可恢复订阅

**任务目标：**
- 让 Renderer 随时重建界面，而不是依赖从页面挂载起未丢失的所有事件。

**涉及范围：**
- Agent IPC、Preload、Renderer 订阅 helper 和测试。

**前置依赖：**
- 依赖任务 2 的主进程事实源。

- [ ] **第 1 步: 提供当前执行查询**
说明：固定 IPC 返回执行槽、活动 taskId/turnId、状态、开始时间和有限进度摘要，不返回 Adapter 或子进程对象。
预期：Renderer 刷新、Task 切换或重新挂载后可立即得到准确当前状态。

- [ ] **第 2 步: 订阅快照后的增量**
说明：订阅建立时先返回当前 revision，再监听更高 revision 的状态/事件；组件卸载只移除自身 listener。
预期：查询与订阅交界不丢事件、不重复收束，旧页面监听器不会继续更新新视图。

- [ ] **第 3 步: 验证跨 Task 查看**
说明：运行 Task A 时切换查看已完成 Task B，再返回 A；同时验证权限到达、取消和完成。
预期：A 继续由主进程执行，B 只读展示，不发生自动停止或事件串流。

### 任务 4: 接入应用生命周期与故障降级

**任务目标：**
- 明确正常退出、窗口重建、Runtime 崩溃和主进程异常后的任务事实。

**涉及范围：**
- `src/main/index.ts` 生命周期组装、TaskStore、Electron 开发版走查。

**前置依赖：**
- 依赖任务 1 至任务 3。

- [ ] **第 1 步: 处理窗口与 App 退出交互**
说明：关闭或重建 Renderer 窗口不自动取消 Task；真正 App quit 且存在活动 Turn 时显示“继续等待”“取消任务并退出”“强制退出”三种明确选择。取消路径使用有限时收束，强制退出写入 `interrupted` 并说明可能存在外部副作用。
预期：界面暂时不可见不改变任务；用户知道退出会发生什么，应用退出后不会留下永久 running 状态。

- [ ] **第 2 步: 处理 Runtime 异常退出**
说明：Adapter 断开或子进程退出时将当前 Turn 收束为 failed/interrupted，清理权限请求和执行槽，并保留脱敏原因。
预期：用户可重新连接或新建 Turn，旧 Task 历史仍可审阅。

- [ ] **第 3 步: 完成手工故障注入**
说明：走查切换 Task、刷新窗口、等待权限、取消、Runtime 崩溃、正常退出和强制结束后重启。
预期：每条路径的 Task/Turn 状态与实际运行事实一致。

## 验收标准

- [ ] 活动 Turn 的生命周期由主进程 TaskExecutor 持有；Renderer 切换 Task、组件卸载或窗口重建不会静默终止任务。
- [ ] 首版只有一个执行槽，任何并发启动都被原子拒绝；停止、权限和终态能可靠释放执行槽。
- [ ] Renderer 可通过快照 + revision 增量恢复当前执行视图，不依赖从启动起保留所有事件。
- [ ] 正常退出和异常退出后不存在幽灵 running 状态，未完成 Turn 明确标记为 `interrupted`。
- [ ] 存在活动 Turn 时退出应用会显示等待、取消并退出、强制退出的明确选择，不静默终止长任务。
- [ ] 目标 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过，并完成切换 Task、窗口重建、取消和 Runtime 崩溃的 Electron 走查。
