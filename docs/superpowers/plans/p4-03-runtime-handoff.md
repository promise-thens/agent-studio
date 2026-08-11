# P4-03 Runtime 有界接力 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P4 / 权重 3（分析、实现、审查与失败转交的受控协作）

**目标：** 支持分析→实现、实现→审查和失败转交：用户先预览并编辑有界 `HandoffPackage`，系统重新校验目标 Runtime、binding mode、模型与能力，为目标 Task 分配独立 Worktree，按需把已确认的源结果包物化到新环境，并在任一步失败时保护源任务和已创建资源。

**核心数据流：** HandoffService 从源 Task 的目标、有限 Timeline 摘要、Command Evidence、Changes、Validation、Artifact 和 P0-14 TaskResultBundle 引用生成白名单 package；用户确认目标与字段后，P2-04A 返回新的 TaskLaunchDecision；P4-01 创建 purpose=`handoff` 的目标 child/Worktree；HandoffMaterializer 在新 Worktree 校验并应用已选择结果包，验证完成后由 P4-01 通过 P2-04B/P0-17 启动目标 Turn；源/目标 Task 保存双向关系和终态。

**约束与边界：** 不转交完整对话、完整 Prompt 历史、原始 reasoning、密钥、屏幕、剪贴板、浏览器登录态、原始环境或无限 transcript；权限和长期授权从不继承。变更只可物化到新受管 Worktree，不自动应用回 Local、合并、提交或推送；不能在原 Task 运行中静默换 Runtime。

**主要风险：** package 太少导致重复工作，太多导致敏感泄漏；目标能力在确认后变化；patch 与 base 不匹配；部分 Worktree/文件已创建后启动失败；使用字段/总量上限、来源引用、确认时二次校验、同 base 预检、阶段性启动和 ownership-aware 补偿。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、系统 Git CLI。

---

## 实施范围

**前置依赖：**

- 依赖 P0-B 验收门、P2-04A、P4-01；P4-01 已通过 P2-04B 接入 Scheduler。

**文件范围：**
- 创建 `src/main/agent/handoff-service.ts`、`handoff-package-store.ts`、`handoff-materializer.ts` 及就近测试。
- 创建 `src/shared/handoff.ts`，定义 HandoffPackage、HandoffReference、HandoffTargetDecision 和 HandoffRelation。
- 创建 `src/renderer/src/components/HandoffReview.vue`、`HandoffTargetPicker.vue`，修改 Task history/workbench 关系展示。
- 复用 P2-04A TaskLaunchService、P4-01 Orchestrator、P0-14 Worktree/Delivery、P0-07 Broker 和核心查询服务；不修改 P4-01 让它理解 package 内容。

**安全策略：**
- package 由主进程从白名单事实生成；Renderer 只能编辑允许的文本字段、移除引用和选择目标公开 ID，不能伪造 sourceTaskId/baseCommit/hash/commandId/artifactId 或绝对路径。
- package JSON（不含外部引用内容）最大 256 KiB；objective 最大 8 KiB，contextSummary/planSnapshot 各最大 32 KiB，acceptanceCriteria 最多 20 条且每条 1 KiB，attemptedActions 最多 50 条且每条 2 KiB，unresolvedIssues 最多 20 条且每条 2 KiB，所有 references 合计最多 100 条。
- Artifact/Command/Validation/Changes 只传 ID、kind/title/hash/availability/trust 等引用摘要；目标 Runtime 不自动获得原文件或 transcript 内容。用户选择物化的代码变化使用 P0-14 TaskResultBundleRef，且必须来自相同 Project/baseCommit。
- 目标 Task 使用新的权限/Provider/Runtime snapshot；源授权、API Key、环境变量和 Capability grant 不进入 package。

### 任务 1: 定义有界 HandoffPackage 与来源引用

**任务目标：**
- 让接收方获得足够、可追溯但有限的上下文，并明确每个事实从哪里来。

**涉及范围：**
- HandoffPackage/HandoffReference schema、package builder、store 和测试。

**前置依赖：**
- 源 Task 已存在可查询的 Project/Task/Turn/Environment、Timeline、Command/Changes/Validation/Artifact 事实。

- [ ] **第 1 步: 定义 package 核心字段**
说明：包含 schemaVersion、packageId、handoffType、sourceTaskId/sourceTurnId/sourceRuntimeId、projectId、sourceEnvironmentId、baseCommit、objective、contextSummary、可选 planSnapshot、acceptanceCriteria、attemptedActions、unresolvedIssues、permissionFactsSummary、reference 列表、可选 resultBundleRef、createdAt、expiresAt 和 immutableSourceHash。
预期：字段、单项数量和总字节上限全部可机械校验；没有 `data`/`rawPayload` 等无限兜底字段。

- [ ] **第 2 步: 定义有来源的引用**
说明：HandoffReference 只允许 command-evidence、validation、change-set、artifact、timeline-event 和 result-bundle；包含 refId、sourceTaskId、kind、title、hash/revision、trust、availability 和有限摘要。Artifact 内容、Diff 全文和 transcript 不内联。
预期：引用失效、截断或 unavailable 时仍可预览事实，不借引用读取其它 Task/Project。

- [ ] **第 3 步: 生成脱敏默认包**
说明：从源事实按 handoffType 选取最近/关键有限摘要，统一删除 Secret、绝对用户路径和原始环境；permissionFacts 只说明曾批准/拒绝什么，不携带可复用 grant token。
预期：默认包足以解释目标、已做工作、失败点和验证状态，但不会复制完整聊天或无限工具输出。

- [ ] **第 4 步: 持久化不可变来源与可编辑草稿**
说明：store 分开保存 immutable source facts/hash 和用户可编辑 draft；用户可改 objective/context/criteria、移除引用，不能改 source identity/base/hash。确认后生成 package revision，旧 revision 只读。
预期：审计能区分“系统事实”和“用户编辑说明”，重启不会混写。

### 任务 2: 实现预览、目标能力校验与确认

**任务目标：**
- 在创建任何 Worktree 前，让用户看清将发送什么、目标是否能接收以及成本/能力差异。

**涉及范围：**
- HandoffReview、TargetPicker、TaskLaunchService、确认 IPC 和测试。

**前置依赖：**
- 依赖任务 1 的合法 package draft。

- [ ] **第 1 步: 实现 package 预览与裁剪**
说明：按文本、已尝试操作、未解决问题、权限事实、Changes/Validation/Command/Artifact 引用和可选结果包分组；显示大小、截断、失效和敏感边界。用户可编辑允许文本、删除引用或取消。
预期：确认前可完整看见实际 package，不存在隐藏自动附加的完整历史或文件内容。

- [ ] **第 2 步: 生成目标 TaskLaunchDecision**
说明：用户选择 target Runtime、binding mode 和 model 后，调用 P2-04A 校验账号或 App Provider、模型健康、Runtime capability、Worktree、资源和 package 所需能力；只有 app-provider 才选择 profile。返回 allowed/experimental/blocked 和缺失能力列表。
预期：目标不支持图片/工具/原生 resume 等能力时明确降级；blocked 不创建 Worktree，experimental 需再次确认。

- [ ] **第 3 步: 冻结 HandoffTargetDecision**
说明：确认时保存 packageRevision/hash、TaskLaunchDecision ref/version、目标 runtimeBindingSnapshot/model、可选 app-provider profile、需要物化 result bundle 与否、预算和新的权限策略；随后再次检查 package 未过期、source/base 未变化。
预期：确认后设置变化不会静默改写目标，过期/漂移要求重新预览。

### 任务 3: 分配目标 Worktree、物化结果并启动

**任务目标：**
- 只在新受管环境中重建已确认源结果，验证成功后才让目标 Runtime 开始工作。

**涉及范围：**
- P4-01 request adapter、HandoffMaterializer、TaskResultBundle、Broker 和故障测试。

**前置依赖：**
- 依赖任务 2 的 confirmed target decision。

- [ ] **第 1 步: 通过 P4-01 分配目标 child**
说明：提交 purpose=`handoff`、projectId/baseCommit、startMode=`prepared` 的单个 ChildTaskLaunchSpec、packageRef/hash 和幂等键；P4-01 创建独立 Worktree/Task，但不创建目标 Turn，child 保持 `preparing`，未物化完成前不能入队执行。
预期：重复确认不创建第二个目标 Task；源 Task/environment 完全不变。

- [ ] **第 2 步: 预检并物化 selected result bundle**
说明：若 package 含 resultBundleRef，验证 manifest project/base/hash、tracked patch、untracked 清单和容量；先执行 `git apply --check` 等无写预检并确认 untracked 无冲突，再在目标 Worktree 应用 binary patch和复制普通 untracked 文件，完成后比较 manifest/hash。无结果包的分析→实现接力跳过本步。
预期：实现→审查目标看到与源交付一致的代码状态；任何 base/path/hash/冲突错误在目标 Runtime 启动前停止，绝不写原工作区。

- [ ] **第 3 步: 创建双向关系并启动目标 Turn**
说明：物化验证成功后写 HandoffRelation（sourceTaskId、targetTaskId、packageId/revision、type、状态），调用 P4-01 `activatePreparedChild` 校验 package hash，将有界 package 作为目标 Task 的首个 Turn 上下文，再由 P4-01 通过 P2-04B/P0-17 调度；目标重新走自己的权限流程。
预期：源/目标历史可互相跳转，目标 Runtime 不继承源 session、授权或 Secret。

- [ ] **第 4 步: 实现阶段性失败补偿**
说明：Worktree 创建前失败不产生资源；创建后、目标未启动且环境仍 ownership 匹配/clean 时可经 P4-01/P0-14 清理；已物化、dirty、unknown 或已启动时标记 partial/cleanup-pending 并让用户选择保留、导出或清理。任何失败保留源 Task 和原 result bundle。
预期：补偿不会为了恢复“事务感”强删未知修改；用户能看到每个已创建资源和下一步。

### 任务 4: 完成三类接力、恢复与安全走查

**任务目标：**
- 证明 package、能力、环境和补偿在真实使用与重启后仍可信。

**涉及范围：**
- Handoff UI、store/relation 恢复、集成测试和 Electron 走查。

**前置依赖：**
- 依赖任务 1 至任务 3。

- [ ] **第 1 步: 验证分析→实现**
说明：源 Task 只提供目标、摘要、计划/验证引用，无 result bundle；目标在相同 base 的新 Worktree 启动并独立执行。
预期：目标不需要完整聊天也能理解目标；缺失上下文可回到 source refs，不获得源授权。

- [ ] **第 2 步: 验证实现→审查**
说明：源 Worktree 导出 tracked/untracked result bundle，目标从相同 base 创建新 Worktree并物化，执行审查/验证；覆盖 binary/untracked、Artifact 失效和 package 裁剪。
预期：目标审查的是可复核源结果，原工作区和源 Worktree 不被目标修改。

- [ ] **第 3 步: 验证失败转交与拒绝接收**
说明：覆盖源 Runtime 失败/超时、目标能力 blocked/experimental、用户取消、base 漂移、patch 冲突、第二阶段写入失败、目标启动失败和 target permission 拒绝。
预期：每一失败都有明确 source/target/group/Worktree 状态，不丢源结果或扩大权限。

- [ ] **第 4 步: 验证重启和关系恢复**
说明：在 draft、confirmed、preparing、materialized、running 和 partial 阶段分别模拟重启；从 PackageStore、GroupStore、TaskStore、WorktreeRegistry 重建，并沿用 P2-04B/P0-17 的 interrupted 规则，不自动继续危险写步骤或重放 Prompt。
预期：需要用户重新确认的阶段明确暂停，已运行 Task 按 Scheduler 规则 interrupted，关系和资源仍可审阅。

## 验收标准

- [ ] HandoffPackage 有明确 schema、字段/数量/总字节上限和来源 hash；不包含完整对话、原始 reasoning、Secret、环境、屏幕/剪贴板或无限 transcript。
- [ ] Artifact、Command、Validation、Changes 和 result bundle 通过有界引用传递；目标不能借引用读取其它 Project/Task 或自动取得原始内容。
- [ ] 目标 Runtime/runtime binding/model/capability/Worktree 在确认时重新验证；account-backed 不要求 Provider Profile，源授权和 session 不继承，设置或 base 漂移要求重新确认。
- [ ] 代码变化只物化到相同 base 的新受管 Worktree，预检和 hash 验证通过后才启动目标 Runtime；不自动应用回 Local、合并、提交或推送。
- [ ] 创建、物化、启动任一阶段失败都有 ownership-aware 补偿；dirty/unknown/已启动环境不会被强制删除，源 Task/Worktree/result bundle 始终保留。
- [ ] 分析→实现、实现→审查、失败转交、拒绝/取消、重启恢复和部分失败均有真实 Electron 走查；目标 ESLint、相关 Vitest/集成与组件测试、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过。
