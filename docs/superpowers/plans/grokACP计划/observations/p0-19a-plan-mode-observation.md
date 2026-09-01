# P0-19a `/plan` 真机观察

> 本文件冻结 Composer Plan 开关的提交策略。观察已在隔离 ACP stdio 完成；实现必须服从本表，不得伪造未广告的 `/plan`。

## 0. 观察环境

| 项 | 值 |
| --- | --- |
| 记录日期 | 2026-09-01 |
| Grok CLI | `grok 1.0.13 (5e9a58528b76)` |
| 通道 | ACP stdio |
| 握手 | `protocolVersion: 1`，`clientCapabilities: {}` |
| GROK_HOME | 隔离目录（只复制 `auth.json`，**不**复制用户 `config.toml`） |
| cwd | 临时目录（不是本仓库工作区） |
| `~/.grok/config.toml` 观察前 sha256 | `8e5285e5eeca085d00c2a85b8aa8f86d636178eaddcde2f779cf07e855f5f08e` |
| `~/.grok/config.toml` 观察后 sha256 | `8e5285e5eeca085d00c2a85b8aa8f86d636178eaddcde2f779cf07e855f5f08e` |
| hash 是否不变 | true |
| 进程级 `--always-approve` | **未使用** |

脱敏原始 JSON（gitignored scratch，不入库）：`.superpowers/sdd/p0-19a-session-plan-mode/plan-observation.json`

两轮：

1. 完整 turn（A 收到 `turn_ended`；B 中途被观察进程超时打断）
2. ACP Client 早停（见到 `current_mode_update` 后 `session/cancel`），用于捕获命令广告

## 1. 命令广告

`available_commands_update` **有出现**（其它命令 16～30 条）。下列 **name 精确匹配均为 false**：

| name | 广告 |
| --- | --- |
| `plan` | **否** |
| `view-plan` | **否** |
| `show-plan` | **否** |
| `plan-view` | **否** |

补充：广告清单里没有任何 name 含子串 `plan`（含 `/plan` 前缀形态）。**不得把完整用户插件命令清单写入本表。**

`session/new` 响应键：`sessionId`、`models`、`_meta`。`modes`：**absent**（`hasModes: false`）。不能从 new session 走 `session/set_mode`。

## 2. 三场景对照

| 场景 | `session/prompt` | 是否进入 plan | `enter_plan_mode` 权限 | `plan` session/update |
| --- | --- | --- | --- | --- |
| A 只发 `/plan` | 一次 prompt | **是**（`current_mode_update.currentModeId = "plan"`） | 完整 turn：**是**（工具名 `enter_plan_mode` 的 `request_permission`）；早停轮：权限 RPC 尚未到达 | **not-observed** |
| B `/plan 加登录` | 一次 prompt | **是**（同上） | 完整 turn 已见到 `enter_plan_mode` 工具启动；早停轮权限 RPC 未到 | **not-observed** |
| C 先 `/plan` 再发正文 | 两次 prompt | 第一次 prompt 已进入 plan；不需要第二次才激活 | 同 A：完整 turn 可见权限；早停轮未到 | **not-observed** |

TUI 先验「光 `/plan` 只 Pending，下一轮才 Active」**与 ACP 冲突**。ACP 上把 `/plan` 或 `/plan 加登录` 当作一次 `session/prompt` 就会进 plan。观察赢：产品若将来发送，用 **一次** prompt，不要默认拆两次。

## 3. `plan` session/update 形状

| 项 | 结果 |
| --- | --- |
| `sessionUpdate: "plan"` | **not-observed** |
| `sessionUpdate: "plan_update"` | **not-observed** |
| `sessionUpdate: "plan_removed"` | **not-observed** |
| 条目 `status` 枚举 | **not-observed** |
| 条目 `priority` 枚举 | **not-observed** |

见到的相关 update：

- `current_mode_update` 字段：`sessionUpdate`、`currentModeId`（值 `"plan"`）
- `tool_call` 标题含 `enter_plan_mode`（早停轮未见 `kind`/`status`）
- 完整 turn 另见 `exit_plan_mode` 工具与权限

未见到的字段保持 `not-observed`，禁止补「应该有」。

## 4. 冻结提交策略

1. **无广告永不改写。** 当前 1.0.13 未广告 `plan`。Composer 开关必须禁用；`resolvePlanSubmit` 在 `hasPlanCommand=false` 时返回原文。禁止桌面伪造 `/plan`。
2. **若未来广告 `name === 'plan'`** 且空闲、mode=plan、正文不是已有 Runtime 斜杠：一次 `session/prompt`，文本为 `"/plan " + 用户正文`（不要双斜杠，不要丢掉正文）。
3. **不要新 IPC / 两次 prompt。** 观察证明一步足够；TUI Pending 语义不能当 ACP 实现。
4. **不改 `clientCapabilities`**，保持 `{}`。
5. 手工把 `/plan` 当 prompt 发出去，Grok **仍会**进 plan。那不是产品路径；产品仍以广告为准。
