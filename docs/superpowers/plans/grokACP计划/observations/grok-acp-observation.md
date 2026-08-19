# GACP-01 真机 Grok ACP 观察记录

> 本文件由可选脚本 `pnpm test:gacp01:observe` 通过正式桌面路径 `window.agent.connect → createTask → startTurn` 填写。不是受控 fixture，也不是独立 ACP Client。
>
> **状态：** GACP-01 已于 2026-08-19 受限关闭。本表是冻结观察，不是后续计划的开工门槛。没见到的项仍为 `not-observed`，禁止补“应该有”。

## 0. 观察环境

| 项 | 值 |
| --- | --- |
| 记录日期 | 2026-08-19 |
| Agent Studio commit | `92025a3` |
| Node | `v22.22.0` |
| pnpm | `10.33.0` |
| Electron | `39.8.10` |
| Grok CLI | `grok 1.0.5 (5115b46bc909)` |
| `@agentclientprotocol/sdk` | `1.3.0` |
| `acp.PROTOCOL_VERSION` | `1` |
| `~/.grok/config.toml` 观察前 hash | `7cef72f8eee166b7aeaafb3840a3397a9b8424bde1ad7c9a585c7ed9a7686d87` |
| `~/.grok/config.toml` 观察后 hash | `7cef72f8eee166b7aeaafb3840a3397a9b8424bde1ad7c9a585c7ed9a7686d87` |
| hash 是否不变 | true |

## A. 进程与握手

| 项 | 结果 |
| --- | --- |
| Grok CLI 版本原文 | `grok 1.0.5 (5115b46bc909)` |
| `acp.PROTOCOL_VERSION` | `1` |
| Runtime 返回的 `protocolVersion` | `1` |
| 版本是否相等 | `true` |
| `agentInfo.name` 是否存在 | `false` |
| `agentInfo.version` 是否存在 | `false` |
| 是否写入能力快照 `runtimeVersion` | `not-observed` |
| `agentCapabilities.loadSession` | `true` |
| `sessionCapabilities.resume` | `true` |
| `sessionCapabilities.close` | `true` |
| `promptCapabilities.image` | `false` |
| `promptCapabilities.audio` | `false` |
| `promptCapabilities.embeddedContext` | `true` |
| `auth` 是否出现 | `true` |
| `providers` 是否出现 | `false` |
| `_meta` 是否出现 | `true` |
| stderr 是否有可脱敏握手噪音 | `not-observed` |
| 连接状态 | `ready` / Grok Build 已连接 |
| 产品 `session.create` | `native/declared` |
| 产品 `session.resume` | `native/declared` |
| 产品 `session.load` | `native/declared` |

## B. Session 生命周期

| 操作 | 结果 |
| --- | --- |
| `session/new` 返回的 `sessionId` 形状 | `uuid`, `uuid`, `uuid`, `uuid` |
| `session/set_model` 是否被接受 | `true` |
| `session/set_model` 响应形状 | `object` |
| 同 Task 第二轮终态 | `completed` |
| Task B 终态 | `completed` |
| 切回 A 实际走的 method | `resume` |
| `session/resume` | `ok:uuid` |
| `session/load` | `not-observed` |
| `session/close` | `not-observed` |

## C. Prompt 与 session/update

见到的 `sessionUpdate`：`user_message_chunk`, `agent_thought_chunk`, `agent_message_chunk`, `session_info_update`, `available_commands_update`, `tool_call`, `tool_call_update`

见到的 `stopReason`：`end_turn`

产品公开事件 kind：`agent-thought`, `agent-message`, `tool-call`, `tool-update`, `turn-complete`

## D. 权限 RPC

| 次 | option.kind | 唯一 allow_once | 唯一 reject_once | toolCall.kind | locations.path | diff | rawInput | rawOutput | name | _meta |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | allow_once/reject_once | true | true | execute | false | false | true | false | false | true |

产品层权限决策：`allow-once-or-none`

## E. 生命周期与 P0-08 遗留

脚本本轮只覆盖连接、同 Task 两轮、A→B→A、可选权限和一次取消。退出三分支与窗口销毁仍需产品对话框，保持 `not-observed`。

| # | 路径 | 结果 |
| --- | --- | --- |
| 1 | 执行中切 Task 再切回 | `resume` |
| 2 | Renderer reload | `not-observed` |
| 3 | 退出三分支 | `not-observed` |
| 4 | Runtime 崩溃 | `not-observed` |
| 5 | 取消超时 | `not-observed` |

## F. 子 Agent（本轮未见，不挡 GACP-02 / P0-10A）

本轮脚本没有专门派出子 Agent。下列字段全部 `not-observed`。GACP-06 在没有稳定父子字段前必须保持扁平工具行，禁止用标题聚类。缺这张表不得重开 GACP-01，也不得推迟换皮。

| 项 | 结果 |
| --- | --- |
| 是否出现独立子 Agent session | `not-observed` |
| `parentToolCallId` / parent 字段 | `not-observed` |
| `agentId` 或等价稳定孩子身份 | `not-observed` |
| 孩子 tool 是否另带 `sessionId` | `not-observed` |
| 孩子权限是否单独 request | `not-observed` |

## G. 交接（遗留不挡后续开工）

| 缺口 | 交给 | 是否挡 GACP-02 / P0-10A / P0-10 |
| --- | --- | --- |
| 点进历史即可接着聊、resume-first、load 未核实降级 | GACP-02 | 不挡；GACP-02 可以开始 |
| 整站 Claude Desktop 换皮 | P0-10A | 不挡 |
| execute/fetch 可读性、少打断 | GACP-03（仍在 P0-11 后） | 不挡 |
| set_model / close / 能力升 verified | GACP-04 | 不挡 |
| fs / terminal 广告 | GACP-05 | 不挡；未实现不得广告 |
| 子 Agent 嵌套 | GACP-06 | 不挡换皮；挡的只是「做成树」 |
| 退出三分支产品对话框、窗口重建、崩溃、取消超时 | P0-08 | 不挡；平台项仍待补 |
| pending approval 查询 / reload 重建审批卡 | 以后单独补协议 | 不挡；现契约禁止伪造按钮 |
