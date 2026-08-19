# P0-10 单 Runtime 任务工作台 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0-A / 权重 5（Codex-style 用户主界面）

**目标：** 用 Project、Task 和 Turn 重构当前工作台，让用户可以注册项目、创建和切换持久 Task、在同一 Task 连续对话，并始终看见后台执行状态与结果审阅入口。

**核心数据流：** Renderer 从主进程查询 Project 和 Task 列表；选中 Task 后加载 Turn、时间线和当前执行快照；发送 Prompt 调用 `startTurn(taskId, prompt)`；TaskExecutor 独立运行并推送状态，工作台只负责选择、展示和用户操作。

**约束与边界：** 首版只显示 Grok Runtime，不提供伪多 Runtime 选择器；不把模型和 Runtime 合并；不在 `App.vue` 继续堆积项目、历史和时间线细节。Git 与 Artifact 使用明确占位入口，完整能力分别由 P0-12、P0-13 接入；用户交互终端由 P0-15 接入。

**主要风险：** “当前选中 Task”和“当前运行 Task”容易被错误合并；必须分别建模，切换视图不影响运行，发送和停止操作始终指向明确 Task/Turn。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、Vue Test Utils。

---

## 实施范围

**前置依赖：**
- 依赖 P0-06、P0-08、P0-09。
- 依赖 [P0-10A](p0-10a-claude-desktop-workbench-ui.md)：工作台视觉与信息架构按 Claude Code Desktop 便捷度大修，P0-10 只往这套壳里填状态，禁止再做三栏卡片仪表盘。
- 依赖 [GACP-02](grokACP计划/gacp-02-session-restore-capability-contract.md)：点进历史 Task 就是进入可发送的对话，后台自动 resume/load，**不要再做「继续任务」确认按钮**。GACP-02 又依赖 [GACP-01](grokACP计划/gacp-01-real-grok-protocol-verification.md) 的真机观察。
- 子 Agent 嵌套展示见 [GACP-06](grokACP计划/gacp-06-subagent-timeline.md)，皮肤跟 P0-10A。

**文件范围：**
- 创建 `src/renderer/src/composables/useTaskWorkbench.ts`、`useProjectRegistry.ts` 及测试。
- 创建或重构 `ProjectSidebar.vue`、`TaskList.vue`、`TaskHeader.vue`、`TaskComposer.vue`、`TaskInspector.vue`。
- 修改 `App.vue` 只保留应用级组装、设置页入口和顶层布局。

**安全策略：**
- Renderer 只使用类型化 Project/Task IPC，不读取目录、历史文件或 Runtime session 原始 ID。
- 所有 Task 操作在主进程重新验证 projectId、taskId 和当前状态；UI 禁用只提供交互提示，不作为安全边界。
- 运行中模型和 execution environment 只展示不可变快照，不能乐观切换。

### 任务 1: 重构工作台状态编排

**任务目标：**
- 从 `App.vue` 抽出 Project、Task、当前选择和当前执行的独立状态。

**涉及范围：**
- `useTaskWorkbench.ts`、`useProjectRegistry.ts`、`App.vue` 和单元测试。

**前置依赖：**
- P0-08 已提供执行快照与订阅，P0-06 已提供列表和详情查询。

- [ ] **第 1 步: 分离选中与运行状态**
说明：分别维护 `selectedProjectId`、`selectedTaskId` 和 `activeExecution`；运行 Task 不因选择变化被替换或清空。
预期：用户查看 Task B 时，Task A 的运行徽标、停止入口和权限提醒仍准确存在。

- [ ] **第 2 步: 建立加载和错误边界**
说明：Project 列表、Task 列表、Task 详情和实时执行分别管理 loading/error/retry；旧请求返回时校验当前选择 revision。
预期：快速切换项目不会把旧 Task 列表写入新项目，局部失败不清空其它可用区域。

- [ ] **第 3 步: 缩减 App.vue 职责**
说明：把消息聚合、Task 列表、时间线和 Composer 行为移入 composable/组件，App 只组装状态和导航。
预期：具体页面逻辑有就近测试，App 不继续成为无法维护的单文件状态仓库。

### 任务 2: 实现 Project 与 Task 导航

**任务目标：**
- 让侧栏真正代表持久项目和任务，而不是当前 workspace 的临时映射。

**涉及范围：**
- ProjectSidebar、TaskList、项目注册/移除交互和最近 Task 状态。

**前置依赖：**
- 依赖任务 1 的工作台状态。

- [x] **第 1 步: 展示持久 Project 列表**
说明：显示项目名、路径提示、失效状态、运行任务数和最近打开时间；支持选择目录注册、重试访问和仅移除记录。
预期：重启后项目仍存在，失效目录不会被当作可执行项目。

- [x] **第 2 步: 展示 Task 列表与状态**
说明：按更新时间分页显示 running、waiting、completed、failed、cancelled、interrupted 状态；运行/等待审批使用稳定徽标而非仅依赖当前页面。
预期：用户能快速定位后台 Task、失败 Task 和可继续的最近 Task。

- [x] **第 3 步: 实现新建和重新打开 Task**
说明：新建 Task 显式创建新的产品 Task 与 Grok session。点开历史 Task 立即进入该对话：先画本地记录，后台按 GACP-02 自动接 session，输入框默认可用。不要再做「打开只读」和「继续旧 Task」两个动作。
预期：用户感知里只有「新对话」和「点进旧对话接着聊」。

- [x] **第 4 步: 实现重命名、归档与删除记录**
说明：重命名只修改 Task 展示标题；运行中/等待审批 Task 不允许归档或删除。删除仅删除历史记录，执行前展示 Turn、Artifact/环境引用影响，不触碰项目文件、Runtime 原生历史或未来 Worktree。
预期：管理 Task 不会中断在途执行或误删工作成果，失败后列表和详情保持一致。

### 任务 3: 实现多轮 Task 详情与 Composer

**任务目标：**
- 把对话从一次 Prompt 的临时视图升级为持久 Task 中的多个 Turn。

**涉及范围：**
- TaskHeader、TaskComposer、Turn 列表、时间线和结果审阅组合。

**前置依赖：**
- 依赖任务 2 的 Task 导航。

- [ ] **第 1 步: 展示 Task 固定事实**
说明：标题区显示 Project、Runtime、modelId、Local/Worktree、当前状态和创建时间；运行中不可编辑执行快照。
预期：用户始终能分辨当前看的 Task 和实际运行 Task，模型名称遵守 `displayName?.trim() || modelId`。

- [ ] **第 2 步: 组合 Turn、时间线与回复**
说明：每个 Turn 展示用户输入、执行时间线、Agent 回复和结果摘要；长内容按 Turn 折叠，最近活动 Turn 自动定位但不抢夺用户滚动。
预期：同一 Task 连续多轮上下文清晰，历史回放与实时更新使用同一组件。

- [ ] **第 3 步: 实现安全发送和停止**
说明：发送前主进程确认 Task 可继续、Project 可用、Runtime ready 和无活动 Turn；停止明确显示目标 Task，失败后恢复 Composer 状态。
预期：重复提交不会创建双 Turn，停止其它 Task 前不会因当前选择而误操作。

### 任务 4: 接入 Inspector 与桌面交互验收

**任务目标：**
- 建立 Codex 类审阅区域，并为后续核心能力提供稳定挂载点。

**涉及范围：**
- TaskInspector、布局、键盘导航和 Electron 走查。

**前置依赖：**
- 依赖任务 1 至任务 3。

- [ ] **第 1 步: 建立 Inspector 标签**
说明：首期提供 Timeline、Changes、Terminal、Artifacts 标签；只有 Timeline 可完整使用，其它标签依据能力返回显示“尚未实现”。Terminal 明确标注为 P0+ 用户交互增强，不把命令证据缺失伪装成终端尚未接入。
预期：P0-12 Git Review、P0-13 Artifact 和 P0-15 Terminal 可直接接入，不需要再次改造顶层导航。

- [ ] **第 2 步: 完成窗口与可访问性适配**
说明：小窗口保留 Task 列表切换、Composer、发送/停止和运行状态；Titlebar 控件设 `no-drag`，交互控件保留 focus-visible。
预期：键盘可完成项目、Task、Composer 和 Inspector 的主要操作。

- [ ] **第 3 步: 走查 Codex-style 单 Runtime 基础路径**
说明：注册项目、新建 Task、连续两轮、切换历史 Task、等待权限、停止、重启打开和恢复失败。
预期：用户不需要理解 Grok session 就能完成 Task 工作流，运行状态不会随视图切换丢失。

## 验收标准

- [ ] 侧栏展示真实持久 Project 和 Task；重启后列表恢复，失效目录和不可继续 Task 有明确状态。
- [ ] 同一 Task 可以连续执行多个 Turn；点进历史即可发送下一条，没有第二下「继续」确认。
- [ ] Task 可重命名、归档和删除记录；运行中 Task 受保护，删除历史不会触碰项目文件或执行环境。
- [ ] `selectedTaskId` 与活动执行状态分离，查看其它 Task 不会取消、清空或串流正在运行的 Task。
- [ ] App.vue 只承担顶层组装，Project、Task、Timeline 和 Composer 逻辑进入独立组件/composable 并有测试。
- [ ] 目标 ESLint、相关 Vitest/组件测试、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过，并完成多轮 Task、切换、重启和权限的 Electron 走查。
