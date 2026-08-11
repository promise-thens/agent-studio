# P2-01 Codex Runtime 认证、状态隔离与生命周期 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P2 / 权重 5（第二 Runtime 的可信入口）

**目标：** 在完全独立于用户默认 Codex 状态的 App 专属目录中，完成 Codex binary 发现、版本与 schema 门禁、app-server 受控进程、JSON-RPC transport、账号状态及 ChatGPT 登录生命周期，为后续 Thread/Turn Adapter 提供稳定连接和可验证能力证据。

**核心数据流：** Renderer 只通过固定 Agent/Runtime IPC 请求发现、连接、读取账号、登录、取消、退出和断开；主进程由 `CodexBinaryResolver` 选择可信 binary，`CodexStateRoot` 创建 App 专属 `CODEX_HOME`，`CodexProcessSupervisor` 启动 app-server，`CodexAppServerTransport` 完成 `initialize` 与协议门禁，`CodexAccountService` 调用 `account/read`、`account/login/start`、`account/login/cancel` 和 `account/logout`；Renderer 只接收脱敏状态摘要。

**约束与边界：** 不读取、复制、迁移或修改用户默认 `~/.codex`、`auth.json`、config、session、skills 和日志。ChatGPT token 的保存与刷新由 app-server 管理，Agent Studio 不读取或复制 token；Agent Studio Provider API Key 继续只由 Electron `safeStorage` 持有，不通过 Codex native API-key login 形成第二份持久化。本计划不实现 Thread、Turn、命令、文件变化、Diff 或审批映射，也不自动下载、升级或替换 Codex binary。

**主要风险：** PATH 劫持、未知 binary/schema、App 专属状态意外回落到 `~/.codex`、凭据后端跨状态根共享、JSON-RPC 失控、进程悬挂和登录状态漂移；通过 canonical binary、版本/schema gate、独立状态根、凭据隔离实测、消息上限、请求账本、受控重启和明确 incompatible 状态规避。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、Codex app-server 当期官方 schema。

---

## 实施范围

**前置依赖：**

- 仅硬依赖 P0-A 验收门。
- P1-06、P1-07、P1-08 只影响后续 `app-provider` 模式，不阻塞 account-backed Codex 生命周期。

**文件范围：**

- 创建 `src/main/runtime/codex/codex-binary-resolver.ts`、`codex-state-root.ts` 及就近测试。
- 创建 `src/main/runtime/codex/codex-process-supervisor.ts`、`codex-app-server-transport.ts`、`codex-account-service.ts` 及就近测试。
- 创建 `src/main/runtime/codex/codex-app-server-adapter.ts`，只承载本计划的连接、账号和能力入口。
- 修改 AgentService、Runtime capability matrix、固定 IPC/Preload API 和 Runtime 设置 UI。
- Codex 原始 schema、JSON-RPC fixture 和私有 ID 只存在于 `src/main/runtime/codex/`。

**安全策略：**

- app-server 固定使用 `app.getPath('userData')` 下的独立 `CODEX_HOME` 与 `CODEX_SQLITE_HOME`；目录在启动前创建并验证，Renderer/Project 不能指定路径。
- 启动环境显式剥离 Agent Studio Provider Secret、项目 Secret 和无关调试变量，不修改全局 `process.env`。
- Renderer 不接收 token、完整账号 ID、OAuth state、完整 browser auth URL、原始 stderr、RPC payload 或 app-server 环境。
- Browser 登录 URL 由主进程校验允许的 HTTPS origin 后直接打开；device-code 只短时展示允许字段，不落盘、不记普通日志。
- 如果当前 Codex 凭据后端无法证明与用户默认登录隔离，则 managed login 标记 unavailable，不回退到共享 `~/.codex` 或由 Agent Studio 复制 token。

## 已锁定状态与凭据所有权

- Agent Studio 持有 binary 引用、进程状态、连接状态、协议证据和有限账号摘要。
- app-server 持有 ChatGPT OAuth token 的保存、刷新和退出生命周期。
- Agent Studio Provider Store 持有 App Provider API Key；P2-01 不调用 `account/login/start` 的 API Key 模式保存该 Key。
- Renderer 只能看到 `signedIn`、有限 `authMode`、`planType`、脱敏账号提示、`requiresOpenaiAuth`、状态 revision 和最近确认时间。
- `account/logout` 只能影响 Agent Studio 独立状态根对应的账号，不得退出用户默认 Codex。
- Supervisor 是进程与连接状态唯一事实源；Adapter、设置页和 Renderer 不复制 running/crashed/ready 状态机。

### 任务 1: 建立可信 Binary、版本与 Schema 门禁

**任务目标：**

- 只有来源、版本和协议均通过验证的 Codex binary 才能进入 app-server 启动路径。

**涉及范围：**

- binary resolver、schema fixture、版本策略、能力矩阵和测试。

**前置依赖：**

- 应用已进入 `app.whenReady()`，Node.js 与 pnpm 版本满足项目基线。

- [ ] **第 1 步: 定义 Binary 候选与信任规则**

说明：主进程只从受控候选来源发现 binary，例如已验证的 App bundled 路径、用户在设置页明确选择并持久化的绝对路径、以及受限 PATH 搜索结果；所有路径解析 realpath，验证普通可执行文件、所有者、权限和存在性。Renderer 只能选择文件，不得直接提交任意命令、参数或 shell 字符串。

预期：PATH 劫持、项目目录伪造 binary、不可执行文件和可疑可写路径在运行前被拒绝。

- [ ] **第 2 步: 查询版本并记录 BinaryEvidence**

说明：使用绝对路径、固定参数数组和 `shell: false` 执行只读版本查询；记录 realpath、版本、文件指纹、来源、验证时间和支持范围。binary 路径、版本或指纹变化后旧证据立即过期。

预期：未知版本、低于最低版本或未在支持范围内的版本返回 `incompatible`，有活动 Task 时不热切换 binary。

- [ ] **第 3 步: 生成并锁定协议 Schema**

说明：开发/验收阶段使用目标 Codex 版本的 `app-server generate-ts` 或 `generate-json-schema` 生成 fixture，保存版本和 hash；运行时验证必须方法、字段和通知。生成物不包含账号或会话数据。

预期：schema 与 binary 版本一一对应，缺少稳定认证/生命周期方法时不会继续连接。

- [ ] **第 4 步: 完成 Initialize 与 Capability Gate**

说明：transport 建立后先发送一次 `initialize` 再发送 `initialized`；验证平台、所需稳定方法和客户端能力。experimental 方法只有对应后续计划明确启用并有 fixture 时才允许使用。

预期：重复 initialize、初始化前请求、协议不兼容和 capability 缺失都有有限错误码，基础握手成功不等于完整 Agent 兼容。

### 任务 2: 建立 App 专属 Codex 状态根与凭据边界

**任务目标：**

- 让 Agent Studio 的 Codex 配置、认证、日志和会话与用户默认 Codex 完全分开。

**涉及范围：**

- state root、目录权限、Runtime 环境、凭据隔离验证和测试。

**前置依赖：**

- 依赖任务 1 的可信 binary 和版本证据。

- [ ] **第 1 步: 创建独立状态目录**

说明：在 `userData/runtime/codex/home` 与 `userData/runtime/codex/sqlite` 创建固定目录，尽量使用 `0700`；启动前拒绝符号链接替换、所有权异常、非目录和 project/Renderer 自定义路径。`CODEX_HOME` 官方要求目录已存在，必须先完成创建再启动。

预期：app-server 的 config、auth、log、session、skills 元数据和 SQLite 状态均落入 App 专属根，不触碰 `~/.codex`。

- [ ] **第 2 步: 构造最小 App-server 环境**

说明：显式设置 `CODEX_HOME`、`CODEX_SQLITE_HOME` 和启动所需的最小系统变量；删除所有 Agent Studio Provider Key、Authorization、项目临时 Secret 和无关调试变量。不得继承父进程已有的默认 `CODEX_HOME`。

预期：即使主进程已登录默认 Codex 或持有 Provider Secret，本计划启动的 app-server 仍只看到独立状态和最小环境。

- [ ] **第 3 步: 验证 ChatGPT 凭据后端隔离**

说明：使用 Codex 官方支持的凭据后端，在目标平台验证登录、刷新和退出是否只影响 App 专属状态；不读取、复制、比较或记录 token 内容。测试前后只比较状态根、有限账号摘要和默认 Codex 登录是否保持不变。

预期：Agent Studio 登录/退出不改变默认 `~/.codex` 文件或默认 Codex 登录；无法证明隔离时禁用 managed login 并返回明确原因。

- [ ] **第 4 步: 固定 App Provider Key 所有权**

说明：明确拒绝把 Agent Studio Provider Key 作为 Codex native API-key login 交给 app-server 持久化。P2-04A 的 `app-provider` 分支只能消费 safeStorage 引用，并在可证明工具子进程 Secret 隔离时生成短生命周期 Runtime 配置。

预期：同一个模型 Key 不存在 Agent Studio 与 Codex 两套持久化事实源。

### 任务 3: 实现 JSON-RPC Transport 与进程 Supervisor

**任务目标：**

- 在主进程中安全持有 app-server 的启动、消息、退出、崩溃和诊断生命周期。

**涉及范围：**

- process supervisor、transport、请求账本、日志脱敏和故障测试。

**前置依赖：**

- 依赖任务 1、任务 2 的 binary 与状态根。

- [ ] **第 1 步: 无 Shell 启动 App-server**

说明：使用已验证 absolute binary、固定 `app-server` 参数、`shell: false` 和独立 stdio 启动；记录 PID 所有权、启动时间、状态 revision 和退出监听，不将 stderr 直接继承到普通日志。

预期：项目内容、Prompt 和 Renderer 输入不能改变可执行文件、参数、cwd 或环境。

- [ ] **第 2 步: 实现有界 JSON-RPC Transport**

说明：限制单消息字节、JSON 深度、待处理请求数、写队列、通知缓冲和方法级超时；每个请求使用唯一 ID。畸形 JSON、未知响应、超大帧、重复 response 和孤儿 response 必须安全丢弃或收束。

预期：原始 RPC payload 不进入 shared、Renderer、普通日志或测试快照，消息洪泛不会拖垮主进程。

- [ ] **第 3 步: 实现 Supervisor 状态机**

说明：状态至少覆盖 stopped、discovering、starting、initializing、ready、auth-required、incompatible、stopping、crashed 和 failed；只允许单向合法迁移，状态由 Supervisor 单一持有。

预期：UI 能区分 binary 缺失、协议不兼容、未登录、连接失败和崩溃，不用一个 `connected=false` 混合所有原因。

- [ ] **第 4 步: 实现崩溃、重启与关闭**

说明：空闲时可执行有界退避重启，达到上限停在 failed；活动 Turn 期间崩溃由 TaskExecutor 收束为 interrupted，重启后不恢复或重放旧 Prompt。应用退出先请求正常关闭，超时后只终止已确认属于本 App 的进程组。

预期：不存在孤儿 app-server、无限重启、跨 Task 自动恢复或旧执行副作用重放。

- [ ] **第 5 步: 统一 Stderr 与诊断脱敏**

说明：stderr 进入有界环形缓冲前脱敏 token、Header、账号、用户路径和环境片段；Renderer 只获得错误码、时间、是否可重试和有限修复建议。

预期：保留诊断能力，但不会向 Renderer 或日志暴露 Secret 和完整环境。

### 任务 4: 实现账号读取、登录、取消与退出

**任务目标：**

- 用 app-server 官方账号 API 完成可确认、可取消、可退出且不泄漏凭据的登录体验。

**涉及范围：**

- account service、固定 IPC、设置 UI、Mock 和 Electron 走查。

**前置依赖：**

- 依赖任务 3 的 initialized transport。

- [ ] **第 1 步: 实现 Account Read 与状态通知**

说明：初始化成功后调用 `account/read`，并消费 schema 已验证的 `account/updated`；公开摘要包含 signedIn、有限 authMode、planType、requiresOpenaiAuth、脱敏账号提示、revision 和最近确认时间。

预期：未登录、无需 OpenAI 登录、账号过期、状态未知和已登录被分别展示；Renderer 不获得 token 或完整账号 ID。

- [ ] **第 2 步: 实现 ChatGPT Managed Login**

说明：首期开放已验证的 `chatgpt` browser flow，可选开放已验证的 `chatgptDeviceCode`。用户显式点击后调用 `account/login/start`，同一时刻只允许一个 pending login。browser auth URL 由主进程校验并直接打开；device-code 只返回官方 verification URL、短时 userCode 和过期时间。

预期：登录成功、失败、用户关闭浏览器、回调超时、打开浏览器失败和 device code 过期都有明确状态，不把 OAuth state 写入日志或 Renderer store。

- [ ] **第 3 步: 实现 Login Cancel**

说明：取消请求必须匹配当前 loginId 与 revision，再调用 `account/login/cancel`；重复取消幂等。进程关闭、登录完成或账号状态变化时清理 pending login。

预期：旧 loginId 无法取消新登录，也不会留下永久“登录中”。

- [ ] **第 4 步: 实现 Account Logout**

说明：UI 明确提示只退出 Agent Studio 独立 Codex 账号；主进程复核 account revision 后调用 `account/logout`，成功后重新执行 `account/read`，不先乐观显示已退出。

预期：退出不修改默认 Codex 登录，不删除 Task 历史，也不影响 Agent Studio Provider Profile。

- [ ] **第 5 步: 建立固定 IPC 与设置状态**

说明：IPC 只提供 discover/connect/disconnect/getStatus/startLogin/cancelLogin/logout；Handler 复用 P0-04 的可信主窗口、main frame、UTF-8 大小、频率和错误脱敏校验。UI 覆盖 missing、incompatible、starting、signed-out、login-pending、signed-in、cancelling、logging-out、crashed 和 retry。

预期：所有状态都由主进程确认后显示，Renderer 无任意 Runtime method 或 binary 执行入口。

- [ ] **第 6 步: 完成自动测试与开发版走查**

说明：Mock 覆盖可信/恶意 binary、版本不兼容、schema 漂移、启动超时、畸形/超大 RPC、stderr Secret、崩溃退避、已登录、未登录、登录成功/失败/取消/超时、重复请求、退出和凭据后端不可用。开发版使用受控账号验证独立登录与退出，并确认默认 `~/.codex` 和默认登录未变化。

预期：自动化不使用真实付费请求或真实 Key；开发版证据区分进程可用、登录可用与完整 Agent 工作流尚未完成。

## 验收标准

- [ ] P2-01 仅依赖 P0-A，不因 P1-07 的未来 Codex binding 形成反向依赖。
- [ ] app-server 始终使用 Agent Studio `userData` 下的独立 `CODEX_HOME`/`CODEX_SQLITE_HOME`；启动、登录、退出和崩溃恢复均不读写默认 `~/.codex`。
- [ ] ChatGPT token 只由 app-server 的已验证凭据后端持有；Agent Studio Provider Key 只由 safeStorage 持有。
- [ ] Binary realpath、权限、版本、schema 和 initialize capability 全部通过后才能进入 ready。
- [ ] Supervisor 是进程和连接状态唯一事实源；消息、请求、stderr、重启和关闭均有明确上限。
- [ ] 登录、取消和退出绑定正确 revision/loginId，未经用户显式操作不会改变登录态。
- [ ] Renderer 无法获得任意 binary 执行入口、完整 auth URL、token、账号 ID、原始环境、RPC payload 或 stderr。
- [ ] 崩溃或重启不会自动恢复 Turn、重放 Prompt 或扩大授权。
- [ ] 新增核心函数、进程环境、IPC、认证和异常降级均有中文 TSDoc；测试只使用 Mock、假凭据和临时目录。
- [ ] Node.js 20+、pnpm 10.x 下通过目标/完整 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check`，并完成 Electron 独立登录走查。
