# P0-07 核心权限 Broker 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0-A / 权重 5（本地任务副作用的统一护栏）

**当前状态：** 已完成；既有真实 Grok 已验证的权限路径与受控 ACP Runtime Electron E2E 已共同完成验收。

**目标：** 先为文件、命令、Git、Worktree 和明确网络外发建立统一风险模型、任务范围授权与脱敏审计，让 Grok 已验证并上报的 ACP 权限请求和 App 自有核心服务使用同一决策入口。

**核心数据流：** Adapter 或核心服务提交标准 `OperationIntent`；Broker 绑定 Project、Task、Turn、Execution Environment、目标和参数约束评估风险；低风险操作按策略允许，中高风险生成具体审批；结果回传发起者并写入关联 Task 的独立有界权限审计，P0-09 再将其投影到统一 Timeline。

**约束与边界：** 本期不实现插件市场、Browser、Chrome、屏幕或剪贴板能力接入，只为未来类别保留可扩展枚举；未知或结构不足的操作按 L3 仅允许本次，缺少唯一安全执行映射时直接拒绝。只读项目元信息不逐次弹窗；所有命令至少按 L2 审批；删除、不可恢复 Git 操作和敏感外发只允许本次；越出 execution root 的访问直接拒绝。

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
- 新增仅 Main 可见的受控 ACP Runtime E2E bootstrap、固定 ACP fixture 与独立 Playwright Electron E2E；它们只在开发态、未打包环境启用，未向 IPC、Preload 或 Renderer 开放测试注入。

**安全策略：**

- Broker 只接受主进程内部调用，不向 Renderer 暴露“执行任意操作”接口；Renderer 只能响应主进程已创建的有限审批 ID。
- 目标路径先解析到 Task execution root，禁止 `..`、符号链接逃逸和跨 Project 静默授权。
- 审计只保存发起者、操作类别、受限目标摘要、风险、用户决策和时间，不保存 Secret、完整命令环境或外发正文。
- 审批 TTL 为 2 分钟；每 Task 最多 500 条，字段 4 KiB、单记录 16 KiB、单文件 2 MiB，并接入 P0-06 的 256 MiB 全局历史容量门禁。
- Task grant 可跨 Turn，但只驻留当前进程内存；Task/Project 删除、Task 关闭、Runtime workspace/Project 身份变化和 App 重启均使其失效，不从历史恢复。
- Grok ACP 永远只回传 `allow_once` 或 `reject_once`；Runtime 提供的 `allow_always` 不会变成产品 Task grant。
- 首期权威执行环境仅支持 Local；Worktree intent 保留给 P0-14，当前解析到非 Local 环境时失败关闭。
- Broker 能强制约束的是 Agent Studio 自己执行的 Git/命令/Worktree 等操作，以及 Runtime 明确发出的审批请求；它不是进程沙箱，无法拦截 Runtime 未上报便自行执行的副作用。Runtime 隔离、工具环境缩减和能力可信度必须继续作为独立安全层。
- 受控 E2E 固定使用临时 userData、HOME、workspace、`127.0.0.1` 无认证 Mock Provider 与仓库内 fixture；trace 不记录 Prompt、环境、Provider 配置或 Secret。它证明真实 Electron/stdio ACP 管线的收束行为，不等价于真实 Grok 黑盒会发出同类请求。

## 首期风险等级

- **L0 观察：** 已授权 Project 内的有限元信息读取、状态查询和已生成审阅结果读取，可自动允许并记录摘要。
- **L1 可恢复修改：** execution root 内普通文件写入和创建目录，可按当前 Task 授权。
- **L2 明确副作用：** 任意命令、Git 写操作、依赖安装、网络请求和覆盖文件，必须展示目标、影响和有效范围后批准。
- **L3 高风险：** 删除、强制 Git 操作、向外发送项目内容只允许逐次确认；未知或结构不足的操作只允许本次；访问 execution root 外路径、登录态、屏幕和剪贴板，以及缺少唯一安全单次执行映射的请求直接拒绝。
- 未识别操作默认按 L3 处理，不得因为 Runtime 声称“安全”而自动降级。

### 任务 1: 定义 OperationIntent 与风险策略

**任务目标：**

- 建立 Runtime 和内置核心能力共同使用、但不会过度抽象的操作语言。

**涉及范围：**

- 共享 DTO、`permission-policy.ts`、风险策略单元测试。

**前置依赖：**

- P0-06 已提供稳定的 Project、Task 和 ExecutionEnvironmentRef。

- [x] **第 1 步: 定义首期操作类别**
      说明：至少覆盖 `read-project`、`write-file`、`execute-command`、`delete-path`、`git-read`、`git-mutate`、`worktree-create`、`worktree-remove` 和 `network-egress`；Browser、screen、clipboard 只保留不可默认允许的类别。
      预期：每种类别都定义必需目标字段、可展示影响和默认风险，不使用含义模糊的通用 `tool` 字段替代。

- [x] **第 2 步: 定义授权匹配键**
      说明：授权包含发起者、Task、Project、environmentId、操作类别、允许目标和参数指纹；授权只驻留内存，可跨 Turn，Task 关闭、Task/Project 删除、项目或环境身份变化、Runtime workspace 变化和 App 重启时失效。
      预期：Local 与 Worktree 即使属于同一 Project 也不会共享写权限，通配目标不能越出 execution root。

- [x] **第 3 步: 固定默认策略**
      说明：低风险读取在已注册 Project 内顺畅执行；写文件和命令显示影响后允许本 Task；删除、外发、强制 Git、登录态、屏幕和剪贴板始终逐次确认。
      预期：策略符合“安全很重要但不能过分安全”，常规只读不制造审批疲劳。

### 任务 2: 实现 Broker 决策与有界审计

**任务目标：**

- 统一做允许、请求审批和拒绝决策，并保证重复、超时和取消安全收束。

**涉及范围：**

- `permission-broker.ts`、`permission-audit-store.ts`、AgentService 和测试。

**前置依赖：**

- 依赖任务 1 的完整策略表。

- [x] **第 1 步: 实现决策流程**
      说明：依次校验调用来源、Task 状态、execution root、意图形状、已有精确授权和风险策略；需要审批时生成不可预测 ID 和有限展示摘要。
      预期：任何失败都在执行副作用前发生，未知意图不会进入 Adapter 或子进程。

- [x] **第 2 步: 实现审批生命周期**
      说明：处理允许、拒绝、取消、超时、重复响应、Turn 已结束和 App 退出；响应必须与原 Task、Turn 和请求身份匹配。
      预期：过期或重复响应幂等无副作用，等待审批的 Turn 可被停止并正确收束。

- [x] **第 3 步: 写入脱敏审计**
      说明：记录意图摘要、风险、决策、授权范围和失效原因，限制单 Task 条数与文本大小；审计以 `permission-audits.json` 独立保存并通过 `task:list-permission-audits` 分页回看，P0-09 再投影到 Timeline。
      预期：用户能回看“为什么被允许/拒绝”，但记录中不存在 API Key、完整外发正文或命令环境。

### 任务 3: 接入 Grok ACP 权限请求

**任务目标：**

- 把当前 Grok 权限 UI 改为 Broker 的第一个真实调用方，验证抽象来自实际来源而非猜测。

**涉及范围：**

- `GrokAcpAdapter` 权限映射、AgentService、PermissionPrompt 和 mock 测试。

**前置依赖：**

- 依赖任务 2 的 Broker。

- [x] **第 1 步: 映射 ACP 权限意图**
      说明：只解析已由真实 Grok schema/fixture 验证的字段；`rawInput` 和 Runtime 文案视为不可信输入。能够确认的工具、目标和候选选项进入结构化意图，不能准确映射的请求以“未知高风险、仅本次”呈现。
      预期：所有已验证并由 Grok 上报的 ACP 权限请求都先经过 Broker，再将允许/拒绝结果映射回 ACP；未上报副作用不伪称已被 Broker 拦截。

- [x] **第 2 步: 重构审批 UI**
      说明：显示 Runtime、Task、工具、具体目标、影响、风险、授权范围和有效期；HTTP、外发、删除和 execution root 外目标使用持续高风险提示。
      预期：用户能区分“只允许这一次”和“允许当前 Task 内相同受限操作”，键盘与屏幕阅读器可完成决策。

- [x] **第 3 步: 验证拒绝和收束路径**
      说明：覆盖拒绝、超时、取消 Turn、断开 Runtime、Task 切换、相同 Task 命中授权和不同 Task 不命中。
      预期：任何路径都不会卡住活动 Turn、泄漏权限或把一次授权扩大到其它环境。
      当前证据：拒绝、2 分钟超时、Runtime 断开、Task 切换、同 Task 跨 Turn grant、不同 Task 隔离和真实 Main 重启失效均已完成真机走查；受控 ACP Runtime Electron E2E 通过固定本地 fixture、真实 stdio/NDJSON 与完整 Main/Preload/Renderer 链路补齐 FIFO、精确 ToolCall 取消、Turn 取消和 unsupported 请求失败关闭。该证据不宣称真实 Grok 黑盒会触发相同请求。

### 任务 4: 为 App 自有核心服务建立强制调用接口

**任务目标：**

- 让后续 AppCommandRunner、Git、Worktree 和其它 App 自有服务直接复用 Broker，而不是各建一套确认弹窗。

**涉及范围：**

- 主进程内部 `authorizeOperation()` 接口、测试 fixture 和调用示例测试。

**前置依赖：**

- 依赖任务 3 的已验证权限路径与安全收束验收。

- [x] **第 1 步: 提供主进程内部授权 API**
      说明：调用方提交完整 OperationIntent 和实际执行回调，Broker 只在允许后调用回调；禁止返回一个可被长期缓存的全局布尔权限。
      预期：未来 Git、PTY 和 Worktree 服务能在同一 Task/环境边界内执行具体操作。

- [x] **第 2 步: 固定失败与降级协议**
      说明：区分 denied、cancelled、expired、invalid-target、unsupported 和 internal-error；返回 Renderer 前统一脱敏。
      预期：调用方不会把拒绝误报为系统错误，也不会在 Broker 不可用时默认放行。

- [x] **第 3 步: 固定未来 App 自有服务的接入门**
      说明：当前通过 Git、Command、Worktree 代表性 fixture 验证未来 App 自有服务只能在授权回调内执行副作用，并扫描现有主进程入口；P0-11、P0-12、P0-14 的真实服务尚未实现，后续必须接入同一 Broker。对 Runtime 自行执行但未产生审批请求的行为记录为 Runtime 信任边界，不伪称 Broker 已拦截。
      预期：内部契约和回归测试已建立，但不宣称真实 Command Runner、Git 或 Worktree 服务已接入。

## 验收标准

- [x] Grok 已验证并上报的 ACP permission request 与 AgentService 使用同一 OperationIntent、风险策略、审批生命周期和审计格式；未来 App 自有核心服务已有强制内部契约和 fixture。
- [x] 低风险项目读取不逐次打扰；写入和命令显示影响；删除、敏感外发、强制 Git 和 execution root 外访问不能静默执行。策略/Broker 回归覆盖首期风险边界；受控 E2E 验证合法 `execute-command` 显示 L3、影响与仅允许一次，缺少唯一 `allow_once` 的畸形请求不弹窗、ACP cancelled 且审计为 `unsupported`。
- [x] 授权严格绑定 Task、Project、Execution Environment、目标和参数；Task grant 可跨 Turn 但仅存内存，非 Local 环境当前拒绝。
- [x] 拒绝、超时、取消、重复响应和 Runtime 断开均安全收束，不留下悬挂请求或扩大权限。真实 Grok 路径覆盖拒绝、超时与断开；受控 E2E 覆盖精确 ToolCall/Turn 取消、兄弟请求保留、晚到响应不可复活、无 grant 与取消审计。
- [x] 审计可回看但不包含 Secret、原始命令、完整环境或敏感原文；Browser/Screen/Clipboard 未接入前保持拒绝。
- [x] 文档和 UI 不把 Broker 宣称为 Runtime 进程沙箱；未上报副作用由 Runtime 隔离、环境缩减和能力可信度单独约束。
- [x] 目标 ESLint、相关 Vitest/组件测试、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过，并完成 Grok 真实权限请求的 Electron 走查。

## 当前验证证据

- 2026-08-14，Node.js `v22.22.0`、pnpm `10.33.0`。
- 当前工作区自动门禁通过：目标 ESLint、全仓 `pnpm exec eslint . --no-cache`、`pnpm test`（38 个文件 / 351 项 Vitest，默认排除独立 Electron E2E）、`pnpm typecheck`、`pnpm build`、`pnpm build:unpack`、`git diff --check` 与 AGENTS/CLAUDE 一致性。
- 存储竞态回归覆盖：容量淘汰跳过在途权限审计 mutation lease；审计 `list()` 修复损坏记录时持有同一 lease；Task 目录 rename 已完成但父目录同步失败时根据真实磁盘结果保持不可逆提交。
- `build:unpack` 已生成 macOS arm64 未签名目录包；本机没有 Developer ID 证书，因此未执行代码签名。
- 2026-08-14 Electron/Grok 真机已通过：L0 Read、L1 Edit 允许与拒绝、同 Task 跨 Turn grant、不同 Task 隔离、真实 Main/Broker 重启后 grant 失效、2 分钟超时、Runtime 断开、Project A/B 快切与 Runtime workspace 一致性、焦点圈、Tab/Shift+Tab/Escape、审计脱敏和 root 外 `invalid-target` 失败关闭。
- 2026-08-14 受控 ACP Runtime Electron E2E 通过 `pnpm test:permission:e2e`（4/4）：FIFO 证明两项请求均先于首次决策到达且 UI/审计顺序正确；ToolCall 取消仅撤销 A、保留 B 且晚到 A 响应不可复活；Turn 取消发送同 session cancel、清空审批且 marker 不变；合法 `execute-command` 显示 L3/影响/仅允许一次，缺少唯一 `allow_once` 或畸形 options 不弹窗、ACP cancelled、无 marker 且审计为 `unsupported`。
- 真机边界确认：root 外 Edit 被 Broker 以 L3 `invalid-target` 取消且目标文件未变，但 Runtime 在写入前完成了未上报审批的 root 外 Read；`pwd` 也未产生 `execute-command` 权限请求。两者只证明 Broker 不是 Runtime 进程沙箱，不能作为命令审批或 unsupported 真机通过证据。
- 受控 E2E 使用固定本地 fixture、真实 stdio/NDJSON 与完整 Electron 链路，不等价于真实 Grok 黑盒会发出相同的 permission request；Broker 仍不是 Runtime 进程沙箱，也不拦截 Runtime 未上报副作用。
