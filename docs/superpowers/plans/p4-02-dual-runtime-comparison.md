# P4-02 双 Runtime 公平对比 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P4 / 权重 3（Agent Studio 的差异化结果审阅体验）

**目标：** 让用户在同一 Project/base commit 和明确相同输入下，用 Grok 与 Codex 两个独立 Task 完成同一需求，并按方案、Changes、Validation、Command Evidence、Usage、耗时、Artifact 和能力偏差进行可解释比较。

**核心数据流：** 用户在 ComparisonSetup 选择 Project、base、两套由 P2-04A 生成的 TaskLaunchDecision、共享 Prompt、验收标准、验证 action 和预算；ComparisonService 冻结 `ComparisonSpec` 并调用 P4-01 编排两个 child；完成后按 childTaskId 查询核心 Task 事实并生成只读 `ComparisonResultProjection`，ComparisonReview 展示并由用户分别保留、导出、继续或清理。

**约束与边界：** P4-02 独占比较输入、公平条件、维度、结果 UI 和用户选择；不创建 Worktree、Task 或 Runtime 实例，不复制 Scheduler/Task 历史，也不自动评判绝对赢家、合并代码、提交或推送。两侧权限和外部副作用独立审批；条件偏差必须显示，不能隐藏后仍声称公平。

**主要风险：** 基准、Prompt、验证命令、能力、权限或预算不一致制造虚假胜负，双跑产生意外费用和外部副作用；冻结 hash、逐侧预算确认、默认仅本地 Worktree、偏差分类和无自动 winner。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest。

---

## 实施范围

**前置依赖：**

- 依赖 P4-01；P4-01 已依赖 P2-04B，P2-04B 再依赖 P0-17 与 P2-04A。

**文件范围：**
- 创建 `src/main/agent/comparison-service.ts`、`comparison-store.ts` 及就近测试。
- 创建 `ComparisonSpec`、`ComparisonDeviation`、`ComparisonResultProjection` DTO 和固定查询/控制 IPC。
- 创建 `ComparisonSetup.vue`、`ComparisonReview.vue`、`ComparisonDimensionTable.vue` 及测试。

**安全策略：**
- Renderer 只提交公开 ID、Prompt/验收文本和预算选择；主进程重新解析 Project/base、P2-04A TaskLaunchDecision、actionId 和能力证据。
- 双侧 OperationIntent、授权、Runtime 环境和预算相互独立；一侧批准不自动批准另一侧，外部网络/登录态/删除等副作用逐侧确认。
- 比较投影只持有 Task 结果引用和有限摘要，不复制原始命令输出、完整推理、Secret 或无限 Artifact 内容。

### 任务 1: 定义 ComparisonSpec 与公平条件

**任务目标：**
- 冻结唯一可比较输入，并明确哪些差异是变量、哪些差异使结论失真。

**涉及范围：**
- ComparisonSpec、setup validation、store 和测试。

**前置依赖：**

- 两侧均有有效 P2-04A TaskLaunchDecision 和相同 Project/base commit 的 Worktree 资格。

- [ ] **第 1 步: 定义不可变输入**
说明：Spec 包含 comparisonId、projectId、baseCommit、prompt、promptHash、最多 20 条 acceptance criteria、最多 10 个 validation actionId、两侧 launchDecisionRef、binding kind/snapshot ref、Capability snapshot、每侧 token/cost/time budget、createdAt 和 schemaVersion；Prompt/JSON 有明确字节上限。
预期：任一 child 启动后共享字段不可静默改写；修改需求必须创建新 comparison。

- [ ] **第 2 步: 定义偏差分类**
说明：至少覆盖 base/prompt/validation mismatch、Runtime/binding mode/model/profile difference、capability missing、permission divergence、budget exhausted、task interrupted、validation missing 和 result truncated；account-backed 的 Profile 记为 not-applicable，不误报缺失。base/prompt 不一致直接 blocked，其余决定 comparable/limited/not-comparable。
预期：模型/Runtime 本身是被比较变量，但工具、审批和验证条件差异不会被藏起来。

- [ ] **第 3 步: 显示成本与副作用确认**
说明：启动前展示两侧 Runtime/model、预计最多调用/预算、Worktree 隔离、验证 action 和可能外部副作用；用户一次确认启动 group，但每侧高风险操作仍单独审批。
预期：不默认双跑花费，也不会用 group 确认替代具体操作审批。

### 任务 2: 调用 P4-01 并跟踪双 Task

**任务目标：**
- 把冻结的比较规范转成两个独立 child，而不在 ComparisonService 重写环境编排。

**涉及范围：**
- comparison-service、P4-01 request adapter、状态投影和测试。

**前置依赖：**
- 依赖任务 1 的合法 ComparisonSpec。

- [ ] **第 1 步: 生成两个 ChildTaskLaunchSpec**
说明：两侧引用同一 spec/promptHash/base/validation set，各自携带 launchDecisionRef 和 side=`left|right`；向 P4-01 提交 purpose=`comparison` 与幂等键。
预期：ComparisonService 不接触 managedPath、git worktree 命令或 Runtime 进程对象。

- [ ] **第 2 步: 映射运行状态**
说明：从 P4-01 Group 和两个 Task snapshot 生成 allocating/queued/running/partial/completed/cancelled/error；一侧失败或取消不终止另一侧，除非用户显式选择全部停止。
预期：运行状态与单 Task 页面一致，无第三套事件或终态事实。

- [ ] **第 3 步: 检测执行中偏差**
说明：记录权限选择、能力降级、预算终止、验证 action 未执行、Task interruption 和手工外部修改；偏差只追加，不能为了“公平”篡改 Task 历史。
预期：最终结果明确说明实际条件是否仍可比较。

### 任务 3: 生成统一结果投影与比较维度

**任务目标：**
- 使用现有核心事实构建可解释的左右对照，而不是重新计算另一套结果。

**涉及范围：**
- result projection、Task/Changes/Command/Usage/Artifact 查询和测试。

**前置依赖：**
- 至少一个 child 到达终态或可审阅中间状态。

- [ ] **第 1 步: 查询并冻结结果引用**
说明：每侧收集 task/turn terminal state、TaskChangeSet ref、ValidationResult refs、CommandEvidence refs、Usage summary、duration、Artifact refs、permission summary 和 capability evidence；缺失字段保持 unknown/unavailable。
预期：投影不从聊天文案推断测试通过、成本或修改归因。

- [ ] **第 2 步: 定义比较维度**
说明：维度固定为方案摘要、完成状态、文件/行数变化、归因风险、验证通过/失败/未知、命令失败/超时、Usage/费用可信度、耗时、Artifact、权限/外部副作用和偏差；每个值标注 source/trust/truncated。
预期：用户能看见事实差异和数据质量，不出现无来源的综合分数。

- [ ] **第 3 步: 处理变化中的结果**
说明：打开历史 comparison 时重新验证 Artifact/Worktree availability 和当前 Changes，但保留完成时 snapshot；当前状态与完成时状态并列显示，外部变化不回写旧事实。
预期：用户能区分“当时结果”和“现在文件已变化/环境已清理”。

### 任务 4: 实现对比审阅与用户处置

**任务目标：**
- 让用户并排理解两侧结果并独立决定下一步。

**涉及范围：**
- ComparisonReview、DimensionTable、跳转/交付动作和组件/Electron 测试。

**前置依赖：**
- 依赖任务 2、任务 3。

- [ ] **第 1 步: 实现 setup 与运行视图**
说明：Setup 显示共同输入和差异变量；运行时显示两侧 Task 状态、预算、等待权限和停止入口，并可跳转单 Task 详情。
预期：用户始终知道正在比较什么，停止一侧/全部的影响明确。

- [ ] **第 2 步: 实现结果对照**
说明：按固定维度并排显示，支持打开各自 Diff、Command Evidence、Validation 和 Artifact；偏差/unknown/truncated 使用持续提示，不用颜色单独表达。
预期：无数据、失败或一侧未完成时仍可审阅，不虚构赢家。

- [ ] **第 3 步: 提供独立结果处置**
说明：每侧分别调用 P0-14 导出、Finder/终端打开、保留或清理；继续修改创建对应 Task 的新 Turn。用户可记录 preferred side/原因作为本地评估事实，但不会自动应用或合并。
预期：选择结果不会修改另一侧或原工作区，未来 P4-04 只能把用户选择作为有来源的信号。

- [ ] **第 4 步: 完成真实双 Runtime 走查**
说明：覆盖两侧成功、一侧失败/取消/权限拒绝/预算耗尽、验证不一致、Usage 缺失、Artifact 失效和 Worktree 外部变化。
预期：所有条件差异可见，用户未明确操作前没有代码合并、远程副作用重复执行或结果删除。

## 验收标准

- [ ] P4-02 独占 ComparisonSpec、公平条件、比较维度、结果 UI 和用户选择；Worktree/Task/Scheduler 只由 P4-01 编排。
- [ ] 两侧共享相同 Project/base/promptHash/validation set，Runtime/binding mode/model/profile 等变量和执行中偏差始终可见；account-backed Profile 明确为 not-applicable。
- [ ] 比较数据来自 Task、Changes、Command Evidence、Validation、Usage 和 Artifact 既有事实源；缺失/unknown/truncated 不被伪造成分数。
- [ ] 两侧权限、预算、故障和结果处置相互隔离；一侧失败不删除另一侧，group 确认不替代高风险逐项审批。
- [ ] 用户可以分别导出、打开、保留、继续或清理，但产品不自动选择赢家、应用回原项目、合并、提交或推送。
- [ ] 目标 ESLint、相关 Vitest/集成与组件测试、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过，并完成真实 Grok/Codex 对比 Electron 走查。
