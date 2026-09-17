# P0-22 对话内本次编辑 Hunk

> **致执行者：** 按任务顺序落地。步骤使用复选框跟踪。用户已确认对齐 Grok Build TUI：每次 Edit 一张卡，只显示这一次的红绿行。

**优先级：** P0-A / 权重 4（让对话里能看懂改了哪、改了什么；不替代 Changes 整文件审阅）

**目标：** Agent 改文件时，主对话对该次工具调用展开红绿 hunk（路径、行号、删/增行、有限上下文），而不是只显示「写入 xxx · 已完成」。

**非目标：**

- 不把右侧 Changes 的整文件 Git diff 嵌进对话。
- 不引入语法高亮库。
- 不把完整 before/after 快照交给 Renderer。
- 不改 Permission Broker、检查点、撤销、git reset/checkout。
- 不加回「继续任务」。
- 不宣称已消费 Grok `Diff.meta` 结构化行号（当前 Mapper 只映射 `path` / `oldText` / `newText`）。没有 meta 时行号从 1 起算。

**核心数据流：**

```text
Grok ACP tool_call(_update).content[] type=diff
  → mapGrokDiffs（已有：脱敏 snapshot before/after）
  → 主进程历史仍存 AgentDiff
  → projectPublicAgentEvent：算出限长 hunk，写入 PublicAgentDiffEvent.edits
  → Preload 逐字段重建 edits
  → Timeline reducer：按 toolCallId 挂到 TimelineToolNode.editDiffs
  → conversation-turn-view：有 hunk 的工具块不进过程胶囊
  → ConversationEditDiff：默认展开红绿行
```

**安全边界：**

- 公开事件只含限长 hunk 行，不含完整文件快照、rawInput、环境变量。
- 每条路径、每行、事件总字节有上限；含 `\0` 的当二进制，不渲染假文本。
- 路径仍走现有脱敏；hunk 正文再过一遍 `redactText`。
- Preload 拒绝超长数组、非法 kind、未知字段。
- Changes 面板的 Git 审阅 IPC 保持按需、原样。

**文件范围：**

- 新建 `src/shared/edit-hunks.ts` 与测试。
- 修改 `src/shared/agent-event.ts`。
- 修改 `src/main/agent/agent-event-projection.ts` 与测试。
- 修改 `src/preload/desktop-api.ts` 与测试。
- 修改 `src/renderer/src/task-timeline-reducer.ts` 与测试。
- 修改 `src/renderer/src/conversation-turn-view.ts`、`conversation-activity-capsule.ts` 与测试。
- 新建 `src/renderer/src/conversation-edit-diff.ts`、`ConversationEditDiff.vue`。
- 修改 `ConversationTurn.vue`、`main.css`。
- 更新 `docs/superpowers/plans/roadmap-index.md`。

---

## 任务 1: 从 snapshot 生成限长 hunk

- [x] **第 1 步:** `buildPublicEditDiffs`：单行替换、新建文件、删除、两处远离改动分成两个 hunk（±3 行上下文）。
- [x] **第 2 步:** `\0` → `unavailable: 'binary'`；无改动不产出 edits；超行数截断并打 `truncated`。
- [x] **第 3 步:** unified patch 能解析时投影为 hunk；解析失败则跳过正文。

## 任务 2: 公开事件投影与 Preload

- [x] **第 1 步:** `PublicAgentDiffEvent.edits` 可选；有 hunk 才带上。
- [x] **第 2 步:** 投影不再把正文藏成 `git-review-not-implemented` 后丢掉；仍保留 `references` 路径摘要给结果审阅计数。
- [x] **第 3 步:** Preload 重建 edits，丢掉 `diffs` / `patch` / 超预算字段。

## 任务 3: Timeline 挂到工具卡

- [x] **第 1 步:** `TimelineToolNode.editDiffs`；diff 事件按 `toolCallId` 挂上，工具后到也能补挂。
- [x] **第 2 步:** 对话投影把 `editDiffs` 拷到 `ConversationToolBlock`。
- [x] **第 3 步:** 有 hunk 的工具块不进 Activity Capsule。

## 任务 4: 对话 Edit 卡

- [x] **第 1 步:** `ConversationEditDiff`：标题、单列行号、红绿行、hunk 间「N 行未修改」。
- [x] **第 2 步:** 主对话默认展开；失败仍显示错误；二进制/截断有横幅。
- [x] **第 3 步:** 样式复用现有 `--success` / `--danger`，不另做一套颜色。

## 验收

- 聚焦 Vitest：hunk 算法、投影、Preload、reducer、对话投影、胶囊排除。
- `pnpm typecheck`、目标 ESLint、`git diff --check`。
- 开发版 GUI：真实 Grok 改一个文件后，对话里能看到该次红绿行。未走查不得宣称完成。
