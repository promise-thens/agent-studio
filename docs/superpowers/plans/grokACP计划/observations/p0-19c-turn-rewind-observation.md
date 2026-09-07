# P0-19c `/rewind` 真机观察

> 本文件冻结对话 rewind 的提交策略。观察已在隔离 ACP stdio 完成；实现必须服从本表，不得伪造未广告的 `/rewind` 或 `/undo`。

## 0. 观察环境

| 项 | 值 |
| --- | --- |
| 记录日期 | 2026-09-07 |
| Grok CLI | `grok 1.0.13 (5e9a58528b76)` |
| 通道 | ACP stdio |
| 握手 | `protocolVersion: 1`，`clientCapabilities: {}` |
| GROK_HOME | 隔离目录（只复制 `auth.json`，**不**复制用户 `config.toml`） |
| cwd | 临时目录（不是本仓库工作区） |
| `~/.grok/config.toml` 观察前 sha256 | `8e5285e5eeca085d00c2a85b8aa8f86d636178eaddcde2f779cf07e855f5f08e` |
| `~/.grok/config.toml` 观察后 sha256 | `8e5285e5eeca085d00c2a85b8aa8f86d636178eaddcde2f779cf07e855f5f08e` |
| hash 是否不变 | true |
| 进程级 `--always-approve` | **未使用** |

脱敏原始 JSON（gitignored scratch，不入库）：`.superpowers/sdd/p0-19c-turn-rewind/rewind-observation.json`

两轮（均非产品路径）：

1. ping 后发一次 `/rewind`（无后续探测）
2. ping → `/rewind` → 再发一轮探测「是否还记得 ping token」

## 1. 命令广告

`available_commands_update` **有出现**（其它命令 16 条）。下列 **name 精确匹配均为 false**：

| name | 广告 |
| --- | --- |
| `rewind` | **否** |
| `undo` | **否** |

补充：广告清单里没有任何 name 含子串 `rewind`。**不得把完整用户插件命令清单写入本表。**

`session/new` 响应键：`sessionId`、`models`、`_meta`。`modes`：**absent**。`initialize` 响应键：`protocolVersion`、`agentCapabilities`、`authMethods`、`_meta`。`agentInfo`：**absent**。

## 2. 发送一次 `/rewind`（观察，非产品）

| 场景 | `session/prompt` | `request_permission` | 写文件工具 | cwd 是否变化 | 会话是否被截断 |
| --- | --- | --- | --- | --- | --- |
| 1 ping 后 `/rewind` | 一次 `/rewind` | **0** | **否**（本轮无 tool_call） | **否**（仍只剩观察 marker） | **not-observed**（本轮无探测） |
| 2 ping → `/rewind` → probe | 一次 `/rewind`，外加探测 prompt | **0** | **否**（见下：只有只读查阅） | **否** | **否**（探测轮仍见到 ping token） |

两轮 `/rewind` 的 `stopReason` 均为 `end_turn`。

第二轮 `/rewind` 期间见到只读工具：`read` / `search` / `other`，标题指向 Grok user-guide 文档（`04-slash-commands.md`、`17-sessions.md` 等）。未见 `edit` / `delete` / write 类 `kind`。**路径原文不入库。** `elicitation`：**absent**。

TUI 文档同时写过「`/rewind` 会恢复文件」和「`/rewind` 不改磁盘」。ACP 观察赢：未广告时把 `/rewind` 当普通 prompt 发出去，**既没有写盘，也没有截断会话**。

## 3. 冻结提交策略

1. **无广告永不发送。** 当前 1.0.13 未广告 `rewind` / `undo`。产品路径冻结为 `not-advertised`。禁止 `startTurn("/rewind")`、禁止拼 `/undo` 别名。
2. **观察发送不是产品路径。** 手工把 `/rewind` 当 prompt 发出去，Grok 会当普通话回答（可能去读自己的 user-guide），**不会**因此恢复文件，也**不会**截断会话。产品不得复制这条伪造。
3. **文件恢复仍走检查点。** `task:preview-latest-turn-restore` / `task:restore-latest-turn` 只恢复 latest-turn 文件；用户可见文案必须说「恢复上一轮文件」，禁止再用笼统「撤销」承诺对话+文件。
4. **不改 `clientCapabilities`**，保持 `{}`。
5. 若未来广告 `name === 'rewind'` 或（仅当快照含该 name）`undo`，才允许空闲时按快照真名发送；本表未见到广告前不得预写发送逻辑。
