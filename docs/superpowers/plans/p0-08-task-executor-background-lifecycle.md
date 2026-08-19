# P0-08 Task Executor 与后台生命周期实施计划

> **状态：** 核心实现、完整自动门禁和首批受控生命周期 Electron E2E 已完成；真实 Grok 活动窗口/退出三分支、窗口重建/重启恢复和 Windows/Linux 验证仍待补。GACP-01 已于 2026-08-19 受限关闭，不再回填这些平台项，也不挡 GACP-02。Windows/Linux 与产品退出对话框仍留在本计划。

**优先级：** P0-A / 权重 5（长任务不依赖当前 Renderer 视图）

**目标：** 在 Electron 主进程建立单执行槽 `TaskExecutor`，让活动 Turn 的受理、运行、等待审批、取消、故障和终态不再由当前页面、长生命周期 IPC Promise、选中 Task 或 Runtime Adapter 私有字段共同持有。首版只允许一个活动执行，不建立等待队列；用户可以在 Turn 运行期间查看其它 Task、刷新 Renderer 或重建窗口，而不会因此终止、批准或拒绝后台任务。

**核心数据流：** `AgentService.startTurn()` 校验 Task 和 Project 后，在任何异步持久化或 Runtime 调用前向 TaskExecutor 申请原子 admission；Executor 固定不可变执行事实、协调 TaskStore 写入、调用 Adapter、消费 Runtime 事件和 PermissionBroker 的聚合等待状态，并作为唯一终态仲裁者。Renderer 通过执行快照、独立 execution revision 和有界历史补拉重建视图，只能发送启动、取消、审批和退出选择等有限命令。

**核心边界：** TaskStore 保存持久化事实；TaskExecutor 拥有当前执行；AgentService 负责 Task/session 命令编排；Runtime Adapter 只负责协议和子进程；PermissionBroker 独占授权、审批、grant、超时和审计；Renderer 只观察状态并提交显式用户动作。

**非目标：**

- 不实现多任务等待队列、queue position、资源调度或并行执行；这些属于 P0-17。
- 不实现应用完全退出后继续运行、远程守护进程或自动重放旧 Prompt。
- 不实现 Worktree 创建或路径所有权迁移；P0-08 只建立可由 P0-14 扩展的 environment resolver 边界。
- 不实现 P0-09 的完整 Timeline reducer、结果审阅 UI、Diff、Command Evidence、Artifact 或 Terminal。
- 不承诺 Runtime 未上报的副作用已经停止，也不把进程断开描述为 OS 级沙箱或子进程树隔离。

**主要风险：** admission 发生在异步写入之后会生成两个持久化 Turn；Runtime 事件、Promise 返回、disconnect 和进程退出可能竞争提交不同终态；Task/Turn 分文件写入可能部分成功；Renderer 查询与订阅交界可能丢 revision；当前视图可能错误影响后台权限；取消或退出可能永久等待；不同平台对最后窗口关闭和 App quit 的行为不同。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、Playwright Electron E2E。

---

## 一、前置依赖与复用边界

**直接依赖：**

- P0-05：复用中性 Runtime Adapter、精确 Turn/session identity、协议事件归一化和 Grok generation 隔离。
- P0-06：复用 Project、Task、Turn、TaskStore、历史事件、原生 session 恢复和启动中断修正。
- P0-07：复用 PermissionBroker、审批 TTL、FIFO、Task grant、精确取消、审计和 shutdown drain。

**必须沿用的既有契约：**

- P0-02 的 `taskId`、`turnId`、event sequence 和 Turn terminal 屏障；P0-08 不定义第二套 AgentEvent 顺序。
- P0-03 的 capability snapshot 和证据来源；执行快照只记录 admission 时使用的能力事实，不把历史快照当作未来恢复时的永久能力授权。
- P0-06 的 TaskStore 是唯一持久化实现；TaskExecutor 不另建一套历史数据库或启动扫描。
- P0-07 的 PermissionBroker 是审批实体、pending queue、scope、grant 和审计的唯一所有者；TaskExecutor 只消费聚合等待状态并调用既有取消/失效入口。
- P0-08 固定 Local 环境身份：`environmentId` 由受信主进程根据稳定 `projectId` 和 canonical root 按版本化规则生成，并持久化到新 execution/Task schema；旧 P0-06 记录在初始化迁移时按其 `projectId + rootSnapshot` 补齐。canonical root 漂移、Project 不可用或身份重算不一致时禁止执行，只允许历史查看。
- `environmentId` 是环境权威身份；绝对执行路径只作为 environment resolver 在 admission 时校验得到的 Main 内部结果，不进入 Renderer DTO，也不成为第二个持久化权威字段。
- P0-14 只扩展 Worktree environment kind、identity 和 resolver，不改变 P0-08 已固定的环境身份消费方式。
- P0-17 才拥有真正的 `queued` 等待队列、位置和阻塞原因。P0-08 若使用 `queued`，只表示已原子受理但尚未完成持久化或 dispatch 的短暂提交阶段，不能等待其它执行释放资源。

---

## 二、固定领域契约

### 2.1 执行状态

共享状态统一使用 kebab-case：

- `queued`：已取得唯一 admission，正在持久化执行事实或准备 dispatch；不得作为等待其它任务完成的队列。
- `running`：已持久化 dispatch 事实并调用 Runtime。
- `waiting-permission`：Runtime 尚在执行，但当前 Turn 至少有一个 PermissionBroker 审批未决。
- `cancelling`：用户或退出流程已请求取消，正在等待可信 Runtime 终态或取消 deadline。
- `completed`：Runtime 返回可信成功终态。
- `failed`：主进程仍存活并确认 Runtime、协议、持久化或执行过程失败。
- `cancelled`：已收到可信取消终态，或在尚未 dispatch 的 `queued` 阶段成功取消。
- `interrupted`：主进程崩溃、强制退出、取消超时后强制断开，或系统无法确认 Runtime 和外部副作用最终事实。

`completed`、`failed`、`cancelled`、`interrupted` 为终态。首个合法终态胜出，之后的 Runtime 完成、Promise reject、disconnect、进程 exit 或取消响应不得覆盖终态，也不得无意义增加 revision 或重写 `endedAt`。

### 2.2 合法迁移

- `queued → running | cancelled | failed | interrupted`
- `running → waiting-permission | cancelling | completed | failed | interrupted`
- `waiting-permission → running | cancelling | completed | failed | interrupted`
- `cancelling → completed | cancelled | failed | interrupted`
- 任意非终态在启动恢复时统一转为 `interrupted`
- 终态只能接受完全相同的幂等重复提交；不同终态提交返回有限冲突结果并保持原状态

取消请求只表示用户意图，不拥有高于 Runtime 事实的终态优先级：如果 `cancelling` 后先收到可信正常完成，则提交 `completed`；先收到可信取消终态则提交 `cancelled`；明确 Runtime/协议失败提交 `failed`；deadline 到达且无法确认最终事实提交 `interrupted`。审批取消本身不是 Turn 终态，只有 Runtime 后续终态、明确失败或取消 deadline 才能收束 Turn。

`waiting-permission → running` 只能在该 Turn 的 Broker pending count 归零、执行仍为当前 identity、且状态不是 `cancelling` 或终态时发生。

### 2.3 ExecutionSnapshot

主进程内部不可变快照至少固定：

- `executionId`：当前 App 生命周期内唯一执行身份，不复用 taskId 或 turnId。
- `taskId`、`turnId`、`projectId`、`runtimeId`。
- `model`：实际 `modelId` 与可选 `displayName`。
- `environmentId` 与环境 kind/version。
- 主进程 environment resolver 在 admission 时校验得到的 `resolvedExecutionRoot`；仅供 Main 内部使用。
- admission 时的 capability snapshot 或持久化安全投影。
- permission policy identifier/version；不得包含 Task grant 或审批实体。
- `acceptedAt` 和 executor epoch。

Renderer 可见 DTO 是独立白名单投影，不包含：`resolvedExecutionRoot`、`runtimeSessionId`、Provider Key、环境变量、Runtime 原始 payload、permission requestId、optionId、parameter fingerprint、AbortController 或子进程对象。

### 2.4 Revision 与事件顺序

三类顺序必须分离：

- `executionRevision`：TaskExecutor 当前进程 epoch 内的单调状态版本，只在执行快照发生可观察变化时递增。
- Task/Turn `revision`：TaskStore 持久化记录修订号。
- AgentEvent `sequence`：同 Turn 规范化事件顺序。

不得用其中任意一种代替另外两种。Renderer 发现 execution revision 跳号时重新查询当前快照，并用 TaskStore 历史接口按 Turn sequence 补拉事件；不得猜测缺失状态。

---

## 三、原子性与故障协议

### 3.1 Turn admission 与启动提交点

`startTurn()` 必须按以下顺序执行：

1. AgentService 校验 Task、Project、Runtime 和输入大小，但不进行任何会改变执行事实的异步操作。
2. TaskExecutor 在首个 `await` 前同步原子冻结 admission，并拒绝第二个 Turn、Provider mutation 和不兼容 session operation。
3. 在 admission 内分配 `executionId`、`turnId`，构造不可变 ExecutionSnapshot。
4. TaskStore 持久化 Turn、Task active identity 和 `queued` 事实。
5. 持久化成功后写入 dispatch/running 事实。
6. 只有 running 事实写入成功后才调用 Adapter；任何更早的失败不得发送 Prompt。
7. admission 可靠落盘后，IPC 快速返回 Renderer 可见执行快照；实际 Turn 在主进程后台继续。

若步骤 4 或 5 失败，Executor 提交 `failed` 或回滚未 dispatch 的 admission，并保证 Task/Turn 不留下幽灵 `activeTurnId`。若 Runtime 已调用后发生历史写入失败，不得重放 Prompt；Executor 进入可观察的持久化降级/失败路径，并在终态前再次排空或记录失败。

### 3.2 唯一终态仲裁

以下来源只能向 TaskExecutor 提交终态信号，不能直接修改 Task、Turn 或释放槽：

- Adapter `turn-complete` 事件。
- `adapter.startTurn()` Promise resolve/reject。
- Runtime process error/exit 或 connection loss。
- 用户取消、取消 deadline 和强制 disconnect。
- App shutdown/force interrupt。

Executor 的 `completeIfCurrent` 以完整 execution identity 和 executor generation 校验当前执行。首次合法终态按“持久化终态 → 更新内存快照/revision → 发布更新 → 清理权限 → 释放执行槽”的顺序提交。

若终态持久化失败，Executor 进入 `persistence-degraded` 的主进程内部失败关闭状态：不向 Renderer 宣布原业务终态、不接受新 Turn/Provider mutation/session operation，并保存首个写入错误；随后按有限重试和 history drain deadline 重试。deadline 内恢复时继续正常提交；deadline 到达仍失败时发布有限的“历史持久化不可用”执行摘要，允许用户重试写入或退出，但不得启动新执行。退出流程有界尝试记录 `interrupted/persistence-failed`；仍无法写盘时可释放内存资源并退出，同时明确下次启动只能依据磁盘可见事实交叉修复，不能声称终态已经持久化。

### 3.3 历史写入与部分提交恢复

- TaskStore 的同 Task mutation 继续串行化，但 AgentService/Executor 必须保留首个未处理写入错误，不能用后续成功写入掩盖失败。
- Executor 提供可等待的当前执行 history drain，App 退出必须等待或有界放弃该 drain。
- Task/Turn 分文件更新发生部分成功时，启动扫描必须按 activeTurnId、Turn 状态和 revision 做交叉修复，不能只检查 Task state。
- `pending` 且持有 activeTurnId、`queued`、`running`、`waiting-permission`、`cancelling` 均属于未完成事实，重启后一律转为 `interrupted` 并清除 active identity。
- 不得从 `promptDisplayText`、事件历史或旧 ExecutionSnapshot 自动重新 dispatch。

### 3.4 Provider mutation 门禁

Provider `save`、`selectModel`、`clear` 和未来同类 mutation 必须通过一个主进程串行门禁：

- admission、活动执行、session operation 或 shutdown 期间拒绝 mutation。
- 在取得 mutation lease 后重新读取当前配置、Runtime 状态和 workspace，禁止只依赖调用开始时的旧快照。
- 保存、断开、重连和失败回滚属于同一 mutation；并发 mutation 不得交错覆盖内存配置、磁盘配置或 Runtime 实际配置。
- ExecutionSnapshot 使用 admission 时已冻结的 model，设置页之后的变化不得改写在途 Turn。

### 3.5 共享操作仲裁门

Task admission、Provider mutation、Runtime session operation 和 shutdown 必须共用一个主进程同步仲裁器，而不是各自先检查再异步执行：

- 仲裁器状态至少区分 `idle`、`admitting-execution`、`execution-active`、`provider-mutation`、`session-operation`、`shutting-down`。
- 所有 reservation 都在首个 `await` 前同步取得；只有持有 reservation 的操作才能进入异步阶段。
- `shutting-down` 优先级最高且不可逆；活动 execution 只能由 shutdown transaction 收束，不能被新的 Provider/session 操作抢占。
- `session-operation` 明确包括 connect、disconnect、createSession、loadSession、resumeSession、closeSession 和 Provider 变更引发的 Runtime reconnect。
- admission、Provider mutation 和 session operation 互斥；失败和取消必须在 `finally` 中按 reservation identity 释放，旧异步操作不得释放新 reservation。
- Provider mutation 在取得 reservation 后重新读取配置和 Runtime 事实；admission 在取得 reservation 后构造快照，因此双方不存在检查与提交之间的 TOCTOU。

---

## 四、权限、订阅与 Renderer 协议

### 4.1 权限生命周期

- PermissionBroker 继续拥有审批 identity、FIFO、TTL、scope、Task grant、审计和精确取消。
- TaskExecutor 不保存审批实体，只保存 Broker 针对当前 execution 报告的 pending count 或聚合等待状态。
- 查看其它 Task、Renderer 卸载、窗口关闭或 activeTaskId 改变，均不得自动批准或拒绝后台审批。
- 非当前 Task 审批保留在主进程，由全局待处理摘要提示用户；用户可以跳转到对应 Task 后显式决策。
- Turn 进入 `cancelling` 或终态后，Executor 调用 Broker 的精确 Turn 取消；晚到审批响应不得恢复执行或触发操作。
- “继续等待退出”不得调用不可逆的 `PermissionBroker.shutdown()`；只有用户确认实际退出后才能冻结新授权并开始 shutdown drain。

### 4.2 快照与 revision 握手

建立固定、类型化的执行查询和 push channel。Renderer 恢复顺序为：

1. 安装 execution update listener，并开始按 revision 暂存增量。
2. 查询当前 execution snapshot、executor epoch 和 watermark revision。
3. 应用快照。
4. 丢弃 `revision <= watermark` 的重复增量，按序应用更高 revision。
5. 发现 epoch 改变或 revision 跳号时停止猜测，重新查询快照。
6. AgentEvent 内容通过历史接口按 Turn sequence 补拉，再消费后续实时事件。

主进程必须保证 listener 安装与 watermark 捕获之间不存在不可见窗口；若 Electron IPC 无法提供单次原子订阅注册，则使用“先监听、后查询、按 watermark 去重”的协议并为交界竞态写确定性测试。

### 4.3 Renderer 执行身份与查看身份分离

- `executingTaskId` 来自主进程执行快照；`activeTaskId` 只表示当前查看的 Task。
- 活动 Turn 存在时禁止启动第二个 Turn、切换模型、清除 Provider、重连 Runtime 或执行会改变 Runtime session 的操作。
- 活动 Turn 存在时允许查看其它 Task 和其它 Project 的持久化历史，但不得为了查看历史自动重连 Runtime 到另一个 Project。
- 非当前 Task 的实时事件不直接写入当前视图；对应 Task 的历史和状态摘要仍更新。切回时通过快照加历史补拉重建。
- Stop 必须绑定 `executingTaskId/executionId`，不能因为用户正在查看另一 Task 而误停或无法停止后台执行。
- 计时、等待权限和终态显示以主进程时间戳和执行快照为准，不依赖组件从挂载开始观察到所有 `busy/ready` 变化。

---

## 五、取消、Runtime 故障和 App 生命周期

### 5.1 取消协议

- 首次取消原子迁移为 `cancelling` 并只调用一次 Adapter cancel；重复取消复用同一意图。
- 取消 deadline 使用注入式单调时钟和固定内部常量，测试不得依赖真实长等待。
- deadline 内收到可信 cancelled 终态时提交 `cancelled`。
- deadline 到达仍无法确认停止时，先取消 Broker 审批，再断开/终止不可信 Runtime，最终提交 `interrupted` 和有限 `cancel-timeout` 原因；不得谎称已取消。
- Adapter cancel 明确失败但连接仍可信时允许用户重试；进入 shutdown 强制阶段后不再无限重试。
- Runtime 明确 process error/exit 且主进程仍存活时提交 `failed`；主进程崩溃或结果无法确认时由启动恢复提交 `interrupted`。

具体 deadline 数值在任务 1 的状态契约测试中固定，并在 Electron 走查记录实际体验；不得留到实现者临时决定。

### 5.2 窗口关闭与 App quit

- BrowserWindow 销毁、Renderer reload 或组件卸载只清理自身 listener，不取消 Turn。
- macOS 最后窗口关闭继续保持 App 和后台 Turn，并允许通过 Dock `activate` 重建窗口。
- Windows/Linux 活动 Turn 存在时，最后窗口关闭不得静默触发 App quit；应保留或隐藏窗口并进入明确退出选择流程。无活动 Turn 时沿用平台常规行为。
- 用户主动 quit 且无活动 execution 时执行有界 Broker/Runtime/history 清理后退出。
- 用户主动 quit 且有活动 execution 时显示三种选择：
  - **继续等待：** 取消本次 quit，保持 Executor、Broker 和 Runtime 可用。
  - **取消任务并退出：** 进入 `cancelling`，在 graceful deadline 内等待可信终态；随后 drain 历史和权限并退出。超时后按 `interrupted` 强制断开。
  - **强制退出：** 冻结新 admission，有界尝试持久化 `interrupted` 与风险原因、取消审批并终止 Runtime；超过极短持久化/终止期限后允许退出，并依赖下次启动扫描修复。
- 系统关机、注销或主进程异常可能无法展示对话框，也不能保证异步写入完成；必须失败关闭并依赖启动恢复，不能声称强制路径一定写盘成功。

### 5.3 Shutdown 次序

确认实际退出后按以下顺序执行：

1. 冻结新的 Turn、Provider mutation 和 session operation。
2. 按用户选择取消或 interrupt 当前 execution。
3. 精确取消该 Turn 的 Broker pending approvals，并执行 Broker shutdown drain。
4. 排空或有界记录 TaskStore/history 写入结果。
5. 断开 Runtime，等待子进程退出到 deadline，必要时升级强制终止。
6. 清理完成或总 deadline 到达后再次触发 app quit。

`before-quit` 重入必须共享同一 shutdown transaction；“继续等待”不创建 transaction，也不改变 Broker 可用状态。

---

## 六、文件范围

**计划新增：**

- `src/shared/task-execution.ts`
- `src/main/agent/task-execution-state.ts`
- `src/main/agent/task-execution-state.test.ts`
- `src/main/agent/task-executor.ts`
- `src/main/agent/task-executor.test.ts`
- `src/renderer/src/task-execution-consumer.ts`
- `src/renderer/src/task-execution-consumer.test.ts`
- `tests/e2e/task-executor-background-lifecycle.spec.ts`
- 必要时新增独立 Playwright lifecycle config；不得扩大为任意 Runtime/命令测试入口
- 必要时新增 `src/main/agent/operation-gate.ts` 及就近测试，统一 execution admission、Provider mutation、session operation 和 shutdown reservation

**计划修改：**

- `src/main/agent/agent-service.ts` 及测试
- `src/main/agent/task-execution-controller.ts` 及测试：迁移、组合或删除前保留其精确 identity 与取消语义
- `src/main/agent/task-store.ts` 及测试
- `src/main/agent/ipc.ts`、`src/shared/agent-ipc.ts` 及测试
- `src/preload/desktop-api.ts`、`src/preload/index.d.ts` 及测试
- `src/main/index.ts`、`src/main/app-shutdown.ts` 及测试
- `src/main/provider/ipc.ts`、`src/main/provider/provider-config-store.ts` 或新增的 operation gate/mutation coordinator 及测试
- `package.json`：增加固定的 lifecycle E2E 和 P0-08 验证脚本
- `docs/superpowers/plans/p0-09-execution-timeline-review.md`：同步统一执行状态拼写
- `src/renderer/src/App.vue` 和现有事件消费/Task 历史编排
- 受控 ACP E2E bootstrap、固定场景白名单和 Playwright fixture
- 本计划、roadmap 状态和 CLAUDE/AGENTS 当前进度记录

**尽量不扩大：**

- 不把产品执行状态机下沉到 `GrokAcpAdapter`。
- 不复制 PermissionBroker 的审批队列或 Task grant。
- 不提前创建多 Runtime pool、Scheduler、Worktree manager 或完整 Timeline UI。

---

## 七、实施任务

### 任务 1：冻结状态机、deadline 与失败测试

**任务目标：** 在改造执行代码前，用纯状态机和失败测试锁定所有竞态与终态语义。

- [ ] **第 1 步：定义共享 DTO 和完整迁移表**
  - 统一 kebab-case 状态、终态、有限原因码、ExecutionSnapshot 安全投影、executor epoch 和 execution revision。
  - 为每条合法迁移、非法迁移、重复终态和晚到不同终态写测试。

- [ ] **第 2 步：固定取消与退出 deadline**
  - 定义交互取消、graceful quit、Runtime terminate 和总 shutdown 的内部常量及注入式时钟。
  - 明确 timeout 对应 `interrupted` 和有限原因，测试中使用 fake clock。

- [ ] **第 3 步：先补现有缺陷的回归测试**
  - 同 tick 两个 `startTurn()` 在首个 TaskStore 写入阻塞时只能有一个 admission。
  - createTurn 后、dispatch 前崩溃不会留下 pending activeTurn。
  - turn-complete、Promise reject、disconnect 和 process exit 竞争时首个终态胜出。
  - 前序历史写失败不能被后续成功掩盖。

### 任务 2：扩展 TaskStore 执行事实与恢复

**任务目标：** 让 TaskStore 能可靠保存 admission、状态和终态，并修复部分提交。

- [ ] **第 1 步：扩展版本化 schema**
  - 保存持久化安全版 execution identity、environmentId、model、能力证据、状态、reason 和时间戳。
  - 提供旧 schema 兼容和高版本隔离，不读取旧 Prompt 自动执行。

- [ ] **第 2 步：实现启动交叉修复**
  - 根据 Task activeTurnId、Turn state 和 revision 修复 `pending/queued/running/waiting-permission/cancelling`。
  - 所有未完成记录统一写为 `interrupted`，清除 active identity；重复启动修复幂等。

- [ ] **第 3 步：明确部分写入失败策略**
  - Task/Turn 双文件第二次写失败时可补偿或由启动扫描确定性修复。
  - history drain 返回首个未处理失败，终态不得在持久化失败时虚假发布。

### 任务 3：实现原子单槽 TaskExecutor

**任务目标：** 将当前活动 Turn 提升为主进程唯一可观察执行对象。

- [ ] **第 1 步：实现同步 admission 和不可变快照**
  - admission 在首个 await 前完成；重复启动、不同 Task 启动和 Provider/session mutation 均被原子拒绝。
  - environment resolver 校验 Project 和 environmentId，resolved root 只进入内部执行对象。

- [ ] **第 2 步：实现后台 dispatch 与状态发布**
  - queued/running 按提交协议持久化；受理成功后 IPC 快速返回，后台 Promise 继续执行。
  - 每次可观察状态变化递增 execution revision，并只发布白名单 DTO。

- [ ] **第 3 步：实现唯一终态和槽释放**
  - Adapter event、Promise、process exit、disconnect 和 shutdown 全部委托 `completeIfCurrent`。
  - 终态持久化成功后再发布和释放；旧 generation、旧 execution 和晚到事件无权改变新槽。

### 任务 4：接入 PermissionBroker 与有界取消

**任务目标：** 保留 P0-07 的权限所有权，同时让执行状态准确反映等待和取消。

- [ ] **第 1 步：迁移聚合等待状态**
  - Broker pending count 大于零时进入 `waiting-permission`，归零时仅在仍运行且未取消时恢复 `running`。
  - 多审批、精确 ToolCall 取消和晚到审批继续使用 P0-07 语义。

- [ ] **第 2 步：实现取消状态机**
  - 首次取消进入 `cancelling`；重复点击只调用一次 Adapter；明确失败允许重试。
  - cancel/complete race、审批响应/cancel race 和 Runtime disconnect race 只有一个终态。

- [ ] **第 3 步：实现超时升级**
  - deadline 后取消 Broker 请求、强制断开 Runtime、写入 `interrupted/cancel-timeout` 并释放槽。
  - 断开动作本身有第二 deadline，不能让 App 或 Executor永久等待。

### 任务 5：瘦身 AgentService 并串行 Provider mutation

**任务目标：** AgentService 回归 Task/session 门面，避免第二套执行状态和设置竞态。

- [ ] **第 1 步：迁移 AgentService 执行职责**
  - start、cancel、Runtime event 和 disconnect 统一委托 Executor。
  - 移除重复 active Turn 状态、重复终态和独立 history queue 所有权。

- [ ] **第 2 步：调整 startTurn IPC 语义**
  - admission 可靠持久化后快速返回 execution snapshot，不等待整个 Turn。
  - Renderer invoke 中断或组件卸载不影响主进程 execution。

- [ ] **第 3 步：串行 Provider mutation**
  - save、selectModel、clear 共用 mutation lease，并在 lease 内重新校验 Executor/Runtime 状态。
  - 并发保存、保存与清除、保存失败回滚均有确定性测试。

### 任务 6：建立快照查询与可恢复订阅

**任务目标：** Renderer 能在 reload、窗口重建和 Task 切换后重建当前执行，而不依赖完整 push 历史。

- [ ] **第 1 步：新增固定 IPC 和 Preload 白名单**
  - 查询当前 execution、epoch、revision 和有限进度摘要。
  - Push DTO 运行时校验并过滤私有路径、session、Runtime payload 和权限内部字段。

- [ ] **第 2 步：实现快照与增量握手**
  - 先监听后查询，按 watermark 去重；revision 跳号或 epoch 改变时重新同步。
  - 组件卸载只移除 listener，不向 Main 发送取消。

- [ ] **第 3 步：补齐事件历史 tail**
  - 切回运行 Task 时先应用 execution snapshot，再从 TaskStore 按 sequence 补拉缺失 AgentEvent，最后接实时事件。
  - 重复、缺口、晚到终态和窗口冻结都有确定性测试。

### 任务 7：解耦 Renderer 查看与执行身份

**任务目标：** 运行 Task A 时可以查看 Task B，且视图切换不改变 A 的权限和执行事实。

- [ ] **第 1 步：拆分 executingTaskId 与 activeTaskId**
  - 全局执行门禁只阻止第二次启动、模型切换和 Runtime 重连，不阻止历史导航。
  - 浏览其它 Project 历史时不自动连接该 Project Runtime。

- [ ] **第 2 步：改造后台权限体验**
  - 非当前 Task 审批不再自动 deny；提供全局等待摘要和跳转入口。
  - Stop 始终绑定主进程当前 execution，而不是当前页面。

- [ ] **第 3 步：恢复计时和状态投影**
  - 使用主进程时间戳恢复 running、waiting-permission、cancelling 和终态。
  - Task A → Task B → Task A、Renderer reload 和窗口重建后状态一致。

### 任务 8：实现窗口与 App 退出协调器

**任务目标：** 窗口生命周期不影响任务，真正退出有明确、有界且可恢复的选择。

- [ ] **第 1 步：区分 Window close 与 App quit**
  - macOS、Windows/Linux 活动 Turn 时均不因最后窗口关闭而静默取消。
  - 无窗口时审批继续由 Broker 超时失败关闭，绝不自动允许。

- [ ] **第 2 步：实现退出三选项**
  - 继续等待不改变 Broker/Executor；取消并退出走 graceful deadline；强制退出有界写 interrupted 并终止 Runtime。
  - before-quit 重入共享单一 transaction，不重复弹窗或重复收束。

- [ ] **第 3 步：实现有界 shutdown drain**
  - 冻结 admission、收束 execution、取消审批、排空历史、确认 Runtime 进程退出，再 quit。
  - 任一步超时有有限结果并继续强制路径，不能永久阻塞 App。

### 任务 9：完成自动化与 Electron 故障注入

**任务目标：** 用确定性 fixture 证明后台生命周期，而不是只靠手工幸福路径。

- [ ] **第 1 步：扩展固定受控 ACP 场景**
  - 增加长任务 barrier、reload 后事件、Runtime crash、忽略 cancel 和退出恢复场景。
  - 保持开发态、固定 fixture、隔离 userData/HOME、固定参数白名单和无真实 Key 边界。
  - 当前已完成长任务、后台审批、忽略 cancel、Runtime crash 和空闲退出；重启 interrupted 仍待补。

- [ ] **第 2 步：完成 Electron E2E**
  - Task A 运行时查看 B 并返回 A。
  - Renderer reload、BrowserWindow 销毁/重建后 Turn 继续。
  - 后台权限不会因当前视图改变而自动拒绝。
  - 重复启动、重复停止、Runtime crash、cancel timeout、三种退出选择和重启 interrupted 均有跨层证据。
  - 当前已通过 Task/Project 浏览、Renderer reload、后台审批、重复 Stop、cancel timeout、Runtime crash 和空闲退出；BrowserWindow 重建、活动执行退出三分支及重启 interrupted 仍待补。

- [ ] **第 3 步：完成平台和完整门禁**
  - 当前开发环境必须完成 macOS 自动 E2E 与手工窗口/退出验证。
  - Windows/Linux 行为通过可用的 CI runner 或对应测试机完成后方可勾选跨平台子项；若当前阶段无该环境，P0-08 可以完成 macOS 产品实现，但路线图和验收记录必须明确标注“Windows/Linux 生命周期待验证”，不得宣称跨平台完成。
  - 运行目标 ESLint、完整 ESLint、相关 Vitest、`pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm build:unpack`、生命周期 E2E 和 `git diff --check`。
  - 当前 macOS 完整自动门禁与隔离窗口后台浏览/Stop 走查已通过；真实 Grok 退出走查和 Windows/Linux 仍待补。

---

## 八、验收标准

- [ ] TaskExecutor 在任何异步持久化或 Runtime 操作前原子 admission；两个并发启动最多创建一个 Turn 和一次 Runtime prompt，不存在 pending activeTurn 幽灵记录。
- [ ] 活动 Turn 的唯一内存事实和终态仲裁由 TaskExecutor 持有；Runtime event、Promise、disconnect、process exit、取消和 shutdown 无法重复或冲突提交终态。
- [ ] 状态使用统一 kebab-case，`queued` 只表示短暂提交阶段；P0-08 不建立等待队列，P0-17 的 Scheduler 所有权不被提前侵占。
- [ ] ExecutionSnapshot 固定 Task、Turn、Project、Runtime、model、environment 和能力事实；`environmentId` 是权威身份，绝对路径和 Runtime 私有信息不进入 Renderer DTO。
- [ ] TaskStore 能修复 Task/Turn 部分提交；`pending/queued/running/waiting-permission/cancelling` 在异常重启后一律成为 `interrupted`，且不会自动重放 Prompt。
- [ ] 历史写入失败可观察且不会被后续成功掩盖；终态持久化成功前不发布虚假完成状态，也不释放槽给下一 Turn。
- [ ] PermissionBroker 继续独占审批和 grant；Task 切换、Renderer reload、窗口关闭不会自动允许或拒绝后台审批，多审批全部收束后才恢复 running。
- [ ] Renderer 使用独立 execution revision 和 epoch 完成快照/增量恢复；查询订阅交界、revision 重复/跳号和 AgentEvent history tail 均有确定性测试。
- [ ] 运行 Task A 时可以查看 Task B 或其它 Project 历史，A 继续执行；查看历史不触发 Runtime 重连，Stop 和权限始终绑定真实 executing Task。
- [ ] Provider save/selectModel/clear 串行化，admission、活动 Turn、session operation 和 shutdown 期间不能改变在途 Runtime/model 事实。
- [ ] 取消进入 `cancelling` 且幂等；取消超时和不可信 Runtime 强制断开最终为 `interrupted`，可信取消才为 `cancelled`，所有路径有界释放执行槽。
- [ ] BrowserWindow 销毁或重建不终止 Turn；App quit 有“继续等待”“取消任务并退出”“强制退出”三种明确选择，且继续等待不会不可逆关闭 Broker。
- [ ] Shutdown 等待或有界放弃 execution、权限、历史和 Runtime 子进程收束，任一 Promise 不返回都不会永久阻止退出。
- [ ] 受控 Electron E2E 覆盖 Task 切换、reload、窗口重建、后台权限、重复启动/停止、Runtime crash、cancel timeout、退出三分支和重启 interrupted；真实 Grok 手工证据与受控 fixture 边界分开陈述。
- [ ] 目标 ESLint、全仓 ESLint、相关 Vitest、`pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm build:unpack`、生命周期 Electron E2E 和 `git diff --check` 全部通过，并记录 Node/pnpm 版本及平台验证限制。

---

## 九、实施完成记录

实施期间按以下格式持续更新，不能只勾选任务而不保留证据：

- 状态机与 schema 版本：已新增独立 `TaskExecutionState`、判别 DTO、execution epoch/revision、OperationGate；Task/Turn schema 升级到 V2，Event schema 保持 V1，旧 V1 Task/Turn 在初始化时显式升级。
- admission/终态/持久化竞态测试：已覆盖首个 await 前 admission、queued/running 提交顺序、旧 lease、终态竞争、事件脱敏、终态部分提交重试、非终态重启恢复和 legacy environmentId 迁移。
- IPC、Preload 和 Renderer revision 恢复证据：已增加 execution snapshot invoke/push、execution identity cancel、Preload 窄 API 和 listener-before-query consumer；App 已接入 consumer，后台权限不再因视图切换自动拒绝。
- Electron lifecycle E2E 场景与结果：已新增独立 Playwright config；空闲退出、长任务 Task/Project 后台浏览与 Renderer reload、后台审批、重复 Stop/cancel timeout、Runtime exit 17 五场景 5/5 通过，三轮稳定性验证 15/15 通过。BrowserWindow 重建、活动执行退出三分支和重启 interrupted 仍待补。
- macOS 与 Windows/Linux 窗口/退出差异：Main 已实现活动执行退出三选项和有界清理；macOS 隔离窗口已手工确认后台浏览与跨视图 Stop，真实 Grok close/activate/退出三分支、非 macOS last-window 及系统关机仍待真实平台走查。
- 完整自动门禁版本和结果：2026-08-17，Node.js `v22.22.0`、pnpm `10.33.0`；全仓 ESLint、`pnpm test`（42 文件 / 415 项）、`pnpm typecheck`、`pnpm build`、`pnpm build:unpack` 和 `git diff --check` 通过；Permission Electron E2E 4/4 且三轮 12/12，lifecycle Electron E2E 5/5 且三轮 15/15。GitNexus compare 因跨 Main/Store/IPC/Renderer/lifecycle 变更评为 CRITICAL，继续保留真机与平台门禁。
- 真实 Grok 手工验收与受控 fixture 边界：待补 P0-08 真机长任务、Task A/B 查看切换、Renderer reload、窗口重建和三种退出路径；受控 fixture 仍只证明固定本地 ACP/Electron 链路，不等价于真实 Grok 黑盒或进程沙箱。
