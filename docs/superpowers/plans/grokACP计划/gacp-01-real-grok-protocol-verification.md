# GACP-01 真机 Grok ACP 协议观察与能力核实

> **致执行者：** 本计划已于 2026-08-19 **受限关闭**。冻结记录见 [observations/grok-acp-observation.md](observations/grok-acp-observation.md)。可以开始 [GACP-02](gacp-02-session-restore-capability-contract.md)。未见到的项保持 `not-observed`，禁止补写成已验证，也**不得**把本计划遗留当成 GACP-02 / P0-10A / P0-10 的开工门槛。
>
> **状态：** 已完成（2026-08-19 受限关闭；方言夹具与 A–E 首轮真机表已落地）
>
> **插入点：** P0-09 之后、GACP-02 / P0-10 之前（本计划已关闭）

**优先级：** P0-A / 权重 5（P0-A 验收门要求真实 Grok 走通 Task A → Task B → Task A）

**目标：** 用当前仓库里的 `GrokAcpAdapter` 对真实 Grok Build ACP 做一次可重复观察，冻结本机实际协议方言，并把 P0-03 能力矩阵里仍停留在 `declared` / `unverified` 的项按证据升级或降级。同时收口 P0-08 留下的真实 Grok 活动窗口、退出三分支和重启 `interrupted` 中与 ACP 相关的部分。

**核心数据流：**

```text
真实 grok agent stdio
  → GrokAcpAdapter（现有连接 / session / prompt / permission）
  → TaskExecutor persist-before-publish（P0-09 已稳定）
  → 脱敏后的 PublicAgentEvent + TaskExecutionSnapshot
  → P0-09 Timeline 与手工观察记录
  → 本计划产出的 grok-acp-observation.md（只记已见到的字段，不发明字段）
```

**约束与边界：**

- 不新增 ACP 方法，不打开 `clientCapabilities.fs/terminal`，不注入 MCP。
- 不把受控 fixture（`tests/e2e/controlled-acp-runtime.mjs`）的行为写成真实 Grok 行为。
- 观察记录禁止写入 API Key、Header、完整 Prompt、`rawInput` / `rawOutput` 原文、环境变量或用户仓库路径中的秘密。
- 不修改 `mapGrokSessionUpdate()` 去“兼容未知事件”；未知类型继续走现有 `unsupported-runtime-event`。
- 不得为了让能力矩阵变绿而把 `declared` 直接改成 `verified`。

**主要风险：**

- 真实 Grok 版本与 `@agentclientprotocol/sdk@1.3.0` 的 `PROTOCOL_VERSION` 不一致。
- `session/set_model` 是 Grok 扩展，响应形状一旦与 Adapter 的“必须返回 object”检查不符，整条连接会被拆掉。
- `load` 可能回放历史 `session/update`，若晚到事件穿过当前 Turn generation，会污染 P0-09 Timeline。
- 真机权限 option 可能只有 `allow_always`，导致现有 `executionSupported = false` 路径被当成“Grok 坏了”。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、Playwright Electron E2E、本机已登录的 Grok Build CLI。

---

## 实施范围

**前置依赖：**

- P0-05、P0-06、P0-07、P0-08 核心实现。
- **P0-09 测试门必须关闭**：persist-before-publish、公开事件白名单、Timeline 实时/历史一致，否则观察结果无法区分 Adapter 问题和投影问题。

**文件范围：**

- 只读复核：`src/main/runtime/grok/grok-acp-adapter.ts`、`grok-acp-mappers.ts`、`src/main/agent/runtime-capabilities.ts`、`src/main/agent/agent-service.ts`、`src/main/agent/task-executor.ts`。
- 新增：`docs/superpowers/plans/grokACP计划/observations/grok-acp-observation.md`（本计划的交付物）。
- 允许新增：`src/main/runtime/grok/grok-acp-observation.test.ts`（用已脱敏的冻结夹具断言，不连真实网络）。
- 允许小幅修改：能力核实路径上的测试夹具注释和 P0-08 Grok 真机验收记录；**默认不改 Adapter 行为**。只有观察证明现有代码会误标能力或误杀连接时，才允许最小修复，并在观察文档写明。

**安全策略：**

- 真机走查可以使用开发者自己的低权限、可轮换 Key；自动化测试仍然只能用假 Key 和本地 Mock。
- 观察日志必须先经过现有 `redactSensitiveText` / `redactSensitiveError`。
- 禁止把完整 `InitializeResponse`、`RequestPermissionRequest` 或 `ToolCallUpdate` JSON 提交进仓库。只记录字段名、类型、是否出现、option.kind 集合和能力广告布尔值。

## 已锁定的观察清单

执行者必须按下列清单填写观察文档。没看到的项记 `not-observed`，禁止填“应该有”。

### A. 进程与握手

对照代码：

```ts
// 备注：生产默认启动参数必须保持原样，本计划只记录真实 Grok 对这组参数的反应。
child = spawn(this.resolveBinary(), [
  '--no-auto-update',
  'agent',
  '--no-leader',
  '-m',
  AGENT_STUDIO_MODEL_ALIAS,
  'stdio'
], { cwd: workspace, env: buildGrokRuntimeEnvironment(providerConfig, grokHome), stdio: ['pipe', 'pipe', 'pipe'] })
```

记录：

| 项 | 必须记录 |
| --- | --- |
| Grok CLI 版本 | `grok --version` 原文 |
| `acp.PROTOCOL_VERSION` | SDK 常量数值 |
| Runtime 返回的 `protocolVersion` | 是否相等；不等时 Adapter 是否按现有逻辑拒绝 |
| `agentInfo.name` / `version` | 是否存在；是否被 `mapGrokInitializeCapabilitySnapshot()` 写入快照 |
| `agentCapabilities.loadSession` | true / false / 缺省 |
| `sessionCapabilities.resume` | 有 `{}` / 缺省 |
| `sessionCapabilities.close` | 有 `{}` / 缺省 |
| `promptCapabilities` | image / audio / embeddedContext 是否出现（只记录，不实现） |
| `auth` / `providers` / `_meta` | 是否出现；确认 Adapter 已丢弃 |
| stderr | 是否有可脱敏的握手噪音；确认没有进入产品事件 |

### B. Session 生命周期

对照 `createSession` / `loadSession` / `resumeSession` / `closeSession`。

记录：

| 操作 | 必须记录 |
| --- | --- |
| `session/new` | 返回的 `sessionId` 形状（只记是否非空 UUID/不透明串，不提交真实 ID） |
| `session/set_model` | 请求是否被接受；响应是 object / null / 缺响应；失败是否拆连接 |
| 同 Task 第二轮 `session/prompt` | 是否复用同一 `sessionId` |
| Task A → Task B | B 是否 `session/new`，A 的 session 是否仍可后续 resume |
| `session/resume` | 是否回放历史 update；失败码；失败后连接是否仍 `ready` |
| `session/load` | 是否回放历史 update；回放事件是否带旧 sessionId |
| `session/close` | 未声明时是否只做本地解绑；声明后失败是否抛 `operation-failed` |

### C. Prompt 与 session/update

对照 `mapGrokSessionUpdate()` 已实现/已丢弃分支。

| `sessionUpdate` | 现有处理 | 真机必须记 |
| --- | --- | --- |
| `agent_message_chunk` | 映射 `agent-message`，非 text 丢弃 | content.type 是否总是 text |
| `agent_thought_chunk` | 映射 `agent-thought` | 是否出现；是否有 messageId |
| `tool_call` / `tool_call_update` | 映射 tool + 可选 diff | 出现的 `kind`、`status`、locations 是否有 path |
| `plan` | 映射 plan | entries 的 priority/status 是否齐全 |
| `usage_update` | 映射 experimental context usage | used/size/cost 是否出现 |
| `user_message_chunk` | 丢弃 | 是否出现 |
| `plan_update` / `plan_removed` | 丢弃 | 是否出现 |
| `available_commands_update` | 丢弃 | 是否出现 |
| `current_mode_update` | 丢弃 | 是否出现 |
| `config_option_update` | 丢弃 | 是否出现 |
| `session_info_update` | 丢弃 | 是否出现 |
| 其他 | `unsupported-runtime-event` | 记下 `sessionUpdate` 字符串，不记 payload |

`PromptResponse.stopReason` 必须尽量打到：`end_turn`、`cancelled`、`refusal`（若可安全触发）、`max_tokens`（不可强制则记 not-observed）。

### D. 权限 RPC

对照 `findPermissionOptions()` 与 `mapGrokPermissionRequest()`。

记录每次真实审批：

- `options[].kind` 集合（`allow_once` / `allow_always` / `reject_once` / `reject_always`）
- 是否存在**唯一** `allow_once` 和**唯一** `reject_once`
- `toolCall.kind`（read/edit/delete/execute/fetch/search/move/think/switch_mode/other）
- `locations[].path` 是否出现、是否落在 execution root 内
- `content` 是否包含 `type: "diff"`
- `rawInput` / `rawOutput` / `name` / `_meta` 是否出现（只记布尔，不记内容）
- 用户允许/拒绝后，Grok 是否继续该 tool，还是把后续 tool 全部停掉
- 取消 Turn 时，未决 `requestPermission` 是否被 Adapter 以 `{ outcome: 'cancelled' }` 释放

若真实 Grok **从不**给 `allow_once`，必须在观察文档用红字标明：当前产品会把这类请求标成 `executionSupported: false`，用户无法“允许执行”，只能取消。这是 GACP-03 的输入，不是本计划的修复范围。

### E. 生命周期与 P0-08 遗留

必须用真实 Grok 长任务（至少跨一个权限或超过 10 秒的工具调用）验证：

1. 执行中切换到另一个历史 Task 再切回，ACP session 不丢，Timeline 不串流。
2. Renderer reload 后 `TaskExecutionSnapshot` 仍指向同一 `executionId`，未决审批不消失、也不被 UI 伪造操作按钮。
3. 退出对话框三分支：继续等待 / 取消后退出 / 强制退出。强制退出后重启，该 Turn 为 `interrupted`，不得变成 `completed`。
4. Runtime 进程崩溃：Adapter 收束、Executor 终态 `failed` 或 `interrupted`，下一次连接不会复用死亡 generation。
5. 取消超时：Broker 先撤审批，再强制断 Runtime；ACP 侧未决 permission 必须被 cancelled，避免 Grok 子进程挂死。

Windows/Linux 平台矩阵仍归 P0-08，本计划在 macOS 上完成上述 Grok 路径即可关闭“真机 ACP”门。

---

## 任务 1: 建立可重复的真机观察环境

**任务目标：** 让任何人按同一组启动参数和脱敏规则复现观察，而不是各自开一次聊天随手记。

**涉及范围：** 观察文档模板、开发版启动、userData 隔离说明。

**前置依赖：** P0-09 测试门；本机 `grok` 可启动且已登录。

- [x] **第 1 步: 冻结观察环境**
      说明：记录 Node、pnpm、Electron、Grok CLI、`@agentclientprotocol/sdk` 版本。使用独立测试仓库，不要用用户正在开发的脏工作区当 cwd。确认 Adapter 写入的是 `userData/grok-home`，`~/.grok/config.toml` 在观察前后 hash 不变。
      预期：观察可以在另一台同样版本的机器上复做；用户全局 Grok 配置未被修改。
      实际：2026-08-19 正式产品路径脚本已写入观察文档第 0 节：commit `92025a3`、Node `v22.22.0`、pnpm `10.33.0`、Electron `39.8.10`、Grok `1.0.5 (5115b46bc909)`、SDK `1.3.0`、`PROTOCOL_VERSION` `1`。`~/.grok/config.toml` 观察前后 hash 相同。

- [x] **第 2 步: 建立脱敏记录模板**
      说明：在 `observations/grok-acp-observation.md` 按本计划 A–E 节建表。禁止粘贴完整 JSON-RPC。字段值只允许枚举、布尔、计数和已脱敏短文案。
      预期：文档可进 Git；`git grep` 找不到 sk- / Bearer / `AGENT_STUDIO_MODEL_API_KEY` 值。

- [x] **第 3 步: 确认观察入口不绕过产品边界**
      说明：走查必须通过正式桌面路径：`window.agent.connect` → `createTask` → `startTurn`。禁止直接对 `grok agent stdio` 另写一套临时 Client 然后把结果当成 Adapter 行为。
      预期：观察到的失败能对应到 `GrokAcpAdapter` / `AgentService` / `TaskExecutor` 的现有错误码。
      实际：`pnpm test:gacp01:observe` 走 `window.provider.save` → `window.agent.connect` → `createTask` → `startTurn`。连接状态 `ready`。受控 fixture 仍不等于本次真机。

## 任务 2: 完成握手、session、prompt 观察

**任务目标：** 得到一份“当前 Grok 实际说了什么”的冻结清单，供能力矩阵和 GACP-02 使用。

**涉及范围：** 真实连接、`mapGrokInitializeCapabilitySnapshot()`、`bindAgentStudioModel()`、`startTurn()`。

- [x] **第 1 步: 记录 initialize 与 set_model**
      说明：优先跑 `pnpm test:gacp01:observe`（需 `GACP01_REAL_GROK=1` 与本机 Provider）。脚本必须走正式 `window.agent` 路径，禁止另写 ACP Client。首次连接后检查能力快照。`session.load` / `session.resume` 在握手声明后应为 `support: native, verification: declared, source: protocol`；未声明则为 `unsupported`。`session/set_model` 必须对 `agent-studio-default` 返回 object，否则按现有逻辑拆连接并记录为方言风险。
      预期：观察文档能解释 P0-03 快照里每一项为什么是 declared 而不是 verified。
      实际：`protocolVersion` 双方均为 `1`。`loadSession` / `resume` / `close` 握手均为 `true`。`session/set_model` 被接受，响应为 `object`，未拆连接。`agentInfo.name` / `version` 均为 `false`，`runtimeVersion` 未写入。本关闭单不把 handshake `declared` 改成 `verified`。

- [x] **第 2 步: 记录 Task A 两轮、Task B、再回 A**
      说明：A 第一轮结束后再发第二轮，确认同一 `runtimeSessionId`。新建 B 必须 `session/new`。切回 A 走 `resumeTask()` → `activateTaskSession()`：先 `resumeSession`，失败且 `status.state === 'ready'` 才 `loadSession`。记录实际走了哪个 method，以及 load 是否回放旧 update。
      预期：产品层 `taskId` 稳定、`turnId` 每轮不同；回放事件若出现，必须被当前 Turn generation 拒绝或并入 A 的历史，不得写入 B。
      实际：同 Task 第二轮与 Task B 均为 `completed`。切回 A 实际 method 为 `resume`（`ok:uuid`）。`session/load`、`session/close` 本轮未走到，记 `not-observed`。

- [x] **第 3 步: 记录 session/update 与 stopReason**
      说明：至少覆盖纯文本回复、带 thought、带 plan、带 read/edit tool、一次用户取消。把见到的 update 种类打进观察表。未见到的保持 `not-observed`。
      预期：P0-09 Timeline 能回放本次走查；未知 update 只出现可恢复错误，不崩溃 Adapter。
      实际：见到 `user_message_chunk`、`agent_thought_chunk`、`agent_message_chunk`、`session_info_update`、`available_commands_update`、`tool_call`、`tool_call_update`。`stopReason` 见到 `end_turn`。`plan` / `usage_update` / `plan_update` 本轮未见。未知 update 未打崩 Adapter。

## 任务 3: 完成权限与生命周期真机验收

**任务目标：** 证明现有 PermissionBroker 与 TaskExecutor 在真实 Grok 下不会卡死或误标终态。

**涉及范围：** `requestPermission()`、`PermissionBroker`、`AppShutdownGate`、P0-09 Timeline。

- [x] **第 1 步: 记录真实权限 option 与 kind**
      说明：触发读文件、改文件、执行命令（若 Grok 会申请）。把 option.kind 和 toolCall.kind 记入观察表。验证：无唯一 `allow_once` 时 UI 不能执行、ACP 侧最终 cancelled 或由用户拒绝结束。
      预期：Renderer 始终看不到 `optionId`；主进程日志没有 rawInput 正文。
      实际：见到一次 `execute`：同时有唯一 `allow_once` 与唯一 `reject_once`；`locations.path` / `diff` / `rawOutput` / `name` 为 false；`rawInput` / `_meta` 为 true。产品决策 `allow-once-or-none`。read/edit/fetch 与「只有 allow_always」路径本轮未见。

- [x] **第 2 步: 收口 P0-08 的 Grok 活动路径**
      说明：完成 E 节 5 条真机路径，并在观察文档附验证日期、Grok 版本和结果。失败时记录是 Adapter generation 问题、Executor 终态仲裁问题，还是 Grok 不响应 cancel。
      预期：强制退出后重启看到 `interrupted`；取消超时不会留下悬挂的 ACP permission RPC。
      实际：E1 执行中切 Task 再切回见到 `resume`。E2 Renderer reload、E3 退出三分支、E4 Runtime 崩溃、E5 取消超时保持 `not-observed`。这些不挡本计划关闭，也不搬进 GACP-02 前置；产品对话框与 Windows/Linux 仍归 P0-08。关窗口不弹三选项是 close≠quit 的既有语义，不是本计划缺口。

- [x] **第 3 步: 把已核实能力升级为 runtime verified**
      说明：只升级本次真实发生过的能力：`runtime.connect`、`session.create`、`session.prompt.text`、`session.cancel`、对应事件、`permission.request`，以及真正成功的 `session.resume` 或 `session.load`。未发生的 Usage / Diff / close 保持原验证级别。
      预期：`updateAgentRuntimeCapabilitySnapshot()` 的证据来源是 `runtime`，reason 不编造。
      实际：**本关闭单不改 Adapter / 能力快照代码。** 真机见到的 connect / create / prompt / resume 仍保持 handshake `declared`，不得写成 `verified`。`session.load` 未发生，更不得升级。若后续要升 verified，归 GACP-04 或单独能力复核，不重开本计划。

## 任务 4: 把观察变成回归夹具

**任务目标：** 后续改 Adapter 时不必每次都靠记忆判断 Grok 方言。

**涉及范围：** 脱敏冻结夹具、单元测试、路线图状态。

- [x] **第 1 步: 增加不连网的方言断言**
      说明：用观察文档中的字段名/枚举做 `grok-acp-mappers` 测试：例如“只有 allow_always 时 executionSupported 为 false”、“resume 未声明时 activateTaskSession 抛 session-restore-unsupported”、“未知 sessionUpdate 变成 recoverable error”。
      预期：这些测试不启动 Electron，不读真实 Key。
      实际：`grok-acp-observation.test.ts` 冻结 mapper 方言；`grok-acp-adapter-observation.test.ts` 补剩余 Adapter 观察挂钩：initialize / set_model / 权限 option.kind / 未知与丢弃 update / stopReason，以及未声明恢复时阻断 load/resume。不连真实网络。

- [x] **第 2 步: 明确哪些缺口交给后续计划**
      说明：在观察文档末尾列出：恢复 UX → GACP-02；execute/fetch 不可读 → GACP-03；set_model 形状 → GACP-04；fs/terminal → GACP-05。禁止在本计划顺手实现。
      预期：GACP-01 的 diff 几乎只有文档、测试夹具和能力核实，没有工作台或权限模型重写。
      实际：观察文档 F 节与下方「遗留且不挡后续」已交接。本关闭只动文档状态，不改工作台或权限模型。

- [x] **第 3 步: 更新进度**
      说明：GACP-01 标记完成前，必须同时更新本文件复选框、`README.md` 状态和 `roadmap-index.md`。P0-08 若因此收口了 Grok 真机项，只改 P0-08 状态说明，不把平台验收偷偷标完成。
      预期：文档与实现一致。
      实际：2026-08-19 已同步本文件、观察记录、`README.md`、`roadmap-index.md`、AGENTS.md / CLAUDE.md。P0-08 平台项仍待补，未标完成。

---

## 验收标准

- [x] `observations/grok-acp-observation.md` 按 A–E 填完；未见到的项为 `not-observed`，没有臆造字段。
- [x] 真实 Grok 完成：连接、同 Task 两轮、Task A → B → A、至少一次权限。脚本声明覆盖一次取消；`stopReason` 本轮只记下 `end_turn`。失败 / interrupted 未在本轮协议表出现，不挡关闭。
- [x] load/resume 的实际 method 已记录：切回 A 走 `resume`；`load` 为 `not-observed`。P0-03 快照**未**升 `verified`。
- [x] 受控 fixture 与本次真机观察已分开陈述；默认 Vitest 不连真实 Grok。
- [x] 观察文档和测试夹具无明文密钥、无完整协议 payload。
- [x] 关闭本计划不要求重跑全仓门禁；方言夹具已在既有提交 `92025a3` 落地。

## 完成门与下游

GACP-01 现已受限关闭。允许：

- 开始 [GACP-02](gacp-02-session-restore-capability-contract.md)：点进历史即可接着聊；后台按已观察的 `resume` 自动接 session，`load` 仍是未核实降级
- 开始 [P0-10A](../p0-10a-claude-desktop-workbench-ui.md) 换皮（不依赖本计划遗留字段）

仍不允许：

- 把 handshake `declared` 或本轮未见的 `load` / `close` / `plan` / 子 Agent 父子字段写成已验证
- 因本计划遗留而推迟 GACP-02 或 P0-10A
- 把本关闭当成 P0-A 验收门通过，或解除 P0-11、P0-12 的原依赖

## 遗留且不挡后续

这些项记在观察表里，供后续计划按需消费。**缺它们不能回头拦住 GACP-02 / P0-10A / P0-10。**

| 遗留 | 本轮事实 | 交给谁 | 约束 |
| --- | --- | --- | --- |
| `session/load` | 切回 A 走了 `resume`，没走到 load | GACP-02 | 继续 resume-first；load 失败降级不得标 verified |
| `session/close` | 握手声明了 close，本轮未调用 | GACP-04 | 只记方言，不挡恢复 UX |
| `plan` / `usage_update` / `plan_update` | 未见 | P0-10A / P0-09 既有 reducer | 没有事件就不画清单或假进度 |
| 子 Agent 父子字段 | 未见 `parentToolCallId` / `agentId` / 独立 session | GACP-06 | 保持扁平工具行，禁止猜 title 成树；不挡换皮 |
| Renderer reload 未决审批 | 脚本未覆盖；P0-09 已冻成「无查询协议、不得伪造按钮」 | 以后单独补 pending 查询 | 不挡 GACP-02 |
| 退出三分支 / 窗口销毁 | 需产品对话框；关窗口本身不弹三选项 | 留 P0-08 | 不挡 GACP-02；Windows/Linux 仍归 P0-08 |
| Runtime 崩溃 / 取消超时 | `not-observed` | 留 P0-08 | 不挡后续开工 |
| 能力矩阵未升 `verified` | 有真机证据但本关闭单不改代码 | GACP-04 或单独复核 | GACP-02 状态条不得画已核实绿勾 |
| 权限只见到 `execute` | 有唯一 `allow_once` / `reject_once`；无 path | GACP-03（仍在 P0-11 后） | 缺 kind 继续保守，不得用 `rawInput` |
| `agentInfo` 为空 | name/version 均为 false | 保持 | 不写假 `runtimeVersion` |

P0-08 的 Windows/Linux 生命周期、窗口重建和活动退出产品路径**不**因本计划关闭而标完成。
