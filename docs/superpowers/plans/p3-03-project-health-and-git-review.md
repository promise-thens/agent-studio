# P3-03 高级项目体检与自动化入口 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P3 / 权重 3（在核心 Git 审阅之上补充项目理解）

**目标：** 在 P0-12 已完成的 Git 基线和变更审阅之上，识别项目技术栈、包管理器、脚本、工作区结构和常用验证入口，并将可信的只读发现转为可审阅的项目健康摘要与 Capability action。

**核心数据流：** 用户打开 Project 后，主进程在受限深度内读取已允许的元数据文件；ProjectHealthService 解析技术栈、锁文件、脚本和环境要求，ProjectActionStore 以 opaque projectActionId 保存项目特定的命令事实；摘要进入 Project 概览。用户或 Agent 调用本计划按 P3-01 契约注册的 `run-project-action` ActionDescriptor 时，P3-02 CapabilityExecutor 解析 projectActionId、校验归属并提交 P0-07 Broker，允许后由 P0-11 AppCommandRunner 在 Task execution root 执行，结果回流 Command Evidence、Timeline 和 ValidationResult。

**约束与边界：** 本计划不再实现 Git status、Diff、检查点、撤销或 Worktree，这些分别属于 P0-12/P0-14；不默认安装依赖、扫描全盘、运行任意脚本或上传项目元数据。未知项目可以继续使用基础 Task 工作台。

**主要风险：** 自动识别脚本可能把危险命令包装成“推荐操作”；发现阶段只读，action 必须展示原始命令、cwd、影响和来源，并经过权限策略。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest。

---

## 实施范围

**前置依赖：**
- 依赖 P0-11、P0-12、P3-01、P3-02；不依赖 P0-15 用户交互终端。

**文件范围：**
- 创建 `src/main/capability/project-health.ts`、`project-action-discovery.ts`、`project-action-store.ts` 及就近测试。
- 创建 ProjectHealth/ProjectAction 共享 DTO、Capability 注册和 Renderer 项目概览组件。
- 复用 P3-02 CapabilityExecutor、P0-11 AppCommandRunner/Command Evidence、P0-07 Broker 和 P0-09 Timeline，不新增通用 Shell IPC 或通过 PTY 注入命令。

**安全策略：**
- 扫描只限 Project root 内明确白名单文件和有限目录深度；文件大小、数量和解析时间均有限制。
- 发现脚本不是授权执行；任何 action 仍绑定 Task/environment 并显示命令、cwd 和影响。
- 配置文件中的 Token、registry credential 和环境值进入 Renderer 前统一脱敏。

### 任务 1: 实现受限项目识别

**任务目标：**
- 从常见项目元数据建立可解释的技术栈摘要。

**涉及范围：**
- project health service、解析器和 fixture 测试。

**前置依赖：**
- P0-12 已可靠解析 Project/execution root。

- [ ] **第 1 步: 定义扫描白名单**
说明：覆盖 package manifests、锁文件、Node/工具版本文件、workspace 配置和少量框架标识；限制深度、大小和数量。
预期：不会递归扫描 node_modules、构建产物、用户主目录或 Project 外路径。

- [ ] **第 2 步: 解析技术栈与环境要求**
说明：输出包管理器、Node 版本约束、workspace、框架、测试/lint/build 脚本和冲突警告，并标注来源文件。
预期：多锁文件、缺失版本和未知框架显示不确定，不自行编造推荐命令。

- [ ] **第 3 步: 建立缓存与失效**
说明：按 Project、environment 和元数据 hash 缓存摘要；相关文件变化后失效，Worktree 与 Local 分开。
预期：项目切换和任务隔离不会复用错误摘要。

### 任务 2: 发现并绑定项目级 Project Actions

**任务目标：**
- 将项目已有脚本转为透明、可选择的验证入口。

**涉及范围：**
- action discovery、ProjectActionStore、P3-01 内置 Capability manifest 和测试。

**前置依赖：**
- 依赖任务 1 的解析结果。

- [ ] **第 1 步: 定义 ProjectActionRecord**
说明：项目特定记录包含 opaque projectActionId、projectId、environmentId、来源文件、脚本名、受限 executable/args、cwd 策略、类别、预估副作用、依赖状态、元数据 hash 和 revision；它是 P3-01 静态 `run-project-action` 的受限输入，不重新定义 ActionDescriptor。
预期：用户能看见 action 从哪里来以及实际会执行什么，但 Renderer 不能提交替代命令、cwd 或 Host binding。

- [ ] **第 2 步: 识别 lint/test/typecheck/build/dev**
说明：只从已解析的包管理器和 manifest 生成命令；monorepo action 明确工作包范围，不自动组合多个未验证命令。
预期：无法唯一判断包管理器或脚本时不生成可执行 action。

- [ ] **第 3 步: 绑定统一 Capability Action**
说明：本计划新增一个符合 P3-01 契约的内置 Project Health Manifest，并注册固定 `scan-project-health` 与 `run-project-action` ActionDescriptor；ProjectActionStore 只向调用提供 projectActionId 与 revision。执行必须通过 P3-02 CapabilityExecutor，不能把 Shell、AppCommandRunner 或任意 CommandSpec 暴露为 Capability。
预期：未来 MCP/Skills 可以请求同一个 action contract，但不能自行注册项目命令、绕过 Broker/AppCommandRunner，或把每条脚本伪装成新的通用 ActionDescriptor。

### 任务 3: 接入健康摘要与执行闭环

**任务目标：**
- 在工作台中展示项目事实，并把验证结果回流 Task。

**涉及范围：**
- Project 概览、Task 创建提示、CapabilityExecutor、AppCommandRunner、Timeline/Command Evidence/ValidationResult。

**前置依赖：**
- 依赖任务 2 的 ProjectActionRecord，以及本计划按 P3-01 契约注册的内置 ActionDescriptor。

- [ ] **第 1 步: 展示项目健康摘要**
说明：显示技术栈、Node/pnpm 要求、锁文件、脚本、冲突和最近扫描时间；失败不阻止基础 Task 创建。
预期：用户能看出当前环境是否适合运行项目，未知信息明确标记。

- [ ] **第 2 步: 执行受控 Action**
说明：用户或 Agent 只提交固定 capability/action 身份、projectActionId 和 expectedRevision；主进程从 ProjectActionStore 解析 executable/args/cwd/envPolicy，P3-02 校验 Capability 归属并经 Broker 决策，允许后由 AppCommandRunner 执行。Renderer 不能替换命令、cwd 或通过终端写字符启动。
预期：CommandExecutionEvidence、退出码、超时和 transcriptRef 进入 Timeline 与 ValidationResult，并可追溯 capabilityId/version/actionId。

- [ ] **第 3 步: 验证降级场景**
说明：覆盖非 Node、多个锁文件、monorepo、脚本缺失、依赖未安装、命令失败和超时。
预期：体检失败不会伪造通过，也不会阻止无关只读审阅和聊天任务。

## 验收标准

- [ ] 项目体检只读取 Project 内白名单元数据，输出来源明确的技术栈、版本、workspace 和脚本摘要。
- [ ] Git status、Diff、检查点、撤销和 Worktree 不在本计划重复实现，继续由 P0-12/P0-14 提供。
- [ ] Project Action 展示实际命令、cwd、来源和风险，以 projectActionId/revision 绑定 P3-01 的固定 ActionDescriptor；执行统一经过 CapabilityExecutor、Broker 与 AppCommandRunner，结果进入 Command Evidence 和 Task 时间线，不通过 PTY 输入字符执行。
- [ ] 未知、非 Node 或冲突项目安全降级，不阻止基础工作台，也不编造推荐命令。
- [ ] 目标 ESLint、相关 Vitest/组件测试、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过，并完成多种项目 fixture 和真实 action 走查。
