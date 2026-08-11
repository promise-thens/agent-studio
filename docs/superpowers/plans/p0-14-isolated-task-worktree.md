# P0-14 隔离 Task Worktree 与结果交付 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0-B / 权重 5（隔离执行并把结果安全交给用户）

**目标：** 为单 Runtime Task 提供可选受管 Git Worktree，使 Agent 不写入用户当前工作目录；任务结束后可导出带 base commit 的 tracked/untracked 结果包，或显式在 Finder/终端打开受管 Worktree，形成可审阅、可带走但不自动合并的交付闭环。

**核心数据流：** 用户创建 Task 时选择 Local 或 Worktree；主进程验证 Git 项目和 base commit，经 Permission Broker 创建受管 detached worktree并固定 ExecutionEnvironmentRef；Runtime、Git Review 和 Artifact 只从 environmentId 解析 execution root；结束后 DeliveryService 基于同一 base 生成 tracked patch、受限 untracked 文件和 manifest，用户选择导出、打开、保留或清理。

**约束与边界：** Worktree 从已提交 commit 创建，不自动包含用户当前未提交修改；不自动创建/切换用户分支，不 stash/reset/clean 原工作区，不自动应用回 Local、合并、提交或推送。结果导出是本地显式操作，不上传；非 Git Project 只能使用 Local。P0-15 用户终端和 P0-16 HTML 可在之后消费本环境，但不阻塞本计划验收。

**主要风险：** 路径逃逸、错误仓库、磁盘占用、用户误以为脏改动已带入、导出遗漏 untracked/binary 文件、结果包含敏感内容和强制清理丢失结果；受管根、ownership、base manifest、导出预览、文件/字节上限和清理前复核必须同时成立。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、系统 Git CLI、Electron Shell/Dialog API。

---

## 实施范围

**前置依赖：**
- 依赖 P0-07、P0-08、P0-10、P0-11、P0-12、P0-13。

**文件范围：**
- 创建 `src/main/git/task-worktree-service.ts`、`worktree-registry.ts`、`worktree-delivery-service.ts`、`task-result-bundle-store.ts` 及就近测试。
- 扩展 ExecutionEnvironmentRef、Task 创建 IPC、TaskExecutor、Git Review、Artifact Registry 和 Task 工作台。
- 创建 Worktree 选择/状态/交付/保留/清理 UI。
- 复用 P0-11 AppCommandRunner 执行固定的“在终端打开”平台 action；不新增任意 Shell IPC。

**安全策略：**
- 所有 Git 命令使用参数数组和解析后的仓库根；受管目录固定在 App 专属 worktree 根下，路径片段由随机 ID/内部 ID 生成，不直接使用 Prompt。
- 创建、生成/导出结果包、打开外部终端、保留和清理均绑定明确 Task/environment；写入用户选择的导出目录使用一次性 `export-result` OperationIntent 和精确目标，不形成项目外通用写权限。清理包含任何未提交内容时不自动强制删除。
- Runtime 和 AppCommandRunner 不继承 Provider Secret，cwd 永远来自 environmentId；Renderer 不能提交 managedPath 或导出源路径。
- 结果包先在 App 专属 `0700` staging root 生成不可变快照，bundle 文件尽量使用 `0600`；默认 30 天、单包 512 MiB、全局 2 GiB 和 2000 文件上限，活动 Handoff 引用不可淘汰。内容只包含 `git diff --binary <baseCommit> --`、`git ls-files --others --exclude-standard` 返回的安全普通文件、manifest 和引用摘要，不包含 ignored 文件、`.git`、符号链接目标、Secret 环境或原始无限日志。
- 用户导出时选择本地目标父目录，App 从已验证 snapshot 新建唯一子目录且不覆盖已有文件；staging/导出失败不把半成品标为可用。
- 文件内容保持原样以保证 patch 可用，不宣称自动脱敏源码；导出前必须展示文件列表、排除项、总大小和“内容可能包含敏感信息”的本地保存提示。

### 任务 1: 定义 Worktree 生命周期与注册表

**任务目标：**
- 建立可恢复、可审计的环境身份和状态机。

**涉及范围：**
- WorktreeRecord、ExecutionEnvironmentRef、registry 和测试。

**前置依赖：**
- P0-06 Task/环境模型和 P0-12 Git root 已稳定。

- [ ] **第 1 步: 定义 WorktreeRecord**
说明：包含 environmentId、projectId、taskId、repo identity、repoRoot 受限引用、managedPath 内部引用、baseCommit、createdAt、状态、ownership token、最近 Git 状态、磁盘占用和保留原因。
预期：每个受管路径只归属一个 Task；Task 无法切换到其它 Worktree，Renderer 不获得可篡改绝对路径。

- [ ] **第 2 步: 固定生命周期**
说明：状态包含 creating、ready、in-use、completed-dirty、completed-clean、retained、cleanup-pending、removed、error；非法迁移拒绝，交付记录独立保存 exported/opened 状态。
预期：应用重启后能识别遗留 Worktree，未知目录不被自动接管或删除。

- [ ] **第 3 步: 建立受管根与磁盘策略**
说明：使用 App 专属目录和随机/ID 派生路径，创建前检查父目录、剩余空间、同路径占用和仓库 ownership；记录总占用供用户查看。
预期：路径不可逃逸，不会在项目根或用户任意目录创建隐藏 Worktree。

### 任务 2: 实现受控创建与消费者绑定

**任务目标：**
- 从明确 base commit 安全创建 detached Worktree，并原子绑定所有 P0-B 消费者。

**涉及范围：**
- TaskWorktreeService、Permission Broker、Task 创建流程、Git Review、Artifact Registry 和测试。

**前置依赖：**
- 依赖任务 1 的注册表。

- [ ] **第 1 步: 执行创建前检查**
说明：验证 Project 为 Git、base ref 解析为 commit、受管路径不存在、仓库未处于危险操作；若原工作区有未提交修改，明确提示它们不会进入新 Worktree。
预期：用户在创建前看见 base commit、目标受管位置摘要和“不包含本地脏改动”边界。

- [ ] **第 2 步: 创建 detached Worktree**
说明：经 Broker 允许后调用参数化 `git worktree add --detach`，验证实际路径、ownership 和 HEAD，再写 WorktreeRecord；任一步失败执行有限补偿但不强制删除未知内容。
预期：创建成功后 Task execution root 与 Worktree HEAD 一致，失败不会留下被标为 ready 的半成品。

- [ ] **第 3 步: 原子绑定消费者**
说明：TaskExecutor、Runtime、P0-12 Git Review 和 P0-13 Artifact 只从 environmentId 解析 execution root；Task 创建后不接受 Renderer 更改路径。P0-15/P0-16 接入时必须复用同一解析接口。
预期：Runtime 修改、Diff 查询和 Artifact 读取都发生在 Worktree，原项目目录内容与 Git 状态保持不变。

### 任务 3: 实现结果包与显式外部打开

**任务目标：**
- 让用户能把 Worktree 结果带走或继续手工处理，而不是只能“保留或删除”。

**涉及范围：**
- WorktreeDeliveryService、TaskResultBundleStore/DTO、AppCommandRunner 固定 action、交付 UI 和测试。

**前置依赖：**
- 依赖任务 2 的稳定环境和 P0-11/P0-12/P0-13 的结果引用。

- [ ] **第 1 步: 定义 TaskResultBundleManifest 与引用**
说明：使用版本化 manifest，包含 bundleId、projectId、taskId、environmentId、baseCommit、当前 HEAD、source status/hash、生成时间、Git 状态摘要、tracked patch hash/size、untracked entry 的相对路径/hash/size、排除项、Validation commandId 引用和 Artifact 引用；`TaskResultBundleRef` 只包含 bundleId、manifestHash、availability、size、createdAt/expiresAt，不暴露 staging 路径。总 JSON 有明确上限且不写绝对路径、Secret 或原始 transcript。
预期：接收者可以确认结果来自哪个 base、包含什么、遗漏什么；P4-03 可以引用同一不可变 snapshot，而不是重新读取已经变化的 Worktree。

- [ ] **第 2 步: 生成 tracked/untracked 不可变 snapshot**
说明：用户请求导出或 Handoff 准备结果时，DeliveryService 重新验证 Task/environment/base/status，在 App staging root 的随机临时目录写入 `manifest.json`、`tracked.patch` 和 `untracked/`。tracked patch 使用 baseCommit 到当前工作树的 binary diff；untracked 仅复制 `--exclude-standard` 返回的普通文件，保持相对路径并应用文件数/单文件/总字节上限，符号链接和超限项进入 excluded 清单。全部 hash/size 校验后原子 rename 并发布 TaskResultBundleRef；失败删除 ownership 明确的临时目录或标记 cleanup-pending，不发布引用。
预期：文本、删除、重命名、binary tracked 变化和允许的 untracked 文件可形成稳定快照；ignored、设备文件、符号链接目标和项目外路径不进入包，超出硬上限时明确失败并保留“打开 Worktree”路径。

- [ ] **第 3 步: 导出已验证目录包**
说明：用户通过主进程目录选择器选定目标父目录并确认精确 `export-result` 意图；App 从 TaskResultBundleRef 对应 snapshot 复制到目标下的唯一 `.partial-<bundleId>` 子目录，复核文件 hash 后 rename 为最终目录，不覆盖已有文件。失败保留可识别 partial 目录并提供重试/打开/清理，不把它标为 exported。
预期：用户导出内容与 Handoff/manifest 引用完全一致；源 Worktree 在导出期间变化不会悄悄混入结果。

- [ ] **第 4 步: 提供 Finder/终端打开动作**
说明：Finder 使用 Electron 固定 Shell API 打开受管目录；终端使用 P0-11 AppCommandRunner 的受信固定平台 action，在用户确认后调用明确 executable/args 打开 managedPath，不执行项目命令，也不接受 Renderer 提交任意路径或 App 名称。
预期：用户可以继续手工检查 Worktree；打开动作有命令证据且不会变成通用 Shell 后门。

- [ ] **第 5 步: 验证结果包可消费性**
说明：测试中使用一次性临时 clone/Worktree，人工或测试 harness 按 manifest 将 tracked.patch 和 untracked 文件应用到相同 base，比较内容 hash；这只是验收，不在产品内自动应用回用户项目。
预期：结果包完整可复核，缺失/超限项在 manifest 中明确，不把测试流程误做成自动合并功能。

### 任务 4: 实现保留、清理、恢复与端到端走查

**任务目标：**
- 在异常和用户外部操作下保护结果，并完成 P0-B 隔离交付验收。

**涉及范围：**
- Worktree service/registry、Task 结果审阅、保留/清理 UI、故障注入和 Electron 走查。

**前置依赖：**
- 依赖任务 1 至任务 3。

- [ ] **第 1 步: 实现完成与显式保留**
说明：Task 完成后读取 Git status、HEAD、磁盘占用、Delivery Bundle 和 Artifact 引用，标记 clean/dirty；用户可标记 retained 并查看 base、占用、bundle/export 状态和打开入口。完成 Task 不自动清理。
预期：应用重启后 retained Worktree 可重新打开对应 Task，不会被容量策略误删。

- [ ] **第 2 步: 实现安全清理请求**
说明：清理前重新验证 ownership、realpath、Git 状态、TaskResultBundle 状态和受影响 Artifact；clean Worktree 可经确认移除，dirty/unknown 默认拒绝强制删除并先提供生成 bundle/导出/保留路径。删除 Worktree 不自动删除仍有效的 bundle snapshot；bundle 由独立保留/容量策略管理。
预期：任何未审阅或未交付修改都不会被后台、退出流程或容量策略静默删除。

- [ ] **第 3 步: 恢复遗留 Worktree**
说明：启动时交叉验证 registry 与 `git worktree list --porcelain`，并验证 BundleStore manifest/hash/expiry；Worktree 缺失、被外部移动、prunable、HEAD 漂移、ownership 不匹配或 bundle 损坏时标记 error/unknown/missing，不自动修复或删除。
预期：Task 历史和仍有效的 bundle 可查看/导出，环境或 bundle 不可用原因准确。

- [ ] **第 4 步: 完成隔离与交付走查**
说明：覆盖非 Git、脏原工作区、磁盘不足、创建中断、Git lock、外部修改、导出失败/重试、tracked/untracked/binary 结果、Finder/终端打开和 clean/dirty 清理；在 Worktree Task 中让 Grok 修改文件、运行命令、生成 Diff/Artifact，并确认原工作区未变化。
预期：用户可以审阅、导出、打开、保留或安全清理；任一失败都不污染原工作区或丢失未知结果。

## 验收标准

- [ ] Worktree 从明确 base commit 创建并原子绑定 Task；用户未提交修改不会被暗中包含，也不会被修改或 stash。
- [ ] Runtime、TaskExecutor、Git Review 和 Artifact 全部从同一 environmentId 解析路径，不接受 Renderer 指定任意 cwd；P0-15/P0-16 后续接入同一接口。
- [ ] App-managed TaskResultBundle snapshot 包含 versioned manifest、tracked binary patch、受限 untracked 文件、明确排除项及 Validation/Artifact 引用；TaskResultBundleRef 不泄漏 staging 路径，并能在一次性相同 base 环境复核。
- [ ] 用户导出复制自同一不可变 bundle snapshot，使用一次性精确目标授权、partial/rename 和 hash 校验；源 Worktree 后续变化不会混入已发布 bundle。
- [ ] 用户可以显式在 Finder/终端打开受管 Worktree；系统不自动应用回 Local、创建/切换分支、合并、提交或推送。
- [ ] Dirty、未知、未交付或 ownership 不匹配的 Worktree 不会被自动强制清理；应用重启可恢复 registry 和交付状态。
- [ ] 目标 ESLint、相关 Vitest/集成测试、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过，并完成 Grok Worktree 隔离与结果交付 Electron 走查。
