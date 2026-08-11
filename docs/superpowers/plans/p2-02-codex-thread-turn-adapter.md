# P2-02 Codex Thread、Turn 与原生恢复适配 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P2 / 权重 5（第二 Runtime 的任务、上下文和恢复边界）

**目标：** 将 Codex app-server 的 Thread、Turn、Item 和原生恢复能力映射到 Agent Studio 的 Project、Task、Turn、RuntimeSessionRef 与 AgentEvent；同一 Task 可以连续执行多个 Turn，fork 必须创建新的产品 Task、新的 RuntimeSessionRef 和独立环境引用。

**核心数据流：** AgentService 创建并持有产品 `taskId`、本地 `turnId` 和 Task 启动快照；CodexThreadTurnAdapter 根据 Task 的 `environmentId` 解析 cwd、sandbox 与 approval policy，再调用已验证的 `thread/start`、`thread/read`、`thread/resume`、`thread/fork`、`turn/start` 和 `turn/interrupt`。Codex 原生 ID 只作为主进程受限引用保存，事件经过 Codex mapper、P0-02 normalizer 和 TaskStore 后供实时工作台与历史回放共同消费。

**约束与边界：** Task 是用户可见历史主键，Codex Thread 不是独立侧栏对象；fork 不得原地替换源 Task 的 RuntimeSessionRef。打开本地历史不依赖 Codex 在线，原生 resume 只有在账号、协议、Thread、执行环境和能力证据都有效时开放。不在 shared 或 Renderer 暴露 Codex 原始 Item、Thread ID、Turn ID、cwd、sandbox 或 approval policy 原值。P2-03 完成前，命令、文件修改、Diff 和实际审批仍标记 unsupported/unverified，基础 Turn 成功不得宣称完整 Agent 兼容。

**主要风险：** RPC 响应与通知可能交错、断线可能发生在请求已发送但未确认之后、Thread 或 execution root 可能外部漂移、fork 可能错误复用源 Task/Worktree；使用主进程 operation ledger、requestId/幂等键、稳定事件身份、状态单向收束、每次操作前重新解析环境，以及“无法确认则只读或拒绝”规避。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、Codex app-server 当期官方 schema 与本机实测 fixture。

---

## 实施范围

**前置依赖：**

- 依赖 P0-A 验收门、P2-01。
- P2-01 已提供独立 app-server 生命周期、账号状态、协议版本、transport 和能力快照。
- Local 环境可以独立验收；Worktree fork 只有在 P0-14 可用时开放，并且必须为新 Task 创建新的 environmentId。

**文件范围：**

- 创建 `src/main/runtime/codex/codex-thread-turn-adapter.ts`、`codex-event-mapper.ts`、`codex-operation-ledger.ts` 及就近测试。
- 修改 `codex-app-server-adapter.ts`，复用 P2-01 的 transport，不创建第二条 app-server 连接。
- 修改 AgentService、TaskExecutor、TaskStore 和 Runtime capability matrix。
- 扩展中性 `RuntimeSessionRef`、`RuntimeResumeAvailability`、`TaskForkRelation` 和有限 Runtime 操作结果；Codex 原始 schema 只留在 `src/main/runtime/codex/`。
- 扩展固定 Agent/Task IPC、Preload API 和 Task 工作台的继续、分叉与只读原因状态。

**安全策略：**

- 每次 start、resume、fork 和 turn/start 前，主进程都从 `environmentId` 重新解析 canonical execution root；Renderer 不能提交 cwd、sandbox、approval policy 或原生 ID。
- cwd、sandbox 和 approval policy 由不可变 Task 快照、ExecutionEnvironmentRef、P0-07 策略与已验证 Codex capability 共同生成；无法准确映射时拒绝可写 Turn，不使用宽松默认值。
- Permission Broker 不是 Codex 进程沙箱；P2-02 只固定原生 sandbox/approval 配置，Codex 实际上报审批和副作用由 P2-03 映射。
- RuntimeSessionRef、operation ledger 和错误落盘前限长、脱敏；不保存 Token、完整 reasoning、原始环境、无限 Item payload 或可自动重放的 Prompt。
- 创建资源类操作在结果未知时不得盲目重试；先通过只读协议操作对账，无法确认时保持 `unknown`。

## 已锁定对象所有权

- `projectId`、`taskId`、本地 `turnId` 由 AgentService 创建；TaskStore 持有 Task、Turn、RuntimeSessionRef、TaskForkRelation、历史事件和恢复状态。
- Codex Thread ID、原生 Turn ID 和 Item ID 仅存在于主进程受限引用或 Adapter 内部映射中。
- 一个 Task 在任一时刻最多绑定一个当前 RuntimeSessionRef；一个本地 Turn 最多绑定一个 Codex 原生 Turn，绑定后不可被重试改写。
- TaskExecutor 是活动 Turn 执行槽的唯一所有者；Codex Adapter 不复制 running、cancelling 或 terminal 状态。
- fork 必须创建新 `taskId`、新 RuntimeSessionRef 和 TaskForkRelation；源 Task、源 Thread 和源历史保持不变。
- Worktree 不能被两个 Task 共同持有；Worktree fork 必须通过 P0-14 创建新的受管环境，不能复用源 Worktree。

## 已锁定操作语义

- `thread/start` 仅用于尚无 RuntimeSessionRef 的新 Task，成功后才原子发布 Thread 引用。
- `thread/read` 只读获取原生快照用于对账，不得覆盖本地不可变 Turn 历史。
- `thread/resume` 只恢复原生上下文和订阅，不自动创建或执行新 Turn。
- `thread/fork` 从源 Thread 创建新 Thread，并绑定新的 Agent Studio Task。
- `turn/start` 在 AgentService 创建本地 Turn、TaskExecutor 占槽后才发送。
- `turn/interrupt` 只针对当前匹配的活动 Turn，重复调用幂等。
- 应用重启后旧 running/queued 状态按 P0-08/P0-17 转为 interrupted；resume 不重放旧 Prompt、命令或审批。

### 任务 1: 冻结协议、引用与幂等契约

**任务目标：**

- 用官方 schema 和本机 fixture 定义 Thread/Turn 操作、引用关系和未知结果处理。

**涉及范围：**

- 协议 fixture、RuntimeSessionRef、operation ledger、能力矩阵和契约测试。

**前置依赖：**

- P2-01 已完成 app-server 初始化、版本协商、账号状态和受控 transport。

- [ ] **第 1 步: 冻结方法与通知矩阵**

说明：逐项记录 `thread/start/read/resume/fork`、`turn/start/interrupt` 的请求、响应、错误和关联通知；记录 Message、允许展示的 Reasoning 摘要、Plan、Usage、Item 状态与 Turn 终态的真实字段、大小和版本。

预期：协议未验证字段不进入通用 DTO，unsupported 能力有明确降级。

- [ ] **第 2 步: 定义受限 RuntimeSessionRef**

说明：引用保存 runtimeId、受限 Thread 引用、协议版本、账号/Runtime binding 摘要、environment fingerprint、能力证据、最近确认时间和 availability；Renderer 只获得 resumable、read-only 或 unavailable 摘要与原因码。

预期：Renderer 数据无法伪造 Thread、原生 Turn 或跨 Task 引用。

- [ ] **第 3 步: 定义 TaskForkRelation**

说明：关系包含 sourceTaskId、targetTaskId、sourceTurnId、sourceSessionRef hash、fork operationId、目标 environmentId、创建时间和状态；源/目标分别保存有限正向和反向引用。

预期：分叉后可以互相跳转，但标题、环境、RuntimeSessionRef、Turn 和权限完全独立。

- [ ] **第 4 步: 实现 CodexOperationLedger 契约**

说明：每次操作记录 operationId、requestId、kind、taskId、可选 turnId、请求 hash、状态 created/sent/acknowledged/succeeded/failed/unknown、协议关联 ID 和有限错误。只读 read 可安全重试；start、fork 和 turn/start 在 sent 后断线时先标记 unknown，不自动再次发送。

预期：重复 IPC、双击、Renderer 重建和 transport 重连不会重复创建 Thread、Task 或 Turn。

### 任务 2: 实现环境绑定的 Thread 创建、读取与恢复

**任务目标：**

- 确保所有原生生命周期操作绑定正确 Project、Task 和 execution environment，并在漂移时停止写入。

**涉及范围：**

- Adapter、ExecutionEnvironmentResolver、AgentService、TaskStore 和测试。

**前置依赖：**

- 依赖任务 1 的 fixture、引用模型和 operation ledger。

- [ ] **第 1 步: 生成 Codex 执行上下文**

说明：从 environmentId 解析 canonical root、Project identity、Local/Worktree、base/ownership 和 realpath，再依据 Task 权限策略及 capability 生成内部 cwd、sandbox policy、approval policy 和 environment fingerprint。

预期：目录移动、符号链接替换、Worktree 删除、ownership 变化或策略无法映射时，历史仍可看，但所有写操作在发送前拒绝。

- [ ] **第 2 步: 实现 Thread Start**

说明：新 Task 在 unbound 状态创建 operationId，校验账号和环境后调用 `thread/start`；只有成功响应与必要通知一致时才原子写入 RuntimeSessionRef。

预期：新 Task 只创建一个 Codex Thread，失败或结果未知不会发布假 ready 引用。

- [ ] **第 3 步: 实现 Thread Read**

说明：验证引用、版本和 Task ownership 后调用 `thread/read` 获取有限快照，用于恢复判断和历史对账；冲突、缺失或截断只追加 reconciliation 状态。

预期：原生读取不会删除、重排或重写本地 TurnRecord 和 AgentEvent。

- [ ] **第 4 步: 实现 Thread Resume**

说明：打开 Task 时先展示本地历史；用户显式继续后，验证账号、协议、Thread、environment fingerprint、当前 root 和 resume capability，再调用 `thread/resume`。成功只更新 availability 和最近确认时间，不启动 Turn。

预期：Thread 缺失、账号退出、版本不兼容、root 漂移或 Worktree 不存在时进入只读状态，不创建替代 Thread。

### 任务 3: 实现 Fork、Turn 与事件收束

**任务目标：**

- 用跨本地/原生状态机完成安全 fork 和多轮执行，并把流式事件稳定进入现有核心。

**涉及范围：**

- AgentService、TaskExecutor、Adapter、event mapper、TaskStore 和测试。

**前置依赖：**

- 依赖任务 2 的有效 RuntimeSessionRef 和环境上下文。

- [ ] **第 1 步: 实现 Fork 创建事务**

说明：先预留新的 targetTaskId 和 creating TaskRecord，再创建目标 ExecutionEnvironmentRef；Worktree 模式必须先由 P0-14 创建独立 environmentId。随后发送 `thread/fork`，取得新 Thread 后原子绑定 RuntimeSessionRef、TaskForkRelation 并把目标 Task 改为 ready。

预期：环境失败时不调用 fork；fork 失败时源 Task 不变并安全处理未使用环境；响应未知时目标保持 unknown，不能盲目再次 fork。

- [ ] **第 2 步: 实现 Turn Start 原子入口**

说明：AgentService 校验 Task ready、无活动 Turn和环境可用后创建本地 turnId/requestId；TaskExecutor 占槽后 Adapter 才调用 `turn/start`。原生 Turn ID 与本地 turnId 单向绑定，早到通知进入有界缓冲等待绑定。

预期：双击、重复请求和响应/通知交错只产生一个本地 Turn 与一个原生 Turn。

- [ ] **第 3 步: 实现 Interrupt 与终态**

说明：停止请求校验 taskId、turnId 和原生引用后调用 `turn/interrupt`；处理已完成、Thread 消失、transport 断开和超时，最终由 TaskExecutor 统一进入 cancelled、failed 或 interrupted 并释放执行槽。

预期：旧 Turn 或其它 Task 不会被误停，取消超时不会留下永久 running。

- [ ] **第 4 步: 映射安全 Item 与 Side-effect Gate**

说明：只映射 Message、允许展示的 Reasoning 摘要、Plan、Usage 和已验证生命周期 Item；稳定身份至少包含 taskId、本地 turnId、原生 itemId 与事件类别。P2-03 完成前，遇到命令、文件、Diff 或审批 Item 必须发布明确 unsupported 事件并安全停止/失败，不能默认允许、吞掉或丢弃。

预期：started/delta/completed 更新同一节点；未知副作用不会绕过核心服务。

- [ ] **第 5 步: 处理断线与对账**

说明：transport 重连后先读取 operation ledger 和 TaskStore，再使用只读方法对账；按稳定身份补充缺失事件，不把完整 native history 当作新实时事件重放。

预期：请求前、发送后未确认、流式中和终态通知后断线均可区分，无法确认时显示 unknown/interrupted。

### 任务 4: 分离本地历史与原生恢复并完成验收

**任务目标：**

- 没有 Codex Runtime 时仍可审阅历史，有能力时才能继续或分叉。

**涉及范围：**

- TaskStore、恢复查询、固定 IPC、Preload、Task UI、测试和 Electron 走查。

**前置依赖：**

- 依赖任务 1 至任务 3。

- [ ] **第 1 步: 持久化有界事实**

说明：保存 RuntimeSessionRef、Turn 关联、operation 终态、TaskForkRelation、规范化展示事件和 availability；不保存可执行 RPC、完整 Prompt payload、原始 Item、Token 或无限日志。启动时未终态 operation/Turn 转为 unknown/interrupted。

预期：磁盘历史可独立查看，但不足以静默执行 Thread、fork 或 Turn。

- [ ] **第 2 步: 固定恢复原因码**

说明：返回 resumable/read-only/unavailable，至少覆盖 runtime-offline、account-required、thread-missing、protocol-incompatible、environment-missing、environment-drift、worktree-ownership-mismatch、capability-unverified、active-turn 和 operation-unknown。

预期：UI 能区分历史可看、暂时不能继续和必须创建新 Task。

- [ ] **第 3 步: 建立固定 Task 操作 IPC**

说明：只提供 resume、fork、startTurn 和 interrupt；Renderer 只能提交 taskId、允许的目标环境选择、Prompt 和 operation revision，不能提交原生 ID、cwd、sandbox 或 approval policy。Handler 复用 P0-04 来源与 UTF-8 校验。

预期：过期 revision、跨 Project taskId、子 frame 和重复请求在触达 app-server 前拒绝或幂等返回。

- [ ] **第 4 步: 完成自动测试与真实走查**

说明：Mock 覆盖 start/read/resume/fork、多 Turn、重复 requestId、早到/乱序事件、发送后断线、重复 interrupt、Thread 缺失、账号退出、版本不兼容、目录移动、符号链接替换、Worktree 移除、fork 部分失败和 side-effect Item。真实走查仅使用只读或无工具副作用 Prompt，验证新 Task、第二轮、重启只读、resume、fork 和 interrupt。

预期：基础 Turn 成功不会把 Codex 标记 Agent-compatible，Task/Thread/Turn、环境、事件和恢复语义有可复现证据。

## 验收标准

- [ ] AgentService/TaskStore 是 taskId、本地 turnId、RuntimeSessionRef 和 TaskForkRelation 的唯一产品事实源；Codex Adapter 不生成产品 Task 身份。
- [ ] 同一 Task 的多个 Turn 复用同一 Codex Thread；fork 创建新 Task、新 RuntimeSessionRef 和独立环境引用，源 Task/Thread 保持不变。
- [ ] start、resume、fork 和 turn/start 每次都从 environmentId 解析 cwd、sandbox 与 approval policy；root 漂移或策略无法映射时禁止写入。
- [ ] operation ledger 与幂等规则阻止重复 Thread、fork 和 Turn；发送后结果未知时不盲目重试或重放 Prompt。
- [ ] Message、Reasoning 摘要、Plan、Usage、Item 和终态使用稳定身份进入既有 AgentEvent/TaskStore，不存在第二套 Codex 时间线。
- [ ] 打开本地历史不依赖 app-server；Thread 缺失、账号退出、版本不兼容或环境漂移后仍可只读审阅。
- [ ] P2-03 完成前，Codex 命令、文件修改、Diff 和实际审批保持 unsupported/unverified，未知副作用 Item 不会被默认允许或吞掉。
- [ ] Renderer 无法获取或提交原生 ID、cwd、sandbox、approval policy、Token 或原始 Item payload。
- [ ] 新增核心函数、状态机、环境映射、IPC Handler 和异常降级均有中文 TSDoc；测试只使用假凭据、本地 Mock 和临时目录。
- [ ] Node.js 20+、pnpm 10.x 下通过目标/完整 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check`，并完成真实 Codex 多轮、resume、fork、interrupt 和只读降级 Electron 走查。
