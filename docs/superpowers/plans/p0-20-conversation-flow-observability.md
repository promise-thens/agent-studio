# P0-20 对话执行流可观测性实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**目标：** 让用户在主对话中持续看懂当前 Turn 的执行状态、已用时、当前步骤和最近一次 Runtime 事件，并能区分“仍在思考”和“暂时没有新事件”。

**核心数据流：** Grok ACP 事件经 Main Adapter、公开事件投影、Renderer Timeline reducer 后进入 `TurnTimelineViewModel`；执行快照提供当前 Turn 的状态与 dispatch/结束时间。对话组件只消费经过 reducer 的公开事实，使用本地时钟刷新运行中耗时，不新增 Renderer 直连 Runtime 或 IPC。

**约束与边界：**

- 不修改 ACP 公共事件协议，不读取 Runtime 私有 session，不把“无新事件”宣称为 Runtime 崩溃。
- 不恢复旧 `ChatMessage` 作为主对话数据源；旧计时状态只作为兼容代码，主列统一使用 Timeline。
- 历史 Turn 继续默认收起思考正文；只有活动 Turn 在状态条中显示有限预览，正文仍可展开。
- 不新增“继续任务”按钮；保留现有停止、权限和重试入口。
- 遵守现有深色/浅色变量、`prefers-reduced-motion`、中文注释和 IPC 安全边界。

**主要风险：**

- execution snapshot 与历史记录时间不一致：由 reducer 按当前 Turn 身份选择快照时间并保留持久化终态优先规则。
- 高频事件导致 UI 计时器和滚动抖动：只对活动 Turn 启动单一 500ms 时钟，事件文本仍由现有批处理合并。
- 将“无新事件”误报为卡死：只显示中性的等待提示，附最近事件时间，不改变 Turn 终态。
- 现有投影测试对节点顺序有严格断言：只增加可选时间字段和独立状态条，不改变节点排序或权限插入逻辑。

**技术栈：** Vue 3 `<script setup>`、TypeScript、现有 Timeline reducer、Vitest、现有 CSS 变量。

---

### 任务 1: 补齐 Turn 时间事实与事件观测时间

**任务目标：** 让实时 execution snapshot 和历史 Turn 都能得到一致的开始、结束和最近事件时间。

**文件：**

- 修改: `src/renderer/src/task-timeline-reducer.ts`
- 修改: `src/renderer/src/task-timeline-reducer.test.ts`

**数据流/接口梳理：**

- `selectTurnTimeline` 按 `taskId + turnId` 匹配 `executionSnapshot.execution`。
- `dispatchedAt`、`endedAt` 优先使用匹配 execution 的字段，再回退到 `TurnHistoryRecord`。
- `lastEventAt` 来自接受事件中最高 sequence 的 `observedAt`，没有事件时不伪造 Runtime 事件。

- [x] **第 1 步: 扩展 ViewModel 可选字段并接入 snapshot fallback**
- [x] **第 2 步: 为事件节点保留首末观测时间**
- [x] **第 3 步: 补充实时 running、历史 completed、无事件 Turn 的 reducer 测试**

### 任务 2: 建立纯函数的对话进度呈现规则

**任务目标：** 集中处理耗时、相对更新时间、当前步骤和中性“等待新事件”提示，避免组件中散落时间算法。

**文件：**

- 创建: `src/renderer/src/conversation-progress.ts`
- 创建: `src/renderer/src/conversation-progress.test.ts`

- [x] **第 1 步: 实现状态文案与 `mm:ss`/小时级耗时格式化**
- [x] **第 2 步: 实现最近事件年龄和等待阈值判断**
- [x] **第 3 步: 覆盖无时间、负时间、活动中和终态边界**

### 任务 3: 重做主对话 Turn 状态条

**任务目标：** 在每个 Turn 顶部稳定呈现状态、耗时、当前步骤、最近事件和等待提示。

**文件：**

- 修改: `src/renderer/src/components/ConversationTurn.vue`
- 修改: `src/renderer/src/components/TaskConversation.vue`
- 修改: `src/renderer/src/assets/main.css`

**交互：**

- 活动 Turn 显示“正在运行/等待你的确认/正在停止 · 已用时”，右侧只放当前阶段。
- 最近事件超过阈值时仅把当前阶段替换为“等待 Runtime 新事件”，不额外增加告警卡，也不把状态改成失败。
- 思考正文继续由原有折叠行承载，状态条只保留一行更新时间，避免长文本淹没对话。
- 不新增停止按钮，继续复用 Composer 现有停止入口。

- [x] **第 1 步: 添加活动 Turn 时钟和状态条计算**
- [x] **第 2 步: 将状态条放到 Turn 顶部，保留现有过程节点顺序**
- [x] **第 3 步: 更新 process rail、失败/等待/完成颜色和 reduced-motion 样式**
- [x] **第 4 步: 验证滚动贴底、权限卡、历史分页不受影响**

### 任务 4: 验收与回归

- [x] **第 1 步: 运行目标 Vitest、ESLint、typecheck、build 和 `git diff --check`**
- [ ] **第 2 步: 运行开发版，分别观察 running、thought 长时间无新事件、waiting-permission、failed、completed**
- [x] **第 3 步: 记录自动验证与 GUI/真实 Runtime 观察边界，不把 fixture 结果写成真机结论**

### 任务 5: 计划详情进入独立 Inspector 标签

**任务目标：** 计划在对话中保留轻量入口，点击后打开现有 Inspector 的独立「计划」标签；详情复用同一份 Timeline reducer 计划快照，避免长回复把计划挤出可视区域，也避免多份状态产生漂移。

**文件：**

- 修改: `src/renderer/src/components/ConversationTurn.vue`
- 修改: `src/renderer/src/components/TaskConversation.vue`
- 修改: `src/renderer/src/App.vue`
- 修改: `src/renderer/src/components/TaskInspector.vue`
- 修改: `src/renderer/src/components/InspectorPaneGrid.vue`
- 修改: `src/renderer/src/components/InspectorPane.vue`
- 修改: `src/renderer/src/components/InspectorTimelinePane.vue`
- 修改: `src/renderer/src/task-inspector.ts`
- 修改: `src/renderer/src/composables/useTaskTimeline.ts`
- 修改: `src/renderer/src/assets/main.css`

**边界：**

- 按 2026-09-02 最新交互确认，Inspector 新增独立「计划」标签，与时间线、变更、终端、产物并列。
- 点击入口携带 `turnId`，旧轮次计划不会误显示成最新轮次。
- `plan` 事件绕过流式文本微任务批处理立即投影；主进程仍保持“落盘成功后再公开事件”的持久化一致性边界。

- [x] **第 1 步: 建立 ConversationTurn → TaskConversation → App 的计划打开事件链**
- [x] **第 2 步: Timeline Inspector 复用最新/指定 Turn 的 PlanChecklist 快照**
- [x] **第 3 步: Plan 快照立即进入 reducer，补充多轮定位和刷新测试**

## 验收标准

- 活动 Turn 在主对话顶部持续显示当前状态和实时已用时，终态显示冻结耗时。
- 当前步骤不再只靠底部 spinner 判断；工具、计划、思考和权限都有可读的最近步骤文案。
- 思考内容即使没有继续增长，也能看到最近事件时间和中性的等待提示；不会自动伪造失败。
- 实时 execution snapshot 与历史回放的开始/结束时间使用同一套字段，Task/Turn 切换不串计时。
- 现有事件顺序、权限、附件、子 Agent、Changes/Artifacts 和 Composer 行为保持不变。
