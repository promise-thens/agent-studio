# P0-09 执行时间线与结果审阅 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0-A / 权重 4（让长任务可理解、可回放、可接管）

**目标：** 以 Task / Turn 为边界，把实时与历史 AgentEvent 投影为同一套执行时间线、状态摘要和结果审阅入口，让用户知道 Agent 正在做什么、哪里失败、产生了哪些可进一步审阅的结果。

**核心数据流：** 主进程归一化事件按 `taskId` / `turnId` 写入有界历史；Renderer 通过 Task 查询或实时订阅送入同一 timeline reducer；时间线生成 Plan、Tool、Permission、Usage、终态与外部审阅引用，完整 Diff、终端和 Artifact 分别由 P0-12、P0-15、P0-13 提供。

**约束与边界：** 本计划不实现 Git Diff 引擎、终端模拟器、Artifact 文件读取或完整 IDE；只展示已验证、脱敏、限长的数据。没有对应能力或结果时必须显示“未提供/未验证”，不得用空白成功状态伪造完成。

**主要风险：** 高频流式事件、晚到事件和历史回放可能导致状态倒退或 UI 卡顿；沿用 P0-02 sequence/terminal 规则，按 Turn 建立稳定 key、批量刷新和可见窗口限制。

**当前状态：** 真机验收已受限关闭。契约与安全边界、公开事件投影、Timeline reducer/组件已落地。2026-08-18 Windows 补测补齐同一 Task 第二轮、权限允许一次、reload、终态、退出三分支；窗口销毁/重建因 Windows 关最后窗口即退出记为平台限制。完整自动门禁仍以同日 macOS 记录为准。[GACP-01](grokACP计划/gacp-01-real-grok-protocol-verification.md) 已于 2026-08-19 受限关闭；可以开始 GACP-02，P0-10 主体仍要等 GACP-02。详见 [p0-09-real-grok-device-test-plan.md](../testPlans/p0-09-real-grok-device-test-plan.md)。

### 已冻结的事实契约

- Main 内部事件可携带 `runtimeSessionId` 完成 Task / Turn / Runtime 身份校验；Renderer 公开事件和持久化事件禁止包含该字段。
- Main 必须逐字段投影公开事件，Preload 再按事件 kind 白名单重建；TypeScript 类型断言不能替代跨进程运行时校验。
- 正式 Timeline 只消费已提交、可历史回放的事件。当前 live-before-persist 路径将在事件边界迁移后改为 persist-before-publish；达到历史上限时显示明确截断事实，不展示重启后无法回放的正文。
- 历史事件分页使用同一 Turn 内 exclusive numeric `afterSequence` watermark；Task、Turn 和 Permission Audit 的通用字符串 cursor 不与事件 sequence 混用。
- `AgentEvent.sequence`、Task / Turn `revision`、`executorEpoch + executionRevision` 是三个独立版本域，任何 Reducer 不得构造一个替代三者的“统一 revision”。
- 实时权限请求和 `PermissionAuditRecord` 使用各自稳定身份；没有持久化关联 ID 时只在同一 Turn 相邻展示，不根据标题、时间或 operationType 猜测合并。
- Renderer reload 后可以恢复 `waiting-permission` execution 状态和已持久化 Audit，但当前没有 pending approval 查询协议，不得伪造审批卡片或操作按钮。
- Diff、Command Evidence、Validation、Artifact 与 Terminal 只通过有限类型化引用进入 Timeline。P0-12、P0-11、P0-13、P0-15 未实现时必须标记为不可用，不得把完整正文或任意文件读取能力塞入 Timeline。
- P0-09 使用独立 Timeline Electron E2E；P0-08 的 BrowserWindow 重建与 restart interrupted 可并行开发，但必须在 P0-09 最终一致性验收前联合收口。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest。

---

## 实施范围

**前置依赖：**

- 依赖 P0-02、P0-03、P0-06、P0-07、P0-08。

**文件范围：**

- 创建 `src/renderer/src/components/ExecutionTimeline.vue`、`TaskResultReview.vue`、`TurnSummaryCard.vue`。
- 创建 `src/renderer/src/composables/useTaskTimeline.ts`、`src/renderer/src/task-timeline-reducer.ts` 及测试。
- 修改 Task 历史查询、Agent 事件订阅和 `App.vue` 编排；不得把具体时间线逻辑继续堆入 `App.vue`。

**安全策略：**

- Renderer 只接收归一化事件和有限审阅摘要，不接收原始工具请求、完整命令环境、Header 或 Runtime stack。
- 文件路径默认以项目相对路径展示；必须展示绝对路径时先确认它属于 Task 绑定的 execution root。
- 折叠内容展开仍受大小上限约束，不提供“查看原始 payload”后门。

### 任务 1: 建立 Task / Turn 时间线投影

**任务目标：**

- 用同一 reducer 处理实时事件和历史事件，保证状态一致。

**涉及范围：**

- `task-timeline-reducer.ts`、`useTaskTimeline.ts` 和事件消费测试。

**前置依赖：**

- P0-06 可以按 Task 返回有序 Turn 与版本化规范化展示事件，P0-08 可以返回当前执行状态。

- [ ] **第 1 步: 定义时间线节点模型**
      说明：节点至少覆盖用户输入、消息、Reasoning 摘要、Plan、Tool、Permission、Diff 引用、Usage、错误和 Turn 完成；节点键包含 `taskId`、`turnId` 和稳定事件身份。
      预期：同一 Task 多 Turn 不串流，重复事件和晚到终态后普通事件被拒绝。

- [ ] **第 2 步: 实现状态归并**
      说明：执行状态由 P0-08 当前执行快照的 `executionRevision` 与持久化 Turn 状态归并，覆盖短暂 `queued`、`running`、`waiting-permission`、`cancelling`、`completed`、`failed`、`cancelled`、`interrupted`；AgentEvent 只按各 Turn 的 `sequence` 排列消息、Plan、Tool、Permission 引用、Usage、错误和终态内容节点，不能代替执行状态 revision。工具活动按 toolCallId 更新而不是追加重复卡片。
      预期：实时 execution 增量、历史 Turn 状态和 AgentEvent 内容节点各自使用正确顺序来源；实时执行、切换 Task 后重新订阅、重启回放得到相同最终投影。

- [ ] **第 3 步: 控制高频渲染成本**
      说明：对流式文本批量刷新，对长 Task 只渲染可见窗口并保留折叠摘要；不得丢失终态、权限和错误节点。
      预期：大批事件下输入区和停止按钮仍可操作，时间线不会持续全量重算。

### 任务 2: 实现执行时间线组件

**任务目标：**

- 让用户快速判断当前步骤、等待原因和失败位置。

**涉及范围：**

- `ExecutionTimeline.vue`、`TurnSummaryCard.vue`、现有 Plan/Tool 视图迁移。

**前置依赖：**

- 依赖任务 1 的稳定投影。

- [ ] **第 1 步: 展示分层时间线**
      说明：按 Turn 分组展示用户输入、Plan、工具活动、权限等待、回复和终态；默认折叠冗长 Reasoning 与完成工具详情。
      预期：用户无需阅读所有聊天文本即可说出 Agent 当前步骤和阻塞原因。

- [ ] **第 2 步: 补齐交互状态**
      说明：实现加载、空态、实时更新、历史回放、恢复失败、事件被截断和能力未提供提示；所有图标按钮提供 `title` 或 `aria-label`。
      预期：没有 Diff/Usage 时显示明确原因，不出现空白面板或误导性绿色成功。

- [ ] **第 3 步: 保持桌面可用性**
      说明：复用现有深色变量和响应式布局，小窗口保留 Task 状态与停止入口，支持键盘焦点和 `prefers-reduced-motion`。
      预期：长名称、省略文本和折叠控件均可访问完整信息，动画关闭后不影响理解。

### 任务 3: 建立结果审阅聚合层

**任务目标：**

- 在 Turn 或 Task 完成后提供事实摘要和后续审阅入口，而不是复制各能力的完整 UI。

**涉及范围：**

- `TaskResultReview.vue`、Task 详情 DTO 和历史存储引用。

**前置依赖：**

- 依赖任务 2；外部能力可以尚未实现，但引用协议必须稳定。

- [ ] **第 1 步: 聚合完成事实**
      说明：展示完成状态、耗时、Usage、修改文件计数、验证结果计数、未解决警告和 Artifact 数量；每项注明来源与是否验证。
      预期：结果摘要只根据实际事件或服务返回生成，不从聊天文案猜测成功。

- [ ] **第 2 步: 建立受限审阅链接**
      说明：为 P0-12 Diff、P0-15 终端会话、P0-11 验证证据和 P0-13 Artifact 预留类型化引用；目标能力未实现时展示不可用原因，不在时间线组件自行读取文件。
      预期：P0-11 Command Evidence、P0-12 Git Review、P0-13 Artifact 和 P0-15 Terminal 可以接入而无需重写 Task 时间线数据模型。

- [ ] **第 3 步: 明确风险与下一步**
      说明：聚合未审批操作、未运行验证、无法撤回修改和恢复限制；支持“继续同 Task 下一轮”与“创建新 Task”，两者语义明确分开。
      预期：用户能判断应继续修改、审阅、停止还是保留结果。

### 任务 4: 完成实时与历史一致性走查

**任务目标：**

- 验证时间线不是只在幸福路径好看。

**涉及范围：**

- reducer 测试、组件测试和 Electron 开发版。

**前置依赖：**

- 依赖任务 1 至任务 3。

- [ ] **第 1 步: 覆盖事件边界**
      说明：测试重复、乱序、晚到、截断、权限后取消、工具完成晚于 Turn 收束和 Runtime 断开。
      预期：终态稳定，错误可见，任何旧事件不污染下一 Turn。

- [ ] **第 2 步: 覆盖 Task 切换与重启**
      说明：运行中切换到历史 Task 再返回，完成后重启应用回放同一 Task。
      预期：实时和历史节点顺序、状态与结果摘要一致，不出现跨 Task 混流。

- [ ] **第 3 步: 记录手工验收证据**
      说明：用真实 Grok Task 走查多轮 Prompt、Plan、Tool、权限、取消、失败和成功完成。
      预期：截图或验证记录能证明用户可理解执行过程和最终结果，不把计划完成当作代码完成。

## 验收标准

- [ ] 实时订阅与历史回放使用同一投影规则；同 Task 多 Turn、Task 切换和重启后状态一致。
- [ ] 用户能判断任务正在做什么、等待什么、哪里失败以及有哪些真实审阅结果；缺失能力不会被显示为成功。
- [ ] 时间线不直接读取项目文件、终端输出或 Artifact 内容，所有外部详情都通过受限引用进入对应服务。
- [ ] 高频事件和长 Task 下界面仍可交互，终态、权限和错误不会因批量刷新丢失。
- [ ] 目标 ESLint、相关 Vitest/组件测试、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过，并完成 Electron 实时任务与历史回放走查。
