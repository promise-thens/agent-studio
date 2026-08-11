# P3-01 Capability Manifest、Action 契约与 Registry 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P3 / 权重 4（扩展能力的声明、兼容与启停事实源）

**目标：** 定义版本化 Capability Manifest、不可变 ActionDescriptor、受控 Host Binding 和 Capability Registry，让后续内置能力、MCP、Skills、浏览器与原生 Helper 都使用同一声明契约，而不获得任意本地代码、IPC、文件系统或 Shell 入口。

**核心数据流：** 主进程从 App 内置清单和受控安装根读取 Manifest，经大小、路径和 schema 校验后解析为不可变 CapabilityDescriptor；CapabilityHostRegistry 校验 host binding，CompatibilityEvaluator 根据 App 版本、平台、核心服务和已验证 Agent capability 生成可用性证据；CapabilityRegistry 持有 discovered、invalid、incompatible、disabled、enabled 状态并向 Renderer 返回脱敏摘要。真正执行 action 时，P3-02 只能按 capabilityId、version、manifestHash 和 actionId 取得 Registry 描述符，再进入 CapabilityExecutor 与 Permission Broker。

**约束与边界：** 本计划只建立声明、发现、兼容、启停和查询，不执行 action、不授予权限、不写执行审计，也不实现插件市场、远程下载安装、自动更新或复杂签名体系。Manifest 的 `host.bindingId` 只能绑定主进程预注册 Host Adapter，不能等价为可 `import()` 的任意路径、可执行文件、IPC channel 或 Shell 命令。文件、命令、Git、Worktree、Timeline、Changes 和 Artifact 是核心服务，不作为插件重复实现。

**主要风险：** Manifest 可能伪造身份、扩大 operation、声明不存在的 host、通过路径逃逸加载代码，或在升级后继续沿用旧兼容/授权事实；通过固定 schema、受控根目录、Host Registry、不可变 manifestHash、版本化启停记录、兼容证据和默认不可用状态规避。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest。

---

## 实施范围

**前置依赖：**

- 依赖 P0-A 验收门；复用中性 Agent capability、P0-04 固定 IPC 约束和 P0-07 OperationIntent 风险分类。
- 不依赖 Codex Runtime；Grok、Codex 或未来 Runtime 只能通过已验证 capability 要求参与兼容判断。

**文件范围：**

- 创建 `src/shared/capability.ts`，定义可序列化 Manifest 摘要、ActionDescriptor、兼容证据、Registry 状态和 IPC DTO。
- 创建 `src/main/capability/manifest-schema.ts`、`capability-loader.ts`、`capability-host-registry.ts`、`capability-compatibility.ts`、`capability-registry.ts` 及就近测试。
- 创建 `capabilities/builtin/` 下的只读内置示例 Manifest 和无真实副作用的测试 fixture。
- 创建固定 Capability 查询/启停 IPC、窄 Preload API 和设置页 `CapabilityPackList.vue`；Renderer 不读取 Manifest 文件或 host binding 原值。

**安全策略：**

- 只扫描 App 内置根与 `userData` 下的固定安装根；先校验 realpath、目录所有权、符号链接、文件类型、数量、单文件字节和总解析时间。
- Manifest 只声明数据，Loader 和 Registry 均不得动态导入 `entry`；首期只有主进程静态注册的 Host Adapter 可以解析 `host.bindingId`。
- 未知 manifestVersion、host kind、operationType、resultKind、核心服务或 Agent capability 一律进入 invalid/incompatible，不使用宽松默认值。
- Registry 向 Renderer 返回 id、displayName、version、有限说明、状态、兼容原因和 action 摘要，不返回安装绝对路径、内部 binding、原始异常或任意 schema 正文。

## 已锁定 Manifest 与 Action 契约

- CapabilityManifest 至少包含 manifestVersion、id、version、displayName、description、host、compatibility 和 actions；id/version/manifestHash 共同确定一次不可变发布身份。
- `host` 只包含允许的 kind、bindingId 和可选最小 Host 版本；builtin、MCP、Skills、browser、native-helper 等 Host 由对应计划在主进程注册，Manifest 不能自行创造 Host。
- `compatibility` 使用 App 版本、平台、requiredCoreServices 和 requiredAgentCapabilities 表达要求；禁止仅靠合成的 `supportedRuntimes` 名单把通用能力永久绑死到 Grok 或 Codex。
- 每个 ActionDescriptor 至少包含 actionId、displayName、输入 schema、OperationIntent 模板、environmentScope、resultKinds、timeoutMs 和 cancellable；实际 Project、Task、Turn、environment、目标和参数由 P3-02 在调用时绑定。
- resultKinds 只允许有限摘要以及 `command-evidence-ref`、`change-set-ref`、`validation-ref`、`artifact-ref` 等核心事实引用；Capability 不得返回另一套原始 Timeline、Diff、Git 基线、审计记录或无限输出。
- CapabilityActionResult 只包含 invocationId、descriptor revision、终态、有限摘要和与 resultKinds 匹配的核心事实引用；原始 handler 输出不得直接进入 Renderer、TaskStore 或审计存储。
- Registry 是发现、兼容、启停和 descriptor revision 的唯一事实源；Permission Broker、CapabilityExecutor、TaskStore 和 Renderer 不复制 enabled/incompatible 状态。

### 任务 1: 冻结 Manifest、Action 与结果契约

**任务目标：**

- 让每个 Capability 在任何代码执行前先明确身份、兼容要求、可调用 action、风险模板和结果去向。

**涉及范围：**

- `src/shared/capability.ts`、manifest schema、契约测试和内置 fixture。

**前置依赖：**

- P0-A 已定义 Agent capability、OperationIntent、Project、Task、Turn 和 environment 身份。

- [ ] **第 1 步: 定义 CapabilityManifest 身份与版本**

说明：固定 manifestVersion、id、version、displayName、description、host、compatibility 和 actions；限制字符串、数组、schema 深度与总字节，拒绝重复 actionId、未知字段、空版本和大小写冲突 id。

预期：同一 id/version 内容变化会得到不同 manifestHash，未知 manifestVersion 不会被旧 Loader 误读。

- [ ] **第 2 步: 定义不可变 ActionDescriptor**

说明：为每个 action 固定输入 schema、OperationIntent 模板、environmentScope、resultKinds、timeoutMs 和 cancellable；OperationIntent 模板只声明 operationType、允许目标类型和最低风险，不能预先授权实际目标。

预期：P3-02 无需重新定义 Action 契约，也不能把 read-project action 临时升级为 execute-command、network-egress 或 screen-control。

- [ ] **第 3 步: 固定结果路由契约**

说明：定义 CapabilityActionResult，并让 resultKinds 只描述 action 允许产生的结果类别；Timeline 摘要、Command Evidence、Changes、Validation 和 Artifact 的真实记录继续由对应核心服务创建，Capability 只获得或返回受限引用。

预期：插件结果可以进入同一 Task 审阅链，但不会形成第二套 Timeline、Diff、Validation 或 Artifact 存储。

- [ ] **第 4 步: 建立 schema 与序列化测试**

说明：覆盖合法最小/完整 Manifest、未知版本、重复 action、超深 schema、超长文本、非法 operation/result、循环或不可序列化输入，以及 manifestHash 稳定性。

预期：相同规范化 Manifest 产生稳定 hash，所有非法输入在注册前以有限原因拒绝。

### 任务 2: 实现受控发现、Host Binding 与兼容判断

**任务目标：**

- 只从受控位置发现声明，并证明声明绑定到 App 已知 Host 和当前可用核心能力。

**涉及范围：**

- capability-loader、capability-host-registry、capability-compatibility 和安全测试。

**前置依赖：**

- 依赖任务 1 的 Manifest 与 Action schema。

- [ ] **第 1 步: 实现受控 Manifest Loader**

说明：扫描固定内置根和 `userData/capabilities`，限制目录深度、包数量、Manifest 名称与字节；对根目录和文件执行 realpath/所有权/符号链接校验，单个失败不阻断其它包加载。

预期：Project、Renderer、Prompt 和 Capability 自身不能扩大扫描根或读取任意 Manifest 路径。

- [ ] **第 2 步: 实现 CapabilityHostRegistry**

说明：主进程按 host kind 与 bindingId 静态注册 Host Adapter 摘要；Loader 只验证 binding 存在、版本满足和 action 支持，不动态 `import()` Manifest 指定路径，也不把 handler 返回 Renderer。

预期：伪造 entry、可执行路径、IPC channel、Shell 命令或未注册 binding 的 Manifest 均不可进入 enabled。

- [ ] **第 3 步: 实现兼容证据**

说明：根据 App 版本、平台、Host 版本、requiredCoreServices 和 requiredAgentCapabilities 生成 compatible/incompatible 证据；Runtime capability 必须来自 P0-03 的已验证快照，未知或过期证据不按支持处理。

预期：通用 Capability 可服务多个 Runtime；确有协议要求时按 capability 判断，而不是靠显示名称猜测 Runtime 兼容。

- [ ] **第 4 步: 生成有限失败摘要**

说明：为 invalid、host-missing、version-mismatch、core-service-missing、agent-capability-unverified、platform-unsupported 和 path-rejected 返回稳定原因码与修复建议，原始路径和异常先脱敏。

预期：一个坏包不会让 Registry 整体不可用，用户也不会只看到模糊“插件加载失败”。

### 任务 3: 建立 Registry 启停、版本变化与持久化

**任务目标：**

- 让发现、兼容、启停和 revision 只有一个主进程事实源，并在升级或状态漂移时使旧引用失效。

**涉及范围：**

- capability-registry、版本化设置存储、固定 IPC 和状态测试。

**前置依赖：**

- 依赖任务 2 的 descriptor 与兼容证据。

- [ ] **第 1 步: 构建不可变 Registry Snapshot**

说明：按 capabilityId 保存当前 descriptor、manifestHash、host binding 摘要、compatibility evidence、enabled、revision 和最近验证时间；读取返回冻结副本，不暴露内部 Map 或 handler。

预期：Renderer、Runtime 和 Capability 无法原地修改 Registry 状态或 descriptor。

- [ ] **第 2 步: 实现确认后的启用与禁用**

说明：Renderer 只提交 capabilityId、目标 enabled 和 expectedRevision；主进程重新校验 Manifest、兼容性与调用方后原子写入 `userData` 下版本化设置。启用只代表允许 P3-02 接收调用，不等于预先批准任何 operation。

预期：重复点击、旧 revision、无效或不兼容包不会产生乐观启用；禁用后新调用立即拒绝。

- [ ] **第 3 步: 处理升级、移除与能力证据失效**

说明：Manifest hash、Host 版本、App 版本、平台或 Agent capability evidence 变化时递增 revision 并重新计算状态；旧 descriptor 和 P3-02 未来授权键不能重新变为活动引用。

预期：升级、降级、删除、Host 卸载或 Runtime capability 变化不会静默沿用旧 action 或旧授权。

- [ ] **第 4 步: 实现原子存储与损坏降级**

说明：设置文件使用临时文件、fsync/rename、权限收紧和 schemaVersion；损坏、未知新版本或写入失败时保留 Manifest 发现结果，但所有非内置默认能力回到 disabled，并返回有限原因。

预期：磁盘故障不会把 Capability 默认放行，也不会覆盖可恢复的旧设置。

### 任务 4: 实现只读管理界面并完成验收

**任务目标：**

- 让用户看见每个 Capability 的来源、版本、Host、action、兼容证据和启停状态，同时证明 Registry 不拥有执行与权限事实。

**涉及范围：**

- 固定 IPC、Preload、`CapabilityPackList.vue`、组件测试和 Electron 走查。

**前置依赖：**

- 依赖任务 1 至任务 3。

- [ ] **第 1 步: 建立固定查询与启停 IPC**

说明：提供 list、read-summary 和 set-enabled 三类固定入口；Handler 复用 P0-04 的主窗口来源、UTF-8 大小、revision、频率和错误脱敏校验，不暴露通用 invoke、安装路径或 host binding 原值。

预期：跨窗口、子 frame、过期 revision 和伪造 capabilityId 在修改状态前被拒绝。

- [ ] **第 2 步: 实现 Capability 管理列表**

说明：展示 displayName、id/version、来源类别、Host 类别、兼容状态、有限原因、action 摘要和 enabled；invalid 包只显示安全摘要，不提供“强制运行”。

预期：用户能区分未安装、无效、不兼容、已禁用和已启用，不把 enabled 误解为已授予高风险权限。

- [ ] **第 3 步: 验证内置示例与恶意 fixture**

说明：使用只读项目元数据示例覆盖正常注册；使用路径逃逸、未知 Host、伪造 Shell/IPC、重复 action、超大 schema、版本冲突、Host 消失和 capability evidence 过期 fixture 验证拒绝与降级。

预期：只有受控、兼容、显式启用的 descriptor 可被 P3-02 查询，任何 Manifest 都不能直接触发副作用。

- [ ] **第 4 步: 完成自动验证与开发版走查**

说明：在 Node.js 20+、pnpm 10.x 下运行目标/完整 ESLint、相关 Vitest、typecheck、build 和 diff-check；开发版走查发现、查看、启用、禁用、重启恢复、升级失效和损坏设置降级。

预期：验证证据能证明 Registry 是声明与状态事实源，而非执行器、权限系统或第二套任务工作台。

## 验收标准

- [ ] Manifest、ActionDescriptor、Host Binding、compatibility evidence 和 resultKinds 均有固定、限长、版本化 schema；未知值默认 invalid/incompatible。
- [ ] Capability 只绑定主进程预注册 Host Adapter；Manifest 无法指定任意模块路径、可执行文件、IPC channel、Shell 命令或 Renderer 入口。
- [ ] ActionDescriptor 明确输入、OperationIntent 模板、environmentScope、结果类别、超时和取消，P3-02 无需重新定义通用 Action 契约。
- [ ] Registry 是发现、兼容、启停和 revision 的唯一事实源；启用不等于授权，升级、移除或 capability evidence 变化会使旧引用失效。
- [ ] Capability 输出只能成为既有 Timeline、Command Evidence、Changes、Validation 与 Artifact 的有限摘要或引用，不创建平行事实存储。
- [ ] Renderer 只能获得脱敏摘要和固定启停入口，无法读取安装绝对路径、原始 Manifest、Host handler 或任意执行能力。
- [ ] 相关核心函数、Loader、Host Registry、IPC 和异常降级均有中文 TSDoc；测试只使用本地 fixture、假数据和临时目录。
- [ ] 目标/完整 ESLint、相关 Vitest/组件测试、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过，并完成 Registry 生命周期 Electron 走查。
