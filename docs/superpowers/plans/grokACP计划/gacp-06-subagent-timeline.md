# GACP-06 子 Agent 时间线（Claude Code Desktop 风格）

> **致执行者：** 产品已确认要做通用多 Agent 工作台。Grok Build 会分发子 Agent；界面不要把它们摊成一长串互不相关的工具卡，而要做成可折叠的嵌套任务，对标 Claude Code Desktop。
>
> **状态：** 待开始（前置：P0-10A 壳；GACP-01 已关闭且未见父子字段）
>
> **插入点：** P0-10A 换皮之后再接分组。GACP-01 观察表 F 节全部 `not-observed`，因此本计划先保持扁平，有稳定父子字段后才能嵌套，不能靠猜 title。不要重开 GACP-01，也不要挡 GACP-02 / P0-10A。

**优先级：** P0-A 增强 / 权重 3（不影响单 Agent 闭环，但决定「像不像 Codex / Claude Desktop」）

**目标：** 当 Runtime 派出子 Agent 时，用户在当前 Task 的时间线里看见：

1. 一条父对话仍在。
2. 每个子 Agent 是一张卡片：名字/任务摘要、running/completed/failed、自己的工具列表。
3. 默认折叠细节，点开才看到这个孩子读了什么、改了什么。
4. 父级能停整场；孩子失败清楚标在卡片上，不要混进父消息里。

**和整站大修的关系：**

皮肤、密度、输入框、侧栏、**对话块、计划清单**一律跟 [P0-10A](../p0-10a-claude-desktop-workbench-ui.md) 第 5A 节。本计划只负责「子 Agent 怎么分组」。禁止单独做一套更花的皮。对话是字，计划是一张会打勾的清单，子 Agent 是嵌在两者之间的任务卡——三件都在主列，不进检查器当主 UI。

**Claude Code Desktop 里值得学的：**

- 子任务是**嵌套卡片**，不是另开一个顶层会话，也不进侧栏。
- 折叠态一眼能看：谁在干、是否还在跑、失败没有。
- 展开后是这个孩子自己的工具行，缩进一层，组件复用 `ToolRow`。
- 多个孩子上下叠在父消息之间，不和父回复抢气泡。

不学的：

- 不要为每个子 Agent 在侧栏再做一个并列 Task。
- 不要把子 Agent 的 Runtime session 暴露成用户对象。
- 不要复制 Claude 商标。

**核心数据流：**

```text
Grok ACP session/update（tool_call 或后续标准父子字段）
  → GACP-01 观察：有没有 parentToolCallId / agentId / session 嵌套
  → EventNormalizer 增加可选 parentId，仍走同一 turnId
  → Timeline reducer 把「子 Agent 根节点」收成 agent-group
  → ExecutionTimeline 渲染可折叠卡片
```

**约束与边界：**

- `taskId` / `turnId` 仍是产品身份。子 Agent 只是 Turn 内部的执行分组。
- 没有稳定父子字段时，**禁止**用标题里的 “subagent” 字符串乱分组。先画扁平工具卡 + 「检测到未识别的子任务」提示。
- `_meta` 默认仍丢掉。只有 GACP-01 冻结过的稳定字段才能进公开事件。
- 子 Agent 的权限仍走同一个 PermissionBroker，initiator 还是当前 Runtime。不要给每个孩子单独一套永久授权。
- 本计划不做 `spawn_subagent` 的桌面端调度器。分发是 Grok Runtime 的事；桌面只展示和停止。

**主要风险：**

- Grok 现在可能只把子 Agent 报成普通 `tool_call`。过早做树会分错组。
- 子 Agent 自己的 session/update 如果带另一套 `sessionId`，现有 Adapter 会因 session 不匹配而丢掉。
- 高频子任务会把 Timeline 卡死；必须默认折叠、限制可见深度。

**技术栈：** 现有 Vue 3 Timeline、P0-09 reducer、ACP SDK 1.3。

---

## 实施范围

**前置依赖：**

- P0-09 测试门：同一套实时/历史 reducer。
- P0-10A：主列对话壳和 `ToolRow` / `SubagentCard` 皮肤。没有壳时不要在旧 `TurnSummaryCard` 上做展示骨架。
- 子 Agent 字段：GACP-01 已关闭，[观察表 F 节](observations/grok-acp-observation.md) 全是 `not-observed`。本计划任务 1 可以自己再观察一次并写回该表；**缺字段只禁止做成树，不推迟 GACP-02 / P0-10A。**

**文件范围：**

- 观察：`observations/grok-acp-observation.md` 增补子 Agent 字段表
- 可能修改：`src/shared/agent-event.ts`、`event-normalizer.ts`、`agent-event-projection.ts`
- 修改：`task-timeline-reducer.ts`、`ExecutionTimeline.vue`
- 新增：`src/renderer/src/components/SubagentCard.vue`（皮肤遵守 P0-10A）
- 测试：嵌套/乱序/晚到终态/无父子字段时保持扁平

**安全策略：**

- 公开事件仍不得带 `runtimeSessionId`。
- 子 Agent 卡片标题、摘要脱敏限长。
- 停止子任务只能走现有 `cancelTurn`（整 Turn）或未来明确的 child cancel；没有协议就不要做假的「停这个孩子」按钮。

## 已锁定的展示语义

```text
Turn
├── 用户这句话
├── 父 Agent 思考 / 计划
├── 子 Agent 卡片「探查测试结构」  running
│     ├── 读文件 …
│     └── 完成 / 失败
├── 子 Agent 卡片「改登录逻辑」  completed
│     └── 写文件 …
└── 父 Agent 汇总回复
```

卡片外观必须和 [P0-10A 第 7 节](../p0-10a-claude-desktop-workbench-ui.md) 一致：

```text
# 备注：折叠态一行标题 + 一行计数，不要再输出 Tool · in_progress。
┌──────────────────────────────────────────┐
│ ● 探查测试结构                 进行中  ▾ │
│   3 个工具 · 点开查看                     │
└──────────────────────────────────────────┘
```

- 进行中：左边小点用 accent；完成默认折叠；失败左边改 `--danger`。
- 展开后内部只用 `ToolRow`，左缩进 12px，不要再套一层大卡片。
- 卡片 `nodeId` 用稳定 `toolCallId` 或观察得到的 `agentId`，不要用数组下标。
- 同一孩子的后续 tool 挂到这张卡里，不要再在父流里重复插一条。
- 父消息、孩子卡片按 sequence 排，孩子内部再按自己的 sequence 排。
- 历史回放和实时必须同一棵树。

和本产品其它对象的关系：

| 对象 | 谁创建 | 用户看不看 |
| --- | --- | --- |
| Project / Task / Turn | Agent Studio | 看，这是导航 |
| Grok session | Runtime | 不看 |
| 子 Agent | Runtime 在某次 Turn 里派出 | 看卡片，不进侧栏 |

后续 P4 双脑对比是**两个产品 Task / 两个 Runtime**，不是这里的子 Agent。不要混。

---

## 任务 1: 先观察，再决定能不能嵌套

- [ ] **第 1 步: 补观察表 F 节（不必重开 GACP-01）**
      说明：真机让 Grok 分两个探查任务。记录 tool 标题、kind、是否有 parent、是否新 session、权限算谁的。写回 `observations/grok-acp-observation.md` F 节即可。
      预期：有稳定字段才进入任务 2；否则只做扁平工具行，不假装树，也不回头挡住 GACP-02。

- [ ] **第 2 步: 公开事件加可选 parent**
      说明：仅映射观察白名单字段。Preload 丢弃未知键。
      预期：没有字段时旧 Timeline 测试全绿。

## 任务 2: reducer 出 agent-group 节点

- [ ] **第 1 步: 识别子 Agent 根**
      说明：根节点一张卡，孩子 tool 归组。乱序/晚到终态不能把已完成卡打回 running。
      预期：切 Task、重启回放树形一致。

- [ ] **第 2 步: 无父子字段的降级**
      说明：保持扁平 tool 卡，不根据中文标题聚类。
      预期：普通 Turn 不出现空的「子 Agent」壳。

## 任务 3: Claude Desktop 风格卡片

- [ ] **第 1 步: 折叠卡片 UI**
      说明：默认收起，显示名称、状态、工具数。展开是这个孩子的小时间线。图标有 `aria-label`。
      预期：两个并行孩子互不串工具。

- [ ] **第 2 步: 停止语义诚实**
      说明：没有 child cancel 协议时，只提供停整场 Turn，文案写清。
      预期：不出现点了没反应的「停止此子任务」。

- [ ] **第 3 步: 性能**
      说明：默认只展开进行中的那张卡；深度限制 2。
      预期：长任务下输入区仍可点。

---

## 验收标准

- [ ] 有父子字段时，时间线是嵌套卡片而不是平铺工具。
- [ ] 没有字段时不乱分组，功能不回退。
- [ ] 子 Agent 不出现在侧栏 Task 列表。
- [ ] 权限仍走同一 Broker。
- [ ] 实时与历史同一棵树。
- [ ] 相关测试、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过。

## 非目标

- 不做桌面端自己调度的多 Agent 编排器（那是 P4）。
- 不做每个子 Agent 独立 Project/Worktree。
- 不在本计划实现 Computer Use 插件。
