# P0-12 项目 Git 基线与变更审阅 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0-A / 权重 5（让 Agent 修改真正可审阅、可归因）

**目标：** 在每个 Task 执行环境开始时记录项目与 Git 基线，并为每个写入型 Turn 保存前后变化检查点，持续区分用户已有改动、本 Task 新增改动和轮次变化，在工作台提供文件列表、Diff、验证摘要及诚实的按轮撤销边界。

**核心数据流：** 主进程解析 Task execution root 与 Git root，创建 `TaskChangeBaseline`；每个写入型 Turn 开始前和终态后读取受限 Git/文件状态，生成 `TurnChangeCheckpoint` 与当前 `TaskChangeSet`；验证摘要只引用 P0-11 已记录的 `CommandExecutionEvidence`；时间线只保存引用，Changes 面板按需向主进程获取有限 Diff；撤销请求经 Permission Broker 校验最新 Turn 检查点、当前哈希、外部漂移和执行环境后执行或降级为手工审阅。

**约束与边界：** 不自动执行 `git add`、`commit`、`push`、`reset`、`stash`、`clean` 或合并；Local 模式中存在用户预先修改或执行后又被用户编辑的文件不得自动覆盖。非 Git 项目提供有限文件变化摘要，不伪造 Git 能力。

**主要风险：** 把用户已有脏改动算作 Agent 修改，或根据过期 Diff 自动恢复覆盖新内容；所有基线和撤销必须绑定 taskId、environmentId、base commit/status、路径与内容哈希，任何漂移都改为只读提示。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、系统 Git CLI。

---

## 实施范围

**前置依赖：**
- 依赖 P0-06、P0-07、P0-08、P0-10、P0-11。

**文件范围：**
- 创建 `src/main/project/project-root-resolver.ts`、`src/main/git/git-review-service.ts`、`task-change-baseline.ts`、`turn-change-checkpoint.ts` 及就近测试。
- 创建 `src/shared/git-review.ts`、受限 Git IPC 和 `src/renderer/src/components/TaskChangesPanel.vue`、`FileDiffViewer.vue`。
- 修改 TaskStore、TaskExecutor、Command Evidence/时间线结果引用和 P0-10 Inspector。

**安全策略：**
- Git 命令使用参数数组和明确 cwd，不拼接 Shell 字符串；所有路径先验证属于 Task execution root 和解析后的 Git root。
- 只读 Git 状态可自动执行；任何写 Git、删除或覆盖文件请求必须经过 P0-07 Broker。
- Diff 输出按文件数、单文件大小、总字节和二进制类型限长，错误返回前脱敏绝对路径和环境信息。

### 任务 1: 解析项目根与任务基线

**任务目标：**
- 为每个 Task 建立不可混淆的 execution root、Git root 和开始状态。

**涉及范围：**
- root resolver、baseline 类型、TaskExecutor 启动流程和测试。

**前置依赖：**
- Task 已绑定 Project 和 ExecutionEnvironmentRef。

- [x] **第 1 步: 解析 canonical execution root**
说明：从 Task 环境引用解析真实目录，识别 Git root、仓库顶层、当前 HEAD、分支/ detached 状态和嵌套仓库；禁止向父目录逃逸。
预期：Local、未来 Worktree、非 Git、子目录打开和嵌套仓库均返回明确类型。

- [x] **第 2 步: 记录 TaskChangeBaseline**
说明：Task 首个写 Turn 前保存 base commit、`git status --porcelain=v2` 摘要、已有 tracked/untracked 路径、必要内容哈希和时间；不把完整用户文件复制进日志。
预期：后续可以明确标记“任务开始前已存在”，而不是把整个当前 diff 归给 Agent。

- [x] **第 3 步: 验证基线失效条件**
说明：检测 Git root 变化、HEAD 被外部切换、路径被替换、Worktree 被移除和项目权限变化。
预期：基线失效后停止自动归因/撤销，保留只读现状并提示重新创建 Task。

### 任务 2: 生成 TaskChangeSet 与验证摘要

**任务目标：**
- 把当前文件变化转为用户可理解、可查询的 Task 结果。

**涉及范围：**
- `git-review-service.ts`、TaskStore、CommandEvidenceStore、共享 DTO 和测试。

**前置依赖：**
- 依赖任务 1 的可靠基线。

- [ ] **第 1 步: 计算变化归因**
说明：比较 baseline 与当前状态，将路径分类为 pre-existing、task-added、task-modified、task-deleted、overlap-unknown、user-changed-after-task；二进制和超大文件只返回摘要。
预期：存在重叠或无法证明归因时使用 unknown，不将其标记为可安全撤销。

- [ ] **第 2 步: 保存 TurnChangeCheckpoint**
说明：写入型 Turn 启动前保存 before revision/hash，终态后保存 after revision/hash、受影响路径、归因摘要、外部漂移状态和前一个 checkpoint 引用；不复制完整项目树或无限文件内容。读取型 Turn 只记录无变化摘要。
预期：每轮变化可以与 taskId、turnId、environmentId 和前后状态唯一对应；崩溃或缺少 after 状态时标记 incomplete，不伪造可撤销。

- [ ] **第 3 步: 提供受限 Diff 查询**
说明：按 taskId/environmentId/file path 请求 unified diff；主进程验证路径、类型和大小，并对截断、二进制、未跟踪文件返回明确状态。
预期：Renderer 不能借 Diff API 读取项目外任意文件，长 Diff 不拖垮 IPC 和 UI。

- [ ] **第 4 步: 关联验证结果**
说明：消费 P0-11 的 `CommandExecutionEvidence` 和 `CommandTranscriptRef`，按真实 commandId、退出码、超时与信任级别生成 pass/fail/unknown；不得根据聊天声明、工具标题或缺失退出码生成通过状态。
预期：Changes 面板的每条验证结论都能跳转到命令证据；未运行、字段缺失、输出截断和 Runtime 上报事实均明确标记。

### 任务 3: 实现 Changes 审阅界面

**任务目标：**
- 让用户在应用内理解任务改了什么，而不是离开应用手工执行 Git 命令。

**涉及范围：**
- TaskChangesPanel、FileDiffViewer、P0-10 Inspector 和组件测试。

**前置依赖：**
- 依赖任务 2 的 TaskChangeSet。

- [ ] **第 1 步: 展示基线与归因摘要**
说明：顶部显示 Git/非 Git、base commit、用户已有修改数量、Task 修改数量、未知重叠和基线失效警告。
预期：用户一眼能区分“打开项目前就脏了”和“本 Task 新改了”。

- [ ] **第 2 步: 实现文件与 Diff 浏览**
说明：文件列表按新增/修改/删除/未知分组，支持懒加载 Diff、行号、长行滚动、截断提示和二进制降级；保留键盘焦点。
预期：大变更仍能逐文件审阅，不把省略内容误认为完整 Diff。

- [ ] **第 3 步: 展示验证和风险**
说明：列出实际命令、来源、退出码、运行时间、失败摘要、transcript 截断状态、未验证文件和不可撤销原因；详情跳转 P0-11 的只读命令证据，不依赖 P0-15 交互终端。
预期：用户能判断是否接受、继续修改或要求 Agent 补验证，并且不会把 Runtime 上报命令误认为 AppCommandRunner 沙箱执行。

### 任务 4: 建立安全检查点与撤销边界

**任务目标：**
- 提供“能撤才说能撤”的恢复体验。

**涉及范围：**
- GitReviewService、Permission Broker、Task 结果操作和测试。

**前置依赖：**
- 依赖任务 1 至任务 3。

- [ ] **第 1 步: 定义可自动撤销条件**
说明：首版只允许自动撤销“最新一个已完成写入型 Turn”，且必须无活动 Turn、checkpoint 链完整、无 pre-existing/overlap、当前路径/内容哈希仍等于该 Turn 的 after 状态、没有外部编辑或环境漂移。更早 Turn、incomplete checkpoint、Local 脏项目或后续 Turn 已修改相同路径时只提供该轮 Diff/patch 和手工说明；P0-14 接入后仍遵守最新轮次和漂移校验。
预期：UI 不会为更早轮次或条件不成立的变化显示可执行一键撤销。

- [ ] **第 2 步: 实现受控恢复请求**
说明：恢复前重新计算最新 Turn 的 after hash、checkpoint 前驱和当前变化，展示目标路径、将恢复到的 before 状态及可能丢失内容，经 Broker 逐次确认；不得调用 broad reset/clean/stash。
预期：外部修改、哈希漂移或路径越界立即拒绝，原项目其它内容不受影响。

- [ ] **第 3 步: 记录撤销后的新事实**
说明：撤销成功后追加 recovery event、新 `TaskChangeSet` 和新的 checkpoint revision，不删除原 Turn、命令证据或历史；撤销失败保留失败原因和当前状态。
预期：历史能说明“哪一轮产生了变化、何时撤销、撤销后文件是什么状态”，不会把过去改写成从未发生。

- [ ] **第 4 步: 覆盖保护场景**
说明：测试干净/脏仓库、未跟踪文件、删除、重命名、二进制、外部编辑、非 Git、嵌套仓库和 Git 命令失败。
预期：同时覆盖最新 Turn 可撤销、更早 Turn 只读、后续轮次重叠、checkpoint incomplete 和撤销后再编辑；任何失败都保留用户文件并给出可理解的下一步。

## 验收标准

- [ ] 每个 Task 都有明确 execution root 和变化基线；用户已有修改、本 Task 修改和未知重叠不会混为一类。
- [ ] 每个写入型 Turn 都有前后 hash/revision 检查点；只能自动撤销最新且无外部漂移的 Turn，更早轮次或漂移后只提供手工 Diff/patch。
- [ ] Changes 面板可按需审阅受限 Diff、验证结果和风险；每条 ValidationResult 都引用真实 commandId，缺失/截断/二进制/unknown 状态清晰可见。
- [ ] 不自动 stage、commit、push、reset、stash、clean 或覆盖不确定内容；不可证明安全时只提供手工审阅。
- [ ] Diff 和 Git IPC 无法读取 execution root 外文件，所有写操作经过 Permission Broker。
- [ ] 目标 ESLint、相关 Vitest/组件测试、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过，并完成干净、脏、非 Git 和外部编辑场景走查。
