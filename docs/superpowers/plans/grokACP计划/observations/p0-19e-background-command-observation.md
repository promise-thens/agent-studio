# P0-19e 后台命令字段观察

> 本文件冻结 Timeline 工具事件的后台投影白名单。观察方法是 `sdk+docs+binary`，**不是**真机 ACP 会话；实现必须服从本表，不得从标题、命令行或 `_meta` 猜测后台。

## 0. 观察环境

| 项 | 值 |
| --- | --- |
| 记录日期 | 2026-09-07 |
| method | `sdk+docs+binary` |
| Grok CLI | `grok 1.0.13 (5e9a58528b76)` |
| `@agentclientprotocol/sdk` | `1.3.0`（`schema/schema.json`） |
| 握手 | 产品钉 `protocolVersion: 1`，`clientCapabilities: {}` |
| 真机 ACP 会话 | **未做**（本任务禁止另开真机会话，禁止假装跑过） |

对照材料：

- SDK 1.3 `schema.json` `$defs.ToolCall` / `ToolCallUpdate`
- SDK `schema/v2/schema.unstable.json`（仅确认 v2 `state_update` 存在；产品不得消费）
- Grok 用户指南 `20-background-tasks.md`
- Grok 1.0.13 二进制字符串（`strings`，不启动 ACP）

## 1. ACP 顶层键

**标准 `ToolCall` 属性（SDK 1.3）：** `toolCallId`、`title`、`name`、`kind`、`status`、`content`、`locations`、`rawInput`、`rawOutput`、`_meta`。

**标准 `ToolCallUpdate` 属性：** 必填 `toolCallId`，其余同上且可 null patch。

下列顶层键 **not-observed**，不得写入产品事件：

| 键 | 结果 |
| --- | --- |
| `background` | **not-observed** |
| `is_background` | **not-observed**（二进制工具参数名，不在 ACP ToolCall 顶层） |
| `execution` | **not-observed** |
| `task_id` | **not-observed**（Grok 内部 id，与产品 `taskId` 撞名） |
| ACP v2 `state_update` | 仅 unstable schema 存在；产品钉协议 1，**不得消费** |

二进制 ACP dump 格式仍是 `tool_call id= kind= title= content= raw_input=`。后台只能出现在 `rawInput`，不能当作 ToolCall 顶层字段。

## 2. rawInput 白名单

Grok 用户指南：`run_terminal_command` 设 `background: true`，返回内部 `task_id`，输出用 `get_command_or_subagent_output`。桌面 **不** 实现该轮询器。

Grok 1.0.13 二进制含 `is_background`（与 `run_terminal_command` 并列）以及 `acp_handler/background.rs`。

产品只额外白名单两个 **严格布尔 true**（P0-11 已冻结 `rawInput.command`，本表不改命令证据契约）：

| 键 | 命中条件 | 投影 |
| --- | --- | --- |
| `rawInput.background` | `=== true` | `execution: 'background'` |
| `rawInput.is_background` | `=== true` | `execution: 'background'` |

`false`、缺省、非布尔、未知键 → **省略** `execution`（默认前台，旧事件形状不变）。不得写入 `'foreground'`。

## 3. 冻结策略

1. **只拷贝上表两键的严格布尔 true。** 其它 rawInput 键一概丢弃；`rawInput` 整对象仍不得进入公开事件、日志或测试快照。
2. **禁止投影 Grok `task_id`。** 它是 Runtime 内部 id，会和产品 `taskId` 撞名。
3. **禁止读 `_meta`。** `_meta.background` / `_meta.is_background` 不得发明后台。
4. **禁止用标题或命令行猜测。** 例如标题含 `background`、`sleep 30 &`、`nohup` 都不能写成后台。
5. **禁止消费 ACP v2 `state_update`。** 产品钉协议 1；也不实现 `get_command_or_subagent_output` 桌面轮询器。

输出仍走现有 P0-11 命令证据；`CommandExecutionEvidence` 不加 `execution` 字段。
