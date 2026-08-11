# P0-06 Project、Task、Turn 与历史恢复 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0-A / 权重 5（Codex-style 产品对象与可恢复任务底座）

**目标：** 建立桌面端持有的 Project、Task、Turn、RuntimeSessionRef 和 ExecutionEnvironmentRef 持久化模型，保存版本化、有界的规范化展示事件，让任务在重启后可一致回放，并在 Runtime 明确支持时恢复原生上下文继续执行。

**核心数据流：** 用户选择目录后主进程解析 canonical root 并注册 Project；创建 Task 时保存不可变的项目、Runtime、模型和执行环境快照；每个 Turn 的脱敏事件、状态和 Artifact 引用写入版本化本地存储；重新打开先恢复桌面记录，再由 Adapter 独立判断能否恢复 Runtime session。

**约束与边界：** 不持久化 API Key、完整推理、原始命令环境、屏幕、剪贴板或无限日志；“可查看历史”与“可继续 Runtime 上下文”必须分开。删除历史记录不得删除项目文件、Git worktree 或 Runtime 原生历史。

**主要风险：** canonical path 漂移、记录损坏、Runtime session 失效和 schema 演进可能让 UI 与真实执行状态不一致；通过版本化 schema、原子写入、逐条隔离损坏、明确只读降级和能力证据时间戳规避。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、Electron `app.getPath('userData')`。

---

## 实施范围

**前置依赖：**
- 依赖 P0-01、P0-02、P0-05。

**文件范围：**
- 创建 `src/main/project/project-registry.ts`、`src/main/agent/task-store.ts`、`src/main/agent/task-history-service.ts` 及就近测试。
- 修改 `src/shared/agent.ts`，新增 Project / Task / Turn / Runtime 引用和历史 DTO。
- 创建 `src/shared/task-ipc.ts`、`src/renderer/src/composables/useTaskHistory.ts` 和对应测试。
- 修改主进程 AgentService、静态 IPC、Preload API 和最近任务入口。

**安全策略：**
- Project root 由主进程 `realpath` 后保存，Renderer 不得用 task API 读取任意目录。
- 本地索引目录尽量使用 `0700`，记录文件使用 `0600`，写入采用临时文件 + fsync + rename 的原子替换策略。
- 事件、错误、命令摘要和 Artifact 元数据落盘前统一脱敏、限长；Runtime 原始 payload 不落盘。

## 已锁定数据模型

- `ProjectRecord`：`projectId`、canonical root、displayName、注册时间、最近打开时间和安全项目摘要。
- `TaskRecord`：`taskId`、`projectId`、标题、runtimeId、模型快照、权限策略引用、执行环境引用、状态、创建/更新时间。
- `TurnRecord`：`turnId`、`taskId`、经本地敏感信息处理且有界的用户输入展示文本、开始/结束时间、终态、规范化展示事件、Usage、验证和 Artifact 引用；不把该文本作为重启后自动执行载荷。
- `RuntimeSessionRef`：runtimeId、受限 session identifier、能力证据和最近确认时间；只在主进程存储，Renderer 只拿到可恢复状态摘要。
- `ExecutionEnvironmentRef`：`local` 或 `worktree`、绑定根目录的受限引用和基准信息；P0-14 前只正式使用 `local`。
- Task 是用户历史主键；Runtime session 不是独立的侧栏历史对象。

### 任务 1: 建立 Project Registry

**任务目标：**
- 把当前单一 workspace 字符串升级为可持久化、可重新打开的项目注册表。

**涉及范围：**
- `src/main/project/project-registry.ts`、Project DTO、App IPC 和项目列表 UI 数据源。

**前置依赖：**
- P0-05 已提供稳定的 AgentService 和 Task 创建入口。

- [ ] **第 1 步: 定义 canonical Project 身份**
说明：主进程对用户选择目录执行存在性、目录类型、绝对路径和 `realpath` 校验；首次注册生成 `projectId`，后续同一 canonical root 复用记录。
预期：符号链接、重复选择和路径大小写差异不会产生重复 Project；目录不可访问时返回有限错误。

- [ ] **第 2 步: 实现版本化 Project 存储**
说明：在 userData 中保存 Project 列表、最近打开时间和显示名，限制记录数量和字符串大小；单条损坏可隔离，不阻断其它项目。
预期：应用重启后项目列表稳定恢复，删除列表项只删除注册记录而不触碰目录内容。

- [ ] **第 3 步: 验证项目边界**
说明：覆盖目录被移动、权限被撤回、软链接目标变化、重复注册和用户取消选择。
预期：失效项目显示“目录不可用”并允许移除记录，不被误标为正常可执行。

### 任务 2: 定义 Task / Turn 与不可变启动快照

**任务目标：**
- 让同一 Task 聚合多个 Turn，并记录执行时真实使用的环境和模型事实。

**涉及范围：**
- `src/shared/agent.ts`、`AgentService`、`task-store.ts` 和 IPC DTO。

**前置依赖：**
- 依赖任务 1 的 ProjectRecord。

- [ ] **第 1 步: 建立 TaskRecord 与 TurnRecord**
说明：Task 创建时固定 `projectId`、runtimeId、modelId、权限策略和执行环境；每次启动 Turn 新建 TurnRecord，终态后不可再改写其身份字段。
预期：同 Task 多轮按时间排序；Task 标题可单独更新，但历史 Turn 的模型和环境事实不会随当前设置变化。

- [ ] **第 2 步: 区分 Task 与 RuntimeSessionRef**
说明：Runtime session identifier 只保存于主进程受限字段；Task 可以在 session 失效后继续作为只读记录存在。
预期：Renderer 无需管理 Grok/Codex 原生 ID，Runtime session 缺失不会删除 Task 或伪造可继续状态。

- [ ] **第 3 步: 定义状态收束规则**
说明：Task 状态由当前执行控制器更新；P0-08 接入 TaskExecutor 后继续使用同一存储接口。应用异常退出时未完成 Turn 在下次启动标为 `interrupted`，不得继续显示 `running`。
预期：重启后不存在幽灵运行状态，终态不会被旧事件覆盖。

### 任务 3: 实现有界历史与原子写入

**任务目标：**
- 保存足够审阅和恢复 UI 的记录，同时控制磁盘、安全和损坏影响。

**涉及范围：**
- `task-store.ts`、`task-history-service.ts`、脱敏工具和存储测试。

**前置依赖：**
- 依赖任务 2 的版本化 schema。

- [ ] **第 1 步: 定义持久化白名单与上限**
说明：保存经本地 Secret 规则处理的有界用户输入展示文本，以及版本化的规范化展示事件；每条事件至少保留 kind、稳定身份、sequence、状态、有限展示 payload 和截断标记，同时保存 Usage、验证引用和 Artifact ID。为单 Turn 文本、事件数、Task 数和总磁盘占用设置明确上限。
预期：P0-09 可以用这些记录走同一 reducer 得到与实时一致的投影；超限内容有截断标记，环境变量、Runtime 原始 payload 和可自动重放的待执行请求不进入记录。

- [ ] **第 2 步: 实现原子写入和损坏隔离**
说明：采用版本化 envelope、临时文件、权限设置和 rename；读取时逐条验证并把损坏记录移入隔离区，保留可诊断的脱敏原因。
预期：模拟进程中断、磁盘写入失败和单条 JSON 损坏时，其它项目与新 Task 仍可用。

- [ ] **第 3 步: 实现清理语义**
说明：支持删除单 Task 记录、按项目移除历史索引和按容量淘汰最旧完成记录；运行中 Task、Worktree 和项目文件不随历史清理删除。
预期：清理前返回准确影响摘要，删除失败不会留下半更新索引。

### 任务 4: 实现重新打开与 Runtime 恢复降级

**任务目标：**
- 让用户先稳定查看历史，再在能力真实可用时继续执行。

**涉及范围：**
- Task IPC、`useTaskHistory.ts`、历史列表/空态/失败态和 Adapter resume capability。

**前置依赖：**
- 依赖任务 3 的可靠存储。

- [ ] **第 1 步: 提供分页任务查询和详情**
说明：主进程按 Project、状态和更新时间查询有限字段，Task 详情按需加载 Turn 与规范化展示事件页；Renderer 不直接读取存储文件。
预期：大量历史下列表仍有界，项目切换不会串入其它项目 Task。

- [ ] **第 2 步: 分离 reopen 与 resume**
说明：打开历史立即进入只读可审阅状态；只有能力矩阵和最近实测都允许时才显示“继续”，点击后由 Adapter 验证 Runtime session。
预期：Runtime session 不存在、版本不兼容或恢复失败时，Task 仍可查看并明确解释“无法继续”。

- [ ] **第 3 步: 完成重启走查**
说明：验证已完成、失败、取消、中断、损坏记录、项目失效和 Runtime session 失效场景。
预期：每个状态都有明确入口、反馈和降级，不丢失其它历史或扩大文件权限。

## 验收标准

- [ ] Project、Task、Turn、RuntimeSessionRef 和 ExecutionEnvironmentRef 的所有权及关系清晰，同一 Task 可以持久化多个 Turn。
- [ ] 实时展示所需的事件 kind、稳定身份、sequence、状态和截断信息以版本化有界结构保存，历史回放不依赖含义模糊的“摘要”。
- [ ] 应用重启后可列出并审阅历史；未完成 Turn 被标记为 `interrupted`，不会伪装成仍在运行。
- [ ] 重新打开历史不依赖 Runtime；继续执行只有在 Runtime 能力和 session 实测均通过时开放，失败后仍保留只读记录。
- [ ] API Key、原始环境、完整推理、屏幕和剪贴板不会落盘；单条损坏不影响其它记录。
- [ ] 删除历史不会删除项目文件、Git Worktree 或 Runtime 原生记录，并且影响范围可观察。
- [ ] 目标 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 通过，Electron 开发版完成注册项目、新建多轮 Task、重启打开和恢复失败走查。
