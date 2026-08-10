# P2-03 Codex 命令、Diff 与审批映射 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P2 / 权重 5（高副作用任务闭环）

**目标：** 把 Codex 的命令、文件修改、Diff、审批与 Usage 接入统一 Broker 和审阅界面。

**核心数据流：** Codex Adapter 将操作意图送 Permission Broker；审批结果回写 app-server；命令/Diff/Usage 被归一化为时间线与任务结果摘要。

**约束与边界：** 不允许 Codex 绕过统一审批；删除、外发、登录态、屏幕/剪贴板逐次确认；不声称未生成 Diff 的操作可回滚。

**主要风险：** Codex 原生审批范围与本产品授权范围不等价；Broker 保存更严格的范围并对无法表达的长期授权降级为本次审批。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；需要 Runtime 协议时以当期官方 schema 与本机实测为准。

---

## 实施范围

**前置依赖：**
- 依赖 P0-08、P2-02、P0-07。

**文件范围：**
- 新增 `src/main/runtime/codex/codex-operation-mapper.ts`、测试；修改 Permission Broker、ExecutionTimeline 和 ResultReview。

**安全策略：**
- 安全是与操作风险匹配的护栏：低风险只读操作可在任务范围授权；写入与命令需展示目标和影响；删除、外发数据、登录态、屏幕和剪贴板始终显式确认。
- Renderer 不接触密钥、任意 IPC、文件系统或子进程；所有跨进程数据须可序列化、限长并脱敏。

### 任务 1: 建立操作映射和风险表

**任务目标：**
- 将 shell、文件写入、删除、网络、Diff、Usage 映射到统一操作；未知操作默认请求明确审批。

**涉及范围：**
- 新增 `src/main/runtime/codex/codex-operation-mapper.ts`、测试；修改 Permission Broker、ExecutionTimeline 和 ResultReview。

**前置依赖：**
- 依赖 P0-08、P2-02、P0-07。

- [ ] **第 1 步: 落地本任务**
说明：将 shell、文件写入、删除、网络、Diff、Usage 映射到统一操作；未知操作默认请求明确审批。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不允许 Codex 绕过统一审批；删除、外发、登录态、屏幕/剪贴板逐次确认；不声称未生成 Diff 的操作可回滚。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 2: 实现审批往返

**任务目标：**
- 处理允许、拒绝、超时、取消、重复请求和 app-server 已终止情况，审计关联 taskId 和操作摘要。

**涉及范围：**
- 新增 `src/main/runtime/codex/codex-operation-mapper.ts`、测试；修改 Permission Broker、ExecutionTimeline 和 ResultReview。

**前置依赖：**
- 依赖本计划任务 1 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：处理允许、拒绝、超时、取消、重复请求和 app-server 已终止情况，审计关联 taskId 和操作摘要。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不允许 Codex 绕过统一审批；删除、外发、登录态、屏幕/剪贴板逐次确认；不声称未生成 Diff 的操作可回滚。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 3: 完成审阅回归

**任务目标：**
- 用 mock 流验证命令输出脱敏、Diff 展示、测试摘要、Usage、拒绝与高风险操作的逐次确认。

**涉及范围：**
- 新增 `src/main/runtime/codex/codex-operation-mapper.ts`、测试；修改 Permission Broker、ExecutionTimeline 和 ResultReview。

**前置依赖：**
- 依赖本计划任务 2 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：用 mock 流验证命令输出脱敏、Diff 展示、测试摘要、Usage、拒绝与高风险操作的逐次确认。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不允许 Codex 绕过统一审批；删除、外发、登录态、屏幕/剪贴板逐次确认；不声称未生成 Diff 的操作可回滚。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

## 验收标准

- [ ] 每次 Codex 外部副作用均有统一风险决策；审阅页能关联命令/Diff/验证；无法撤销的操作不会被标为可撤销。
- [ ] 相关新增核心函数、IPC Handler、密钥/权限边界均有中文注释，且新增测试只使用假凭据和本地 Mock。
- [ ] 目标文件 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 在 Node.js 20+、pnpm 10.x 下完成；UI/Electron 改动另有对应开发版手工走查记录。
