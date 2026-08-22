# P0-11 Command Runner 与执行证据 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0-A / 权重 5（验证结果和命令审阅的事实来源）

**目标：** 建立主进程非交互式 `AppCommandRunner`、统一 `CommandExecutionEvidence` 与 `CommandTranscriptRef`，既能安全执行 Agent Studio 自有的固定命令，也能把 Grok/Codex Runtime 已执行命令的真实字段映射为可审阅证据；交互式用户终端留给 P0-15。

**核心数据流：** App 自有 Project Action/Git 辅助操作提交受限 `CommandSpec`，经 Permission Broker 后由 AppCommandRunner 在 Task execution root 执行；Runtime 工具事件由对应 Adapter mapper 提取已验证的 command/exit/timedOut/output 字段；两类来源都写入 CommandEvidenceStore，Timeline、ValidationResult 和只读命令审阅入口只持有 transcript 引用。

**约束与边界：** AppCommandRunner 不提供任意 Renderer Shell API，不支持交互 stdin、TTY、登录 Shell 会话或应用重启后的进程恢复。Runtime 自己执行的命令只能记录其上报事实，不能伪称由 AppCommandRunner 沙箱或 Broker 强制执行。

**主要风险：** Runtime 原始字段不稳定、命令输出包含 Secret、ANSI/分块文本破坏脱敏，以及 App 自有命令被拼接注入；只解析已验证 schema，App 命令使用 executable + args、固定 cwd 和最小环境，输出容量限制为主，文本脱敏仅作为 best-effort 附加层。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、Node `child_process.spawn`。

---

## 实施范围

**前置依赖：**
- 依赖 P0-06、P0-07、P0-08、P0-10。

**文件范围：**
- 创建 `src/main/command/app-command-runner.ts`、`command-evidence-store.ts`、`command-environment.ts` 及就近测试。
- 创建 `src/shared/command.ts`，定义 CommandSpec、CommandExecutionEvidence、CommandTranscriptRef 和 ValidationResult 关联。
- 创建 `src/main/runtime/grok/grok-command-evidence-mapper.ts`，修改 Grok Adapter 工具事件映射。
- 修改 Timeline/ResultReview 的命令引用；不创建交互式终端组件。

**安全策略：**
- App 自有命令只接受主进程可信服务生成的 executable/args/cwd/envPolicy，Renderer 只能选择预先发现的 actionId 或响应审批，不能提交任意 executable、cwd 或 env。
- cwd 必须等于 Task execution root 或已声明子目录；环境显式剥离 Provider Key、Authorization、GROK/Codex 模型凭据和 App 私有 Secret。
- stdout/stderr 采用字节上限、时间上限和截断标记；默认只持久化有限 transcript/摘要。文本脱敏是 best-effort，不能替代环境隔离和不向命令注入 Secret。

## 命令来源

- `app-runner`：Agent Studio 自有服务通过受限 CommandSpec 启动的非交互式进程，App 可以强制 cwd、env、timeout、取消和证据采集。
- `runtime-tool`：Grok/Codex Runtime 自己执行并通过协议上报的工具活动，App 只验证、限长和记录已知字段。
- `user-terminal`：用户未来在 P0-15 PTY 中直接输入；TerminalService 可复用有界 transcript 引用和来源标识，但在没有经过验证的 Shell integration 前，不从任意按键流伪造逐命令退出码或 ValidationResult。本计划不实现该执行器。

### 任务 1: 定义统一命令证据契约

**任务目标：**
- 让验证、时间线、Codex 映射和未来终端共享同一可审阅事实。

**涉及范围：**
- `src/shared/command.ts`、schema 测试和 TaskStore 引用。

**前置依赖：**
- P0-06 已提供 Task/Turn/Environment 身份和有界历史引用。

- [ ] **第 1 步: 定义 CommandExecutionEvidence**
说明：字段至少包含 commandId、taskId、turnId、environmentId、source、displayCommand、cwd 相对路径、startedAt、endedAt、exitCode、signal、timedOut、status、transcriptRef、truncated 和 trustLevel。
预期：退出码未知、Runtime 只提供标题或输出被截断时都有显式状态，不根据工具标题猜测成功。

- [ ] **第 2 步: 定义 CommandTranscriptRef**
说明：引用只包含 transcriptId、可用字节、总/截断状态、编码、保存策略和失效状态；Renderer 不拿到任意文件路径。
预期：Timeline 可以按需读取有限输出，应用重启后明确区分 retained/expired/missing。

- [ ] **第 3 步: 关联 ValidationResult**
说明：ValidationResult 必须引用一个或多个 commandId，并根据真实退出码/超时生成 pass/fail/unknown；聊天文本不能直接产生通过状态。
预期：P0-12 Changes 面板的测试结论有可追溯命令事实。

### 任务 2: 实现 AppCommandRunner

**任务目标：**
- 为 Agent Studio 自有固定命令提供非交互、安全、可取消的执行入口。

**涉及范围：**
- app command runner、environment builder、Permission Broker 和测试。

**前置依赖：**
- 依赖任务 1 的证据契约。

- [ ] **第 1 步: 定义受限 CommandSpec**
说明：CommandSpec 使用 executable、args、相对 cwd、timeout、envPolicy 和 action 来源；禁止 Shell 字符串拼接。确需 Shell 语义的 action 必须由可信主进程服务显式选择固定 Shell 与参数，并展示完整影响。
预期：Renderer 无法将 actionId 替换为任意命令，也不能越出 execution root。

- [ ] **第 2 步: 构造最小环境并执行**
说明：使用独立 env 对象，剥离所有模型凭据和 App Secret；通过 `spawn` 捕获 stdout/stderr，支持 AbortSignal、timeout 和进程组收束。
预期：常用 lint/test/build 命令可执行，子进程 `env` 中不存在 Provider Key。

- [ ] **第 3 步: 写入 transcript 与证据**
说明：按 chunk 计数并限制内存/磁盘，保留 stdout/stderr 来源、截断和终态；ANSI 解析只用于展示，不作为安全过滤。进程结束后原子写入 evidence。
预期：大输出、中文、失败、timeout、取消和进程启动失败都有准确证据且不会拖垮 IPC。

### 任务 3: 映射 Grok Runtime 命令证据

**任务目标：**
- 不丢弃当前 Grok ACP 已真实提供的命令、退出码和输出事实。

**涉及范围：**
- Grok command mapper、协议 fixture、Grok Adapter 和测试。

**前置依赖：**
- 依赖任务 1 的证据契约；使用当前版本真实 ACP fixture，而不是猜测字段。

- [ ] **第 1 步: 冻结已验证字段**
说明：验证并记录 `rawInput.command`、`rawOutput.exit_code`、`timed_out`、`output`、`output_file` 等当前实际字段及版本；字段缺失或类型变化降级为 unknown。
预期：未验证 rawInput/rawOutput 不进入通用字段，也不被当作权限依据。

- [ ] **第 2 步: 生成 runtime-tool evidence**
说明：将已执行工具的命令、状态、退出码、超时和有限输出写入统一 evidence；trustLevel 标明数据来自 Runtime 上报而非 App 直接执行。
预期：Grok 工具标题与真实退出码冲突时以结构化事实和不一致警告展示。

- [ ] **第 3 步: 关联 Timeline 与权限事实**
说明：命令 evidence 关联原 toolCallId/Turn；若 Runtime 上报过 ACP permission request，记录 approvalId；未上报审批不能伪造 Broker 已授权。
预期：用户能看到命令是谁执行、是否经过已知审批以及结果是否可信。

### 任务 4: 提供受限查询与回归验收

**任务目标：**
- 让工作台按需查看命令证据，并证明 App 命令与 Runtime 命令不会混淆。

**涉及范围：**
- CommandEvidence IPC、Timeline/ResultReview、测试和 Electron 走查。

**前置依赖：**
- 依赖任务 2、任务 3。

- [x] **第 1 步: 提供只读查询 API**
说明：按 taskId/commandId 获取 evidence 与分页 transcript chunk；主进程验证 Task/Environment，Renderer 不能提交 transcript 文件路径。
预期：跨 Task 查询、超限 offset 和失效引用安全拒绝。

- [x] **第 2 步: 展示事实和限制**
说明：Timeline/ResultReview 显示 displayCommand、来源、cwd、退出码、耗时、timeout、截断和 trust；无完整 transcript 时明确说明。
预期：用户不会把 `runtime-tool` 当成 App 沙箱执行，也不会把截断输出误认为完整日志。

- [x] **第 3 步: 完成真实命令走查**
说明：验证 App 自有成功/失败/超时/取消命令，以及 Grok 工具成功/失败/字段缺失/输出文件场景。
预期：ValidationResult、Timeline 和证据查询一致，Provider Secret 不进入 App 自有命令环境。

## 验收标准

- [x] App 自有非交互命令和 Runtime 上报命令使用同一 CommandExecutionEvidence，但 source/trust/approval 边界清晰。
- [x] ValidationResult 只能由真实 commandId、退出码和超时事实产生，不从聊天文案或工具标题推断通过。
- [x] AppCommandRunner 无任意 Renderer Shell API，命令固定在 Task execution root，环境不包含 Provider Key 或 App Secret。
- [x] Runtime 命令只解析已验证 schema；未上报审批或无法拦截的执行不会被描述为已受 Broker 强制保护。
- [x] transcript 有容量、持久化和失效边界；文本脱敏明确为 best-effort，核心安全依赖环境隔离和不注入 Secret。
- [x] 目标 ESLint、相关 Vitest/集成测试、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过，并完成 App/Grok 两类命令证据走查。
