# P0-15 Task 用户交互终端 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0+ / 权重 3（用户接管本地环境的增强入口，不阻塞 P0-A/P0-B）

**目标：** 为每个 Task 提供绑定 execution environment 的用户交互式 PTY，让用户在同一工作台显式打开自己的 Shell、接管调试或补充操作；Agent Studio 自有命令和 Runtime 工具命令继续使用 P0-11 的结构化执行证据，不通过向 PTY 写入字符执行。

**核心数据流：** 用户显式打开 Terminal 标签后，Renderer 通过固定 IPC 请求创建 Task terminal；主进程验证 Task/environment，使用 `node-pty` 启动用户登录 Shell，构造不注入任何 Agent Studio 持有 Secret 的初始环境并固定 cwd；用户的 `.zprofile`、`.zshrc` 等启动脚本随后可能自行加载其个人凭据，这属于用户 Shell 环境边界。输出进入内存有界 ring buffer，以 chunk、sequence 和 revision 推送 xterm.js；write、resize、interrupt 和 close 经窄 API 返回主进程。

**约束与边界：** Renderer 不获得 Shell、PTY 或子进程对象，也不能指定任意 executable、cwd 或 env。终端只代表用户直接操作，不作为 AppCommandRunner、Runtime tool 或 Project Action 的执行通道；不尝试从任意 Shell 输入可靠推断每条命令、退出码或审批事实。Agent Studio 只能保证自己持有的 Provider/App Secret 不注入 PTY，不能保证用户登录 Shell 启动脚本不会加载用户自行配置的凭据。应用重启前的 PTY 不恢复，原始 scrollback 默认不持久化。

**主要风险：** `node-pty` 的 Electron ABI/签名打包、用户登录脚本或主动输入带入 Secret、ANSI/分块输出绕过文本过滤和无界 scrollback；必须先验证原生依赖，以“不注入 Agent Studio Secret”、容量上限和默认不持久化原始输出为核心边界，用户 Shell 自带凭据归用户管理，文本脱敏只能标注为 best-effort。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、`node-pty`、xterm.js。

---

## 实施范围

**前置依赖：**
- 依赖 P0-11、P0-14；P0-14 已提供 Local/Worktree 的稳定 ExecutionEnvironmentRef。

**文件范围：**
- 创建 `src/main/terminal/task-terminal-service.ts`、`terminal-environment.ts` 及就近测试。
- 创建 `src/shared/terminal.ts`、固定 Terminal IPC 和窄 Preload API。
- 创建 `src/renderer/src/components/TaskTerminal.vue`、`useTaskTerminal.ts` 及测试。
- 修改 TaskInspector 和构建配置；不修改 AppCommandRunner 让它改走 PTY。

**安全策略：**
- 服务端只接受 taskId、environmentId、terminalId、有限输入文本和尺寸；shell、cwd、env、IPC channel 均由主进程根据 Task 快照决定。
- 初始环境显式删除 Agent Studio 持有的 API Key、Authorization、Provider 配置、Grok/Codex 模型凭据和 App 私有变量，不修改全局 `process.env`；登录 Shell 启动脚本自行重新加载的用户凭据不属于 App 可承诺清除的范围。
- scrollback 使用内存字节上限和截断标记，默认不写入 Task 历史或磁盘；文本脱敏仅作为 best-effort 展示层，不承诺过滤用户主动输入或所有控制序列中的 Secret。
- 用户终端不逐按键经过 Permission Broker；创建、关闭和越界请求仍由主进程校验。App/Agent 发起的命令继续走 P0-07 与 P0-11。

### 任务 1: 验证 PTY 技术和打包基线

**任务目标：**
- 在正式接入前证明选定 PTY 方案能在 Electron 39 和 macOS 打包环境可靠运行。

**涉及范围：**
- package/build 配置、最小主进程 harness、开发版和 `build:unpack` 验证记录。

**前置依赖：**
- Node.js 使用项目允许的 22 或 24，pnpm 使用 10.x。

- [ ] **第 1 步: 引入并编译 node-pty**
说明：按 Electron 39 ABI 安装/重建原生模块，验证 macOS arm64 开发模式可以创建用户登录 Shell、接收 UTF-8 输出、resize、interrupt 并退出。
预期：不出现 native module load/ABI 错误；失败时停止后续实现并记录准确构建阻塞，不用普通 `child_process` 冒充 PTY。

- [ ] **第 2 步: 验证 unpack 构建**
说明：运行 `pnpm build:unpack`，启动解包应用并创建 PTY；检查 asar unpack、签名路径和原生二进制加载。
预期：开发版和解包版行为一致，构建配置没有复制多份不受控二进制。

- [ ] **第 3 步: 固定首期支持边界**
说明：记录支持的 macOS Shell、UTF-8、窗口 resize、SIGINT/终止、Shell 进程退出码和最大 scrollback；明确不承诺应用重启恢复、每条交互命令解析或 Windows/Linux 打包。
预期：后续任务只使用已验证能力，不在 UI 层临时猜测兼容性。

### 任务 2: 实现 TaskTerminalService

**任务目标：**
- 在主进程安全持有用户 PTY 生命周期和 Task 环境绑定。

**涉及范围：**
- terminal service、environment builder、共享 DTO 和测试。

**前置依赖：**
- 依赖任务 1 的技术基线和 P0-14 的环境解析接口。

- [ ] **第 1 步: 创建受控 TerminalSession**
说明：主进程从 TaskStore 解析 execution root，创建 terminalId 并绑定 taskId、environmentId、cwd、shell、pid、createdAt 和 status；同一请求不能覆盖其它 Task 会话。
预期：Local/Worktree 终端始终落在各自绑定目录，路径失效、Worktree 被移除或 Task 不匹配时不启动进程。

- [ ] **第 2 步: 构造最小环境**
说明：从可信系统环境选择必要变量，设置 TERM、语言和 App 标识，删除 Agent Studio Provider Key、Authorization、Grok/Codex 模型凭据和其它 App Secret；不修改全局环境。启动用户登录 Shell 后，把 `.zprofile`/`.zshrc` 自行加载凭据明确标注为用户环境边界。
预期：用测试注入的 Agent Studio 假 Secret 不会出现在初始 PTY 环境；若用户 Shell 脚本自行设置凭据，产品不误称其由 Agent Studio 注入或能够统一清除。

- [ ] **第 3 步: 管理输入输出和终态**
说明：输出以 UTF-8 有界 chunk、sequence 和截断标记发布；实现 write、resize、interrupt、close 和进程退出。ring buffer 达上限后丢弃最旧内容并增加 droppedBytes，不把原始 scrollback 默认写入磁盘。
预期：大量输出不会拖垮 IPC，停止一个终端不影响 TaskExecutor、Runtime 或其它 Task。

### 任务 3: 建立窄 Terminal IPC 与来源分界

**任务目标：**
- 允许用户直接操作终端，同时不让 Renderer 获得任意子进程能力或把终端伪装成 Agent 执行器。

**涉及范围：**
- Terminal IPC、Preload API、来源/参数校验和测试。

**前置依赖：**
- 依赖任务 2 的服务接口。

- [ ] **第 1 步: 定义固定 API**
说明：只暴露 create/list/getSnapshot/write/resize/interrupt/close 和 output subscription；所有字符串、尺寸和 payload 按 UTF-8 字节与数值边界校验。
预期：Renderer 无法指定 channel、可执行文件、cwd、env 或向其它 terminalId 写入。

- [ ] **第 2 步: 固定三类命令来源**
说明：用户在已打开终端内的输入标为 `user-terminal`；App 固定 action 只能调用 `app-runner`；Grok/Codex 已执行工具只记录为 `runtime-tool`。不得通过 TerminalService 向 PTY 注入 Agent/Project Action 命令。
预期：权限、Timeline 和审阅界面可以回答来源；用户终端的 Shell 进程退出不被误报为其中每条命令均验证通过。

- [ ] **第 3 步: 验证进程和文本边界**
说明：覆盖超长输入、控制字符、无效尺寸、未知 terminalId、跨 Task 写入、输出洪泛、ANSI 标题注入、用户输入假 Secret 和 Shell 异常退出。
预期：非法请求在进程操作前拒绝；展示文本有限且 best-effort 脱敏，但安全结论不依赖脱敏百分之百成功。

### 任务 4: 实现终端 UI 与任务关联

**任务目标：**
- 在工作台中提供可用、身份清晰且不会冒充持久命令日志的交互终端。

**涉及范围：**
- TaskTerminal、xterm.js、TaskInspector 和组件测试。

**前置依赖：**
- 依赖任务 3 的 API。

- [ ] **第 1 步: 渲染当前进程快照**
说明：打开 Terminal 标签时查询当前会话与内存有限 scrollback，再从 lastSequence 订阅新输出；支持 resize、选区复制和键盘输入，不使用浏览器全局剪贴板后门。
预期：切换 Inspector 标签或 Task 后返回时，可恢复仍在运行的当前进程视图；应用重启后明确显示旧终端已结束且无 raw scrollback。

- [ ] **第 2 步: 展示身份和安全边界**
说明：显示 Task、Local/Worktree、cwd 相对路径、`用户终端` 标签、运行/退出状态、截断和“不保存原始滚屏”提示；不把 Runtime command evidence 混入可输入的 PTY 视图。
预期：用户知道自己在哪个环境直接操作，也知道该视图不是 Broker 审批过的 Agent 命令清单。

- [ ] **第 3 步: 完成真实走查**
说明：验证 `pwd`、交互式输入、中文/emoji、大输出、resize、Ctrl-C、异常退出、Task 切换、Local/Worktree cwd，以及 Agent Studio 注入假 Secret 不可见；另用测试 Shell profile 证明用户启动脚本可以自行加载变量并显示边界提示。
预期：终端可日常使用，Agent Studio 持有的 Provider/App Secret 不进入初始环境；用户 Shell 自带凭据不被误归因，脱敏无法保证的用户输入不被持久化为历史。

## 验收标准

- [ ] `node-pty` 在 Electron 39 开发版和 `build:unpack` 中均验证可用，不使用普通 child_process 冒充交互式终端。
- [ ] 每个终端严格绑定 Task 和 ExecutionEnvironmentRef，Renderer 不能指定 executable、cwd、env 或跨 Task 控制进程。
- [ ] Agent Studio 持有的 Provider Key 和 App 私有 Secret 不注入终端初始环境；用户登录 Shell 启动脚本自行加载的凭据明确属于用户环境边界，不做过强“env 无任何 Secret”承诺。
- [ ] 输出有容量和 sequence 边界，raw scrollback 默认不持久化，文本脱敏明确为 best-effort。
- [ ] 用户终端、AppCommandRunner 和 Runtime tool 三类来源清晰；Project Action/Agent 命令不会通过向 PTY 写字符执行。
- [ ] 应用重启后旧 PTY 明确结束，不伪造进程或 scrollback 恢复。
- [ ] 目标 ESLint、相关 Vitest/组件测试、`pnpm typecheck`、`pnpm build`、`pnpm build:unpack`、`git diff --check` 通过，并完成 PTY 交互和 Secret 隔离走查。
