# P0-17 多任务队列与有界并行调度 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0+ / 权重 4（Codex-style 并行工作增强，不阻塞 P0-A/P0-B）

**目标：** 在 TaskExecutor 和隔离 Worktree 基础上建立有界任务队列与并行调度，使多个 Task 可以排队、后台运行并独立停止；只有执行环境隔离、Runtime 并发能力和资源上限同时满足时才并行写入。队列元数据可持久化，但重启后不自动重放旧执行请求。

**核心数据流：** 用户启动 Turn 后 Scheduler 根据 Task 状态、execution environment、Project 冲突、Runtime capability 和资源策略决定立即运行或排队；每个运行槽持有独立 Adapter/Runtime 实例和 ExecutionSnapshot；Agent 事件、权限请求和命令证据按 taskId/turnId 路由，Artifact/Changes 按 Task/Environment 引用，若 P0-15 已安装则用户终端按 taskId/environmentId/terminalId 路由；终态释放槽并启动下一项。

**约束与边界：** 默认最大并行数为 2，并允许用户在设置中降低但不无限提高；Local 模式同一 Project 的写 Task 串行，Worktree Task 才有资格并行。Runtime 未经实测证明支持多 session/多实例时只能排队，不通过 UI 开关强行并发。应用重启后原 queued/running 一律转为 `interrupted`，用户必须创建或重新提交 Turn；Scheduler 不保存可自动重放的完整 Prompt/执行 payload。

**主要风险：** 多 Adapter 实例、事件串流、权限响应、终端会话和磁盘/CPU 占用可能互相污染；调度键必须包含 taskId、turnId、environmentId、runtimeInstanceId，用户终端另以 terminalId 标识，资源策略和停止操作按各自身份隔离。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest。

---

## 实施范围

**前置依赖：**
- 依赖 P0-08、P0-10、P0-11、P0-14。

**文件范围：**
- 创建 `src/main/agent/task-scheduler.ts`、`runtime-instance-pool.ts`、`task-conflict-policy.ts` 及就近测试。
- 修改 TaskExecutor 为单槽执行单元，由 Scheduler 持有多个实例。
- 创建共享队列 DTO、Scheduler IPC、Renderer 队列/运行状态 UI。
- 修改 Runtime capability matrix，增加有实测证据的并发能力状态。

**安全策略：**
- Scheduler 只接受已创建 Task/Turn，不接受 Renderer 指定 Runtime 进程数、任意 cwd 或越过 Worktree 的并行标志。
- 每个 Runtime 实例使用独立受限环境，均不得把 Provider Secret 传给工具子进程；权限请求绑定具体 Task/Turn/环境。可选用户终端不属于运行槽命令通道，继续按 Task/Environment/Terminal 独立管理。
- 退出、崩溃和取消按槽收束，不因一个任务失败而默认终止或授权其它任务。

### 任务 1: 定义队列、冲突和资源策略

**任务目标：**
- 在启动多个 Runtime 前先固定何时排队、何时允许并行。

**涉及范围：**
- task-conflict-policy、共享状态和策略测试。

**前置依赖：**
- P0-14 提供可靠 Local/Worktree 环境身份。

- [ ] **第 1 步: 定义调度状态**
说明：Turn 状态增加 queued 及 queue position/reason；Scheduler 维护 pending、running slot、paused/blocked 和终态，不重复拥有 Task 历史。
预期：用户能区分“等待资源”“等待其它 Local 写任务”“Runtime 不支持并行”和“等待权限”。

- [ ] **第 2 步: 定义冲突矩阵**
说明：同一 Local execution root 的写 Task 必须串行；不同 Worktree 可并行；未知副作用按写任务处理；不同 Project 仍受全局资源上限。
预期：任何无法证明隔离的组合都排队，而不是乐观并发。

- [ ] **第 3 步: 固定资源上限**
说明：默认最多 2 个运行槽，并限制每 Runtime 实例、终端输出、事件缓冲和任务启动速率；低磁盘或系统压力时停止拉起新槽但不杀死现有任务。
预期：并行不会无界创建子进程或填满磁盘，策略变化有明确 UI 状态。

### 任务 2: 建立 Runtime 实例池与并发能力门禁

**任务目标：**
- 只有实际验证支持时才为多个 Task 创建独立 Runtime 执行实例。

**涉及范围：**
- runtime-instance-pool、Grok Adapter factory、能力矩阵和测试。

**前置依赖：**
- 依赖任务 1 的调度策略。

- [ ] **第 1 步: 定义实例所有权**
说明：每个运行槽获得唯一 runtimeInstanceId 和独立 Adapter/连接/session；实例只服务绑定 Task，不能共享 active turn 或权限状态。
预期：停止 Task A 不调用 Task B 的 cancel，事件和状态无法跨实例串流。

- [ ] **第 2 步: 验证 Grok 并发证据**
说明：用本地/假模型和受控 ACP 环境验证多 Grok 进程或多连接的启动、session、事件、取消、Provider 配置和资源行为；把结果写入 capability evidence。
预期：未通过实测时 Scheduler 自动退化为单槽排队，UI 明确显示原因。

- [ ] **第 3 步: 管理实例创建与回收**
说明：按槽创建、健康检查、复用或销毁实例；Provider/模型快照不同的 Task 不共享实例，异常实例只影响其 Task。
预期：实例退出、连接失败和取消超时不会泄漏进程或占用永久槽。

### 任务 3: 实现可重建队列元数据与独立控制

**任务目标：**
- 让排队与运行事实可审阅，并允许逐 Task 控制；执行 payload 只在当前 App 生命周期内存在。

**涉及范围：**
- task-scheduler、TaskStore、IPC 和故障测试。

**前置依赖：**
- 依赖任务 2 的实例池。

- [ ] **第 1 步: 实现入队和调度循环**
说明：启动 Turn 先持久化不可执行的 queued 元数据（taskId、turnId、environmentId、状态、顺序、阻塞原因和 Prompt 摘要/hash），完整执行请求只保存在当前进程内存；再由单一调度循环原子分配槽，完成/失败/取消后释放并选择下一项。
预期：重复请求不会重复入队，当前 App 生命周期内队列顺序和阻塞原因可查询；磁盘记录本身不足以静默再次执行命令或 Prompt。

- [ ] **第 2 步: 实现逐 Task 停止和移出队列**
说明：停止 queued Task 直接收束为 cancelled；停止 running Task 只调用对应 Executor/Adapter；其它槽保持不变。
预期：用户不会因为停止一个任务而误停全部 Runtime。

- [ ] **第 3 步: 处理应用退出与重启**
说明：正常退出逐槽请求取消并写入终态；重启恢复时，原 queued 和 running 一律标记 `interrupted`，清除内存执行请求。用户只能从历史查看摘要，并通过新的提交动作创建新 Turn，不提供“确认后自动沿用旧 payload”的隐式重放。
预期：重启不会静默或半自动重放旧 Prompt；队列历史、原顺序和中断原因仍可审阅。

### 任务 4: 实现队列与并行工作台体验

**任务目标：**
- 让用户理解多个 Task 的状态、资源和隔离环境。

**涉及范围：**
- TaskList、全局运行中心、TaskHeader、设置和组件测试。

**前置依赖：**
- 依赖任务 3 的 Scheduler API。

- [ ] **第 1 步: 展示全局运行中心**
说明：显示运行槽、排队顺序、Project、Local/Worktree、Runtime/model、耗时、等待权限和阻塞原因；支持跳转和逐 Task 停止。
预期：用户在任意 Task 页面都能找到后台任务，不依赖侧栏小图标猜测。

- [ ] **第 2 步: 展示并发资格和降级**
说明：创建/启动 Task 时说明 Local 将串行、Worktree 可申请并行、Runtime 未验证则排队；设置只允许在安全上限内调整最大槽数。
预期：用户不会误以为打开两个 Task 就一定同时运行，也不能绕过能力门禁。

- [ ] **第 3 步: 完成端到端并行走查**
说明：验证两个 Worktree Task 并行、两个 Local 写 Task 串行、停止其中一个、一个等待权限、一个 Runtime 崩溃，以及应用重启后 queued/running 全部变为 interrupted 并要求重新提交。
预期：每个 Task 的事件、权限、Command Evidence、Diff 和 Artifact 保持隔离；若安装 Terminal，其会话也按 Task/Environment/Terminal 隔离。资源上限有效且旧 Prompt 不会自动执行。

## 验收标准

- [ ] Scheduler 根据 execution environment、Project 冲突、Runtime 实测能力和资源上限决定运行或排队，未知情况默认串行。
- [ ] 默认最多两个运行槽；每个槽拥有独立 Runtime 实例和 Task/Turn/环境身份，事件、权限和停止不会串线。
- [ ] Agent 事件、权限和命令证据按 Task/Turn 路由；可选用户终端按 Task/Environment/Terminal 路由，不把 terminalId 混成 turnId。
- [ ] 同一 Local Project 的写 Task 不并行；隔离 Worktree Task 只有在 Grok 并发证据通过时才并行，否则明确降级排队。
- [ ] 停止、失败和 Runtime 崩溃只影响对应 Task；App 重启后所有旧 queued/running 均转为 interrupted，用户必须重新提交，旧执行 payload 不能被自动重放。
- [ ] 目标 ESLint、相关 Vitest/组件测试、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过，并完成双 Worktree 并行、Local 串行和独立停止的 Electron 走查。
