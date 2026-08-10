# P0-07 执行时间线与结果审阅 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0 / 权重 4（用户理解和审阅闭环）

**目标：** 以统一事件展示计划、工具进度、权限、Diff、测试、Usage 和最终风险摘要，让用户能审阅而非只看聊天文本。

**核心数据流：** Renderer 订阅 AgentEvent 并按 taskId 归并；时间线派生步骤状态；文件和验证摘要连接到对应事件与历史记录。

**约束与边界：** 先做可靠文本时间线和摘要，不复制复杂 IDE；不展示原始工具请求、机密输出或声称无 Diff 时有可撤销修改。

**主要风险：** 流式高频事件导致重渲染和状态混乱；批量刷新、稳定 key、按类型折叠及只渲染受限大小的内容。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；需要 Runtime 协议时以当期官方 schema 与本机实测为准。

---

## 实施范围

**前置依赖：**
- 依赖 P0-02、P0-03、P0-06。

**文件范围：**
- 新增 `src/renderer/src/components/ExecutionTimeline.vue`、`TaskResultReview.vue`、`src/renderer/src/composables/useTaskTimeline.ts`；修改 `App.vue`。

**安全策略：**
- 安全是与操作风险匹配的护栏：低风险只读操作可在任务范围授权；写入与命令需展示目标和影响；删除、外发数据、登录态、屏幕和剪贴板始终显式确认。
- Renderer 不接触密钥、任意 IPC、文件系统或子进程；所有跨进程数据须可序列化、限长并脱敏。

### 任务 1: 定义时间线状态机

**任务目标：**
- 按 event sequence 处理运行、等待审批、完成、失败、取消，确保最终状态不可被旧事件覆盖。

**涉及范围：**
- 新增 `src/renderer/src/components/ExecutionTimeline.vue`、`TaskResultReview.vue`、`src/renderer/src/composables/useTaskTimeline.ts`；修改 `App.vue`。

**前置依赖：**
- 依赖 P0-02、P0-03、P0-06。

- [ ] **第 1 步: 落地本任务**
说明：按 event sequence 处理运行、等待审批、完成、失败、取消，确保最终状态不可被旧事件覆盖。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 先做可靠文本时间线和摘要，不复制复杂 IDE；不展示原始工具请求、机密输出或声称无 Diff 时有可撤销修改。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 2: 实现审阅组件

**任务目标：**
- 分别呈现计划、工具、权限、Diff/验证、Usage；所有图标按钮提供 title 或 aria-label，保持 reduced-motion。

**涉及范围：**
- 新增 `src/renderer/src/components/ExecutionTimeline.vue`、`TaskResultReview.vue`、`src/renderer/src/composables/useTaskTimeline.ts`；修改 `App.vue`。

**前置依赖：**
- 依赖本计划任务 1 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：分别呈现计划、工具、权限、Diff/验证、Usage；所有图标按钮提供 title 或 aria-label，保持 reduced-motion。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 先做可靠文本时间线和摘要，不复制复杂 IDE；不展示原始工具请求、机密输出或声称无 Diff 时有可撤销修改。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 3: 走查真实任务路径

**任务目标：**
- 用 Grok 任务验证加载、空态、失败、取消和恢复记录，确认敏感字段在 UI 中同样被脱敏。

**涉及范围：**
- 新增 `src/renderer/src/components/ExecutionTimeline.vue`、`TaskResultReview.vue`、`src/renderer/src/composables/useTaskTimeline.ts`；修改 `App.vue`。

**前置依赖：**
- 依赖本计划任务 2 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：用 Grok 任务验证加载、空态、失败、取消和恢复记录，确认敏感字段在 UI 中同样被脱敏。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 先做可靠文本时间线和摘要，不复制复杂 IDE；不展示原始工具请求、机密输出或声称无 Diff 时有可撤销修改。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

## 验收标准

- [ ] 用户能判断任务正在做什么、改了什么、如何验证；缺失能力显示缺失而非空白成功；长任务界面保持可用。
- [ ] 相关新增核心函数、IPC Handler、密钥/权限边界均有中文注释，且新增测试只使用假凭据和本地 Mock。
- [ ] 目标文件 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 在 Node.js 20+、pnpm 10.x 下完成；UI/Electron 改动另有对应开发版手工走查记录。
