# P2-02 Codex Thread 与 Turn 适配 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P2 / 权重 5（第二 Runtime 的任务闭环）

**目标：** 把 Codex Thread、Turn、Message、Reasoning、Plan 与 Usage 映射为统一任务、会话和事件，支持创建、读取、恢复与分叉。

**核心数据流：** Agent service 创建本地 task/session 引用；Codex Adapter 调用 Thread/Turn API 并转换增量；历史存储保存引用和脱敏摘要，恢复时回到原生 Thread。

**约束与边界：** 不把 Codex Item schema 放到 shared；不把 Grok ACP 会话规则硬套给 Codex；仅实现官方确认的读取/恢复/分叉语义。

**主要风险：** 重复发送、断线重连或 thread 缺失导致本地状态漂移；使用 requestId、sequence 和“可查看不可继续”降级。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；需要 Runtime 协议时以当期官方 schema 与本机实测为准。

---

## 实施范围

**前置依赖：**
- 依赖 P2-01、P0-01、P0-02、P0-06。

**文件范围：**
- 新增 `src/main/runtime/codex/codex-thread-adapter.ts`、测试；修改 Agent service、task history 和 capability matrix。

**安全策略：**
- 安全是与操作风险匹配的护栏：低风险只读操作可在任务范围授权；写入与命令需展示目标和影响；删除、外发数据、登录态、屏幕和剪贴板始终显式确认。
- Renderer 不接触密钥、任意 IPC、文件系统或子进程；所有跨进程数据须可序列化、限长并脱敏。

### 任务 1: 建立映射表

**任务目标：**
- 逐项定义 Thread/Turn/Item 到 AgentTask、Session、Event 的映射及信息损失处理，特别标注非对称字段。

**涉及范围：**
- 新增 `src/main/runtime/codex/codex-thread-adapter.ts`、测试；修改 Agent service、task history 和 capability matrix。

**前置依赖：**
- 依赖 P2-01、P0-01、P0-02、P0-06。

- [ ] **第 1 步: 落地本任务**
说明：逐项定义 Thread/Turn/Item 到 AgentTask、Session、Event 的映射及信息损失处理，特别标注非对称字段。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不把 Codex Item schema 放到 shared；不把 Grok ACP 会话规则硬套给 Codex；仅实现官方确认的读取/恢复/分叉语义。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 2: 实现任务操作

**任务目标：**
- 支持新建、读取、恢复、分叉、启动、取消和完成，所有请求经过固定 IPC 和 task 状态校验。

**涉及范围：**
- 新增 `src/main/runtime/codex/codex-thread-adapter.ts`、测试；修改 Agent service、task history 和 capability matrix。

**前置依赖：**
- 依赖本计划任务 1 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：支持新建、读取、恢复、分叉、启动、取消和完成，所有请求经过固定 IPC 和 task 状态校验。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不把 Codex Item schema 放到 shared；不把 Grok ACP 会话规则硬套给 Codex；仅实现官方确认的读取/恢复/分叉语义。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 3: 验证恢复与异常

**任务目标：**
- 覆盖流式 message/reasoning/plan/usage、断连、取消、thread 不存在和分叉后的历史索引。

**涉及范围：**
- 新增 `src/main/runtime/codex/codex-thread-adapter.ts`、测试；修改 Agent service、task history 和 capability matrix。

**前置依赖：**
- 依赖本计划任务 2 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：覆盖流式 message/reasoning/plan/usage、断连、取消、thread 不存在和分叉后的历史索引。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不把 Codex Item schema 放到 shared；不把 Grok ACP 会话规则硬套给 Codex；仅实现官方确认的读取/恢复/分叉语义。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

## 验收标准

- [ ] Codex 任务可在统一时间线显示并可恢复已支持的 Thread；重复或失序事件不污染历史；未映射项目保持明确降级标识。
- [ ] 相关新增核心函数、IPC Handler、密钥/权限边界均有中文注释，且新增测试只使用假凭据和本地 Mock。
- [ ] 目标文件 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 在 Node.js 20+、pnpm 10.x 下完成；UI/Electron 改动另有对应开发版手工走查记录。
