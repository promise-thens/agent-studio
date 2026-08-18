# GACP-01 真机 Grok ACP 观察记录

> 本文件是 [GACP-01](../gacp-01-real-grok-protocol-verification.md) 的交付物。只记已经见到的字段、枚举、布尔和计数。没见到写 `not-observed`，禁止补“应该有”。
>
> **状态：** 模板已建立，环境版本已冻结；A–E 真机字段待开发版桌面走查填写。

## 观察入口（不得绕过）

真机走查必须走正式桌面路径：

```text
开发版 Agent Studio
  → window.agent.connect
  → createTask
  → startTurn
  → Timeline / 权限弹窗 / 退出对话框
```

禁止：

- 另写一套临时 `grok agent stdio` Client，再把结果当成 `GrokAcpAdapter` 行为。
- 用 `tests/e2e/controlled-acp-runtime.mjs` 或受控 fixture 填本表。
- 在 CI 或 `pnpm test` 里连真实 Grok。

推荐入口：本机设置 `GACP01_REAL_GROK=1` 后跑 `pnpm test:gacp01:observe`。脚本启动隔离开发版 Electron，走 `window.agent.connect → createTask → startTurn`。

观察到的失败必须能对应到现有错误码：`GrokAcpAdapter` / `AgentService` / `TaskExecutor`。

## 脱敏规则

允许写入：字段名、类型、是否出现、枚举、计数、已脱敏短文案、产品错误码。

禁止写入：API Key、Bearer、`AGENT_STUDIO_MODEL_API_KEY` 值、Header、完整 Prompt、`rawInput` / `rawOutput` 原文、环境变量值、完整 JSON-RPC、`InitializeResponse` / `RequestPermissionRequest` / `ToolCallUpdate` 全文、用户仓库绝对路径中的秘密。

`sessionId` 只记形状（非空 UUID / 不透明串），不提交真实 ID。

---

## 0. 观察环境

| 项 | 值 |
| --- | --- |
| 记录日期 | 2026-08-18 |
| OS | Windows |
| Agent Studio commit | `48fbab9` |
| Node | `v24.11.0` |
| pnpm | `10.33.0` |
| Electron（已安装） | `39.8.10`（`package.json` 声明 `^39.2.6`） |
| Grok CLI | `grok 1.0.0 (3cd0d0cbce)` |
| `@agentclientprotocol/sdk` | `1.3.0` |
| `acp.PROTOCOL_VERSION` | `1` |
| 启动参数 | `grok --no-auto-update agent --no-leader -m agent-studio-default stdio` |
| `clientCapabilities` | `{}` |
| `mcpServers` | `[]` |
| 观察 cwd | 待建独立可丢弃 Git fixture；禁止使用本仓库脏工作区 |
| App `GROK_HOME` | 预期 `userData/grok-home`；走查前确认 |
| `~/.grok/config.toml` 观察前 hash | `not-observed` |
| `~/.grok/config.toml` 观察后 hash | `not-observed` |
| hash 是否不变 | `not-observed` |

复现要求：另一台机器只要 Node / pnpm / Electron / Grok CLI / SDK 与上表一致，就可以按同一启动参数重做。用户全局 `~/.grok` 不得被修改。

---

## A. 进程与握手

对照 `GrokAcpAdapter` 生产启动参数和 `mapGrokInitializeCapabilitySnapshot()`。

| 项 | 结果 |
| --- | --- |
| Grok CLI 版本原文 | `grok 1.0.0 (3cd0d0cbce)`（本机命令行；握手 `agentInfo.version` 仍为 `not-observed`） |
| `acp.PROTOCOL_VERSION` | `1` |
| Runtime 返回的 `protocolVersion` | `not-observed` |
| 版本是否相等 | `not-observed` |
| 不等时 Adapter 是否拒绝 | `not-observed` |
| `agentInfo.name` 是否存在 | `not-observed` |
| `agentInfo.version` 是否存在 | `not-observed` |
| 是否写入能力快照 `runtimeVersion` | `not-observed` |
| `agentCapabilities.loadSession` | `not-observed` |
| `sessionCapabilities.resume` | `not-observed` |
| `sessionCapabilities.close` | `not-observed` |
| `promptCapabilities.image` | `not-observed` |
| `promptCapabilities.audio` | `not-observed` |
| `promptCapabilities.embeddedContext` | `not-observed` |
| `auth` 是否出现 | `not-observed` |
| `providers` 是否出现 | `not-observed` |
| `_meta` 是否出现 | `not-observed` |
| Adapter 是否丢弃 `auth` / `providers` / `_meta` | 代码已丢弃；真机是否出现这些字段仍为 `not-observed` |
| stderr 是否有可脱敏握手噪音 | `not-observed` |
| stderr 是否进入产品事件 | `not-observed` |

握手后能力快照预期（仅在声明出现后填写，不得把 `declared` 写成 `verified`）：

| 能力 | 握手后 support / verification / source | 真机成功后是否升为 verified |
| --- | --- | --- |
| `runtime.connect` | `not-observed` | `not-observed` |
| `session.create` | `not-observed` | `not-observed` |
| `session.load` | `not-observed` | `not-observed` |
| `session.resume` | `not-observed` | `not-observed` |
| `session.prompt.text` | `not-observed` | `not-observed` |
| `session.cancel` | `not-observed` | `not-observed` |
| `permission.request` | `not-observed` | `not-observed` |

---

## B. Session 生命周期

对照 `createSession` / `loadSession` / `resumeSession` / `closeSession` 与 `activateTaskSession()`。

切回历史 Task 的产品路径：`resumeTask()` → `activateTaskSession()`：先 `resumeSession`，失败且 `status.state === 'ready'` 才 `loadSession`。握手未声明则 `session-restore-unsupported`。

| 操作 | 结果 |
| --- | --- |
| `session/new` 返回的 `sessionId` 形状 | `not-observed` |
| `session/set_model` 是否被接受 | `not-observed` |
| `session/set_model` 响应形状 | `not-observed`（object / null / 缺响应） |
| `set_model` 失败是否拆连接 | `not-observed` |
| 同 Task 第二轮是否复用同一 `sessionId` | `not-observed` |
| Task B 是否 `session/new` | `not-observed` |
| Task A 的 session 是否仍可后续 resume | `not-observed` |
| 切回 A 实际走的 method | `not-observed`（`resume` / `load` / 阻断） |
| `session/resume` 是否回放历史 update | `not-observed` |
| `session/resume` 失败码 | `not-observed` |
| resume 失败后连接是否仍 `ready` | `not-observed` |
| `session/load` 是否回放历史 update | `not-observed` |
| load 回放事件是否带旧 sessionId | `not-observed` |
| 回放事件是否被当前 Turn generation 拒绝 | `not-observed` |
| `session/close` 未声明时是否只做本地解绑 | `not-observed` |
| close 已声明且失败是否抛 `operation-failed` | `not-observed` |
| 产品 `taskId` 是否稳定 | `not-observed` |
| 每轮 `turnId` 是否不同 | `not-observed` |

---

## C. Prompt 与 session/update

对照 `mapGrokSessionUpdate()`。未见到的项保持 `not-observed`。

| `sessionUpdate` | 现有处理 | 真机 |
| --- | --- | --- |
| `agent_message_chunk` | 映射 `agent-message`，非 text 丢弃 | `not-observed`（content.type 是否总是 text） |
| `agent_thought_chunk` | 映射 `agent-thought` | `not-observed`（是否出现；是否有 messageId） |
| `tool_call` / `tool_call_update` | 映射 tool + 可选 diff | `not-observed`（kind / status / locations.path） |
| `plan` | 映射 plan | `not-observed`（priority / status 是否齐全） |
| `usage_update` | 映射 experimental context usage | `not-observed`（used / size / cost） |
| `user_message_chunk` | 丢弃 | `not-observed` |
| `plan_update` / `plan_removed` | 丢弃 | `not-observed` |
| `available_commands_update` | 丢弃 | `not-observed` |
| `current_mode_update` | 丢弃 | `not-observed` |
| `config_option_update` | 丢弃 | `not-observed` |
| `session_info_update` | 丢弃 | `not-observed` |
| 其他未知类型 | `unsupported-runtime-event` | `not-observed`（只记 sessionUpdate 字符串） |

`PromptResponse.stopReason`：

| stopReason | 结果 |
| --- | --- |
| `end_turn` | `not-observed` |
| `cancelled` | `not-observed` |
| `refusal` | `not-observed` |
| `max_tokens` | `not-observed` |

---

## D. 权限 RPC

对照 `findPermissionOptions()` 与 `mapGrokPermissionRequest()`。每次真实审批另起一行。Renderer 不得看到 `optionId`。

**红字风险：** 若真实 Grok 从不给唯一 `allow_once`，当前产品会把请求标成 `executionSupported: false`，用户无法“允许执行”，只能取消。这是 GACP-03 的输入，不是本计划修复范围。

| 次 | `options[].kind` 集合 | 唯一 `allow_once` | 唯一 `reject_once` | `toolCall.kind` | `locations[].path` | path 在 execution root 内 | content 含 `type: "diff"` | `rawInput` | `rawOutput` | `name` | `_meta` | 用户动作 | Grok 后续是否继续该 tool | 取消 Turn 时未决 permission 是否 `{ outcome: 'cancelled' }` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `not-observed` | `not-observed` | `not-observed` | `not-observed` | `not-observed` | `not-observed` | `not-observed` | `not-observed` | `not-observed` | `not-observed` | `not-observed` | `not-observed` | `not-observed` | `not-observed` |

P0-09 夜间补测只证明产品层见到过 `execute-command` L3 且用户点了“仅允许一次”。那不是本表的协议字段观察，不得把 option.kind 集合从产品文案反推进来。

---

## E. 生命周期与 P0-08 遗留

必须用真实 Grok 长任务（至少跨一个权限或超过 10 秒的工具调用）。Windows/Linux 平台矩阵仍归 P0-08；本计划在当前 Windows 开发版上记录 Grok 路径即可，不把平台验收偷偷标完成。

| # | 路径 | 结果 | 日期 / Grok 版本 | 失败归属 |
| --- | --- | --- | --- | --- |
| 1 | 执行中切到另一历史 Task 再切回；ACP session 不丢，Timeline 不串流 | `not-observed` | | Adapter generation / Executor / Grok |
| 2 | Renderer reload 后 `TaskExecutionSnapshot` 仍指向同一 `executionId`；未决审批不消失、也不被 UI 伪造操作按钮 | `not-observed` | | |
| 3 | 退出三分支：继续等待 / 取消后退出 / 强制退出；强制退出后重启该 Turn 为 `interrupted`，不得变成 `completed` | `not-observed` | | |
| 4 | Runtime 进程崩溃：Adapter 收束、Executor 终态 `failed` 或 `interrupted`，下次连接不复用死亡 generation | `not-observed` | | |
| 5 | 取消超时：Broker 先撤审批，再强制断 Runtime；ACP 未决 permission 必须 cancelled | `not-observed` | | |

P0-09 夜间补测已在**产品终态**见过退出三分支和部分 reload。本表仍要补协议级字段，不得把产品层结论直接抄成 ACP 观察。

---

## 下游缺口（本计划不得顺手实现）

| 缺口 | 交给 |
| --- | --- |
| 点进历史即可接着聊、恢复 UX | GACP-02 |
| execute / fetch 不可读、只有 `allow_always` 无法允许 | GACP-03 |
| `set_model` 响应形状与启动方言 | GACP-04 |
| fs / terminal Client 能力广告 | GACP-05 |
| 子 Agent 嵌套时间线 | GACP-06（字段依赖本表） |

---

## 填写记录

| 走查 | 日期 | 执行者 | 覆盖 | 结论 |
| --- | --- | --- | --- | --- |
| 环境冻结与模板 | 2026-08-18 | Agent | 第 0 节版本、入口约束 | 可复现模板已进 Git；A–E 仍为 `not-observed` |
| 正式桌面真机 | 待填写 | 需要本机已登录 Grok 的人在开发版里点 | A–E | 待开始 |
