# P0-07 核心权限 Broker 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0-A / 权重 5（本地任务副作用的统一护栏）

**目标：** 先为文件、命令、Git、Worktree 和明确网络外发建立统一风险模型、任务范围授权与脱敏审计，让 Grok 已验证并上报的 ACP 权限请求和 App 自有核心服务使用同一决策入口。

**核心数据流：** Adapter 或核心服务提交标准 `OperationIntent`；Broker 绑定 Project、Task、Turn、Execution Environment、目标和参数约束评估风险；低风险操作按策略允许，中高风险生成具体审批；结果回传发起者并写入 Task 时间线和有界审计记录。

**约束与边界：** 本期不实现插件市场、Browser、Chrome、屏幕或剪贴板能力接入，只为未来类别保留可扩展枚举并默认拒绝未知操作。只读项目元信息不逐次弹窗；删除、不可恢复 Git 操作、敏感外发和越出 execution root 的访问必须逐次确认或拒绝。

**主要风险：** “本 Task 允许”可能被错误复用到其它项目、Worktree 或参数；授权键必须包含 `taskId`、`projectId`、environmentId、operationType、目标集合、参数约束和有效期，任何缺失或不匹配都不得命中。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest。

---

## 实施范围

**前置依赖：**
- 依赖 P0-04、P0-05、P0-06。

**文件范围：**
- 创建 `src/main/security/permission-broker.ts`、`permission-policy.ts`、`permission-audit-store.ts` 及就近测试。
- 修改 `src/shared/agent.ts`，新增 `OperationIntent`、风险等级、授权范围和审批结果 DTO。
- 修改 Grok Adapter 权限映射、AgentService、静态 IPC 和 `PermissionPrompt.vue`。

**安全策略：**
- Broker 只接受主进程内部调用，不向 Renderer 暴露“执行任意操作”接口；Renderer 只能响应主进程已创建的有限审批 ID。
- 目标路径先解析到 Task execution root，禁止 `..`、符号链接逃逸和跨 Project 静默授权。
- 审计只保存发起者、操作类别、受限目标摘要、风险、用户决策和时间，不保存 Secret、完整命令环境或外发正文。
- Broker 能强制约束的是 Agent Studio 自己执行的 Git/命令/Worktree 等操作，以及 Runtime 明确发出的审批请求；它不是进程沙箱，无法拦截 Runtime 未上报便自行执行的副作用。Runtime 隔离、工具环境缩减和能力可信度必须继续作为独立安全层。

## 首期风险等级

- **L0 观察：** 已授权 Project 内的有限元信息读取、状态查询和已生成审阅结果读取，可自动允许并记录摘要。
- **L1 可恢复修改：** execution root 内普通文件写入、创建目录、运行已展示的低风险验证命令，可按当前 Task 授权。
- **L2 明确副作用：** 任意命令、Git 写操作、依赖安装、网络请求和覆盖文件，必须展示目标、影响和有效范围后批准。
- **L3 高风险：** 删除、强制 Git 操作、向外发送项目内容、访问 execution root 外路径、登录态、屏幕和剪贴板，只允许逐次确认；无法准确描述目标时直接拒绝。
- 未识别操作默认按 L3 处理，不得因为 Runtime 声称“安全”而自动降级。

### 任务 1: 定义 OperationIntent 与风险策略

**任务目标：**
- 建立 Runtime 和内置核心能力共同使用、但不会过度抽象的操作语言。

**涉及范围：**
- 共享 DTO、`permission-policy.ts`、风险策略单元测试。

**前置依赖：**
- P0-06 已提供稳定的 Project、Task 和 ExecutionEnvironmentRef。

- [ ] **第 1 步: 定义首期操作类别**
说明：至少覆盖 `read-project`、`write-file`、`execute-command`、`delete-path`、`git-read`、`git-mutate`、`worktree-create`、`worktree-remove` 和 `network-egress`；Browser、screen、clipboard 只保留不可默认允许的类别。
预期：每种类别都定义必需目标字段、可展示影响和默认风险，不使用含义模糊的通用 `tool` 字段替代。

- [ ] **第 2 步: 定义授权匹配键**
说明：授权包含发起者、Task、Project、environmentId、操作类别、允许目标、参数约束、创建时间和到期条件；Turn 结束、Task 结束、项目变化或环境变化按策略失效。
预期：Local 与 Worktree 即使属于同一 Project 也不会共享写权限，通配目标不能越出 execution root。

- [ ] **第 3 步: 固定默认策略**
说明：低风险读取在已注册 Project 内顺畅执行；写文件和命令显示影响后允许本 Task；删除、外发、强制 Git、登录态、屏幕和剪贴板始终逐次确认。
预期：策略符合“安全很重要但不能过分安全”，常规只读不制造审批疲劳。

### 任务 2: 实现 Broker 决策与有界审计

**任务目标：**
- 统一做允许、请求审批和拒绝决策，并保证重复、超时和取消安全收束。

**涉及范围：**
- `permission-broker.ts`、`permission-audit-store.ts`、AgentService 和测试。

**前置依赖：**
- 依赖任务 1 的完整策略表。

- [ ] **第 1 步: 实现决策流程**
说明：依次校验调用来源、Task 状态、execution root、意图形状、已有精确授权和风险策略；需要审批时生成不可预测 ID 和有限展示摘要。
预期：任何失败都在执行副作用前发生，未知意图不会进入 Adapter 或子进程。

- [ ] **第 2 步: 实现审批生命周期**
说明：处理允许、拒绝、取消、超时、重复响应、Turn 已结束和 App 退出；响应必须与原 Task、Turn 和请求身份匹配。
预期：过期或重复响应幂等无副作用，等待审批的 Turn 可被停止并正确收束。

- [ ] **第 3 步: 写入脱敏审计**
说明：记录意图摘要、风险、决策、授权范围和失效原因，限制单 Task 条数与文本大小；审计与 P0-06 Task 历史关联。
预期：用户能回看“为什么被允许/拒绝”，但记录中不存在 API Key、完整外发正文或命令环境。

### 任务 3: 接入 Grok ACP 权限请求

**任务目标：**
- 把当前 Grok 权限 UI 改为 Broker 的第一个真实调用方，验证抽象来自实际来源而非猜测。

**涉及范围：**
- `GrokAcpAdapter` 权限映射、AgentService、PermissionPrompt 和 mock 测试。

**前置依赖：**
- 依赖任务 2 的 Broker。

- [ ] **第 1 步: 映射 ACP 权限意图**
说明：只解析已由真实 Grok schema/fixture 验证的字段；`rawInput` 和 Runtime 文案视为不可信输入。能够确认的工具、目标和候选选项进入结构化意图，不能准确映射的请求以“未知高风险、仅本次”呈现。
预期：所有已验证并由 Grok 上报的 ACP 权限请求都先经过 Broker，再将允许/拒绝结果映射回 ACP；未上报副作用不伪称已被 Broker 拦截。

- [ ] **第 2 步: 重构审批 UI**
说明：显示 Runtime、Task、工具、具体目标、影响、风险、授权范围和有效期；HTTP、外发、删除和 execution root 外目标使用持续高风险提示。
预期：用户能区分“只允许这一次”和“允许当前 Task 内相同受限操作”，键盘与屏幕阅读器可完成决策。

- [ ] **第 3 步: 验证拒绝和收束路径**
说明：覆盖拒绝、超时、取消 Turn、断开 Runtime、Task 切换、相同 Task 命中授权和不同 Task 不命中。
预期：任何路径都不会卡住活动 Turn、泄漏权限或把一次授权扩大到其它环境。

### 任务 4: 为 App 自有核心服务建立强制调用接口

**任务目标：**
- 让后续 AppCommandRunner、Git、Worktree 和其它 App 自有服务直接复用 Broker，而不是各建一套确认弹窗。

**涉及范围：**
- 主进程内部 `authorizeOperation()` 接口、测试 fixture 和调用示例测试。

**前置依赖：**
- 依赖任务 3 的真实 Grok 验证。

- [ ] **第 1 步: 提供主进程内部授权 API**
说明：调用方提交完整 OperationIntent 和实际执行回调，Broker 只在允许后调用回调；禁止返回一个可被长期缓存的全局布尔权限。
预期：未来 Git、PTY 和 Worktree 服务能在同一 Task/环境边界内执行具体操作。

- [ ] **第 2 步: 固定失败与降级协议**
说明：区分 denied、cancelled、expired、invalid-target、unsupported 和 internal-error；返回 Renderer 前统一脱敏。
预期：调用方不会把拒绝误报为系统错误，也不会在 Broker 不可用时默认放行。

- [ ] **第 3 步: 验证 App 自有操作不可绕过**
说明：测试 Git、Command Runner、Worktree 等 App 自有服务只能在授权回调内执行副作用；扫描主进程新增 Shell/文件/Git 调用入口。对 Runtime 自行执行但未产生审批请求的行为记录为 Runtime 信任边界，不伪称 Broker 已拦截。
预期：所有 App 自有首期受控操作都能追溯到一个 Broker 决策；Grok 的保证范围准确限定为“已验证并上报的 ACP permission request”。

## 验收标准

- [ ] Grok 已验证并上报的 ACP permission request、AgentService 及 App 自有核心服务使用同一 OperationIntent、风险策略、审批生命周期和审计格式。
- [ ] 低风险项目读取不逐次打扰；写入和命令显示影响；删除、敏感外发、强制 Git 和 execution root 外访问不能静默执行。
- [ ] 授权严格绑定 Task、Project、Execution Environment、目标和参数，切换 Task 或 Worktree 后不会复用旧授权。
- [ ] 拒绝、超时、取消、重复响应和 Runtime 断开均安全收束，不留下悬挂请求或扩大权限。
- [ ] 审计可回看但不包含 Secret、完整环境或敏感原文；未来 Browser/Screen/Clipboard 未接入前保持默认拒绝。
- [ ] 文档和 UI 不把 Broker 宣称为 Runtime 进程沙箱；未上报副作用由 Runtime 隔离、环境缩减和能力可信度单独约束。
- [ ] 目标 ESLint、相关 Vitest/组件测试、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过，并完成 Grok 真实权限请求的 Electron 走查。
