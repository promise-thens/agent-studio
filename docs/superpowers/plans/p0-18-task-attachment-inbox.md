# P0-18 Task 附件柜与对话媒体 实施计划

> **For agentic workers:** 按任务顺序 TDD 落地。工作区已有用户未提交改动，**不要 commit、不要 stash、不要 reset**。步骤用复选框跟踪。

**Goal:** Composer 可上传/拖放/粘贴白名单图片与文件到 Task inbox；对话展示用户附件、Runtime 图片块、本轮 execution root 中的图片/PDF 预览。

**Architecture:** 主进程持有 inbox 字节。Renderer 只拿 `attachmentId`。`startTurn` 传 ID。Adapter 按握手组 ACP `text` / `Image` / `Resource`。AI 产出预览走 ChangeSet + execution root，不写死项目根。

**Tech Stack:** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node 20+、Vitest、ACP SDK 1.3。

**Spec:** [docs/superpowers/specs/2026-08-23-task-attachment-inbox-design.md](../specs/2026-08-23-task-attachment-inbox-design.md)

## Global Constraints

- Node >= 20，pnpm 10.x，Electron 39，Vue 3，中文注释。
- Renderer 不读盘、不拿绝对路径、不传明文 Key。
- 用户附件不写 Project / Worktree。本期不实现 P0-14。
- 不广告未实现 client 能力。测试只用假文件。
- 新增代码块必须有中文备注。
- 不覆盖用户已有未提交文件。

## 进度（2026-08-23）

主路径已落地（自动测试 + typecheck 已过，开发版 GUI 未跑）：Task 1–4、Task 6、用户气泡预览、文档快照。

### 已完成

- 白名单分类器与上限（`src/shared/task-attachment.ts`）
- Task inbox 落盘、draft/bound、预览缩略图（`src/main/agent/task-attachment-inbox.ts`）
- 附件 IPC：选文件 / 拖放路径 / 剪贴板 / 列表 / 删除 draft / inbox 预览
- `startTurn({ taskId, prompt, attachmentIds })`；空正文+附件可发
- ACP 组块：声明识图走 `Image`，否则 `Resource`；不发 `ResourceLink`
- Composer：回形针、芯片、粘贴、拖放、识图提示
- 用户气泡用 `ConversationMedia` 预览 inbox 附件
- Turn 历史可选 `attachmentIds`

### 未完成（按优先级）

**P0 — 对话出图还没闭环**

1. **Runtime image 块入库**（原 Task 5）
   `agent_message_chunk` / `agent_thought_chunk` 非 text 目前直接丢弃。需要把 `ContentBlock::Image` 写入 inbox（`source: 'runtime'`），发 `agent-attachment` 事件，助手气泡渲染。涉及 `grok-acp-mappers`、adapter session update、`AgentEvent` / `PublicAgentEvent`、event-normalizer、preload parse、timeline、ConversationTurn。

2. **本轮 Changes 图片/PDF 缩略图**（原 Task 7 后半）
   `task:get-change-media-preview` 通道有了，但 `src/main/index.ts` **没有注入实现**，调用会 `runtime-unavailable`。需要：path 必须在当前 ChangeSet，`realpath` 落在 execution root，再出缩略图。`TaskChangeCard` 尚未接缩略图。

**P1 — 输入体验缺口**

3. **拖放在 sandbox 下可能拿不到路径**
   Composer 只读 `File.path`。Electron 新版本要用 `webUtils.getPathForFile`（preload 窄接口），否则拖放无路径、静默失败。

4. **剪贴板文件不完整**
   现在只读 `clipboard.readImage()` + `public.file-url` / `text/uri-list`。macOS Finder 复制常用 `NSFilenamesPboardType`，未接。

5. **实时用户气泡可能看不到刚发的图**
   `acceptAdmission` 没带 `attachmentIds`，时间线用户节点主要靠 Turn 历史回放。发送当下可能只有文字，刷新/水合后才出图。

6. **发送失败后 draft 可能已被 bind**
   `bindToTurn` 发生在 Adapter 调用前。失败后 Composer 仍显示 draft，但 inbox 已是 `bound`，移除会 `not-draft`。需要失败回滚或允许清理已 bind 未成功的附件。

**P2 — 测试与走查**

7. 没有 `task-attachment-ipc.test.ts`（计划里有，未建）。
8. 对话投影「user 带 attachmentIds / agent-attachment 成块」测试未写。
9. 变更媒体越界/不在 ChangeSet 的拒绝测试未写。
10. 开发版 GUI 走查：选文件、拖放、粘贴截图、仅附件发送、重启后预览、识图提示。
11. 受控 e2e 未覆盖附件。
12. README 未写附件能力（GUI 未验证前不要写「已支持」）。

**明确不做（仍有效）**

- P0-14 Worktree
- 助手 Markdown `![](url)` 热链
- SVG / 视频 / 音频 / 整棵文件夹 / 任意 URL
- P0-13 Artifact Registry
- 广告未实现的 client 能力

## 文件结构

- Create: `src/shared/task-attachment.ts`、`src/shared/task-attachment.test.ts`
- Create: `src/main/agent/task-attachment-inbox.ts`、`src/main/agent/task-attachment-inbox.test.ts`
- Create: `src/main/agent/task-attachment-ipc.ts`、`src/main/agent/task-attachment-ipc.test.ts`
- Create: `src/renderer/src/components/ComposerAttachments.vue`
- Create: `src/renderer/src/components/ConversationMedia.vue`
- Modify: `src/shared/task-ipc.ts`、`src/shared/agent-ipc.ts`、`src/shared/agent.ts`、`src/shared/agent-event.ts`、`src/shared/task-history.ts`、`src/shared/agent-ipc.test.ts`
- Modify: `src/main/agent/agent-service.ts`、`src/main/agent/agent-runtime-adapter.ts`、`src/main/runtime/grok/grok-acp-adapter.ts`、`src/main/runtime/grok/grok-acp-mappers.ts`、`src/main/agent/task-store.ts`、`src/main/agent/ipc.ts`、`src/main/index.ts`
- Modify: `src/preload/desktop-api.ts`、`src/preload/index.d.ts`
- Modify: Composer / Conversation / Change card / App.vue / main.css / 对应测试

---

### Task 1: 共享分类器

**Files:**
- Create: `src/shared/task-attachment.ts`
- Test: `src/shared/task-attachment.test.ts`

**Produces:** `classifyTaskAttachmentBytes`、`ATTACHMENT_LIMITS`、`TaskAttachmentDescriptor` 类型。

- [x] **Step 1: 写失败测试**（见仓库测试文件）
- [x] **Step 2: 跑测试确认失败**
- [x] **Step 3: 实现分类器**
- [x] **Step 4: 测试通过**

### Task 2: Inbox 存储

**Files:**
- Create: `src/main/agent/task-attachment-inbox.ts`
- Test: `src/main/agent/task-attachment-inbox.test.ts`

**Produces:** `TaskAttachmentInbox.importBytes / importPath / bindToTurn / removeDraft / getPreview / listDrafts`

- [x] Inbox 存储与配额测试已过

### Task 3: 附件 IPC

**Files:**
- Create/Modify: task-attachment-ipc、task-ipc channels、preload、agent-ipc.test.ts 静态表

- [x] 通道与 preload 已接
- [ ] `task-attachment-ipc.test.ts` 未建
- [ ] `getChangeMediaPreview` 未在 `index.ts` 注入实现

### Task 4: startTurn 带附件

**Files:**
- Modify: agent-service `startTurn`、adapter `AgentRuntimeTurnContext`、grok-acp-adapter prompt 组块、ipc readStartTurnRequest

- [x] startTurn / ACP 组块已接

### Task 5: Runtime image 块 → agent-attachment

**Files:**
- Modify: grok-acp-mappers / adapter session update；shared AgentEvent 联合

- [ ] **未开始。** 非 text chunk 仍被丢掉。

### Task 6: Composer UI

**Files:**
- Modify: TaskComposer.vue、task-composer-actions、App.vue、main.css

- [x] 回形针 / 芯片 / 粘贴 / 拖放已接（未拆 `ComposerAttachments.vue`）
- [ ] sandbox 拖放路径、Finder 剪贴板文件、发送失败回滚 draft 未收口

### Task 7: 对话与变更媒体

**Files:**
- Modify: conversation-turn-view、ConversationTurn.vue、task-timeline-reducer、TaskChangeCard、task-changes-presentation

- [x] 用户气泡可预览 inbox 附件
- [ ] 助手 `agent-attachment` 块
- [ ] 实时 admission 带 `attachmentIds`
- [ ] ChangeSet 缩略图 / TaskChangeCard

### Task 8: 文档快照

**Files:**
- Modify: Agents.md / Claude.md 第 15 节进度；README 仅写已验证能力

- [x] Agents.md / Claude.md 进度已更新
- [ ] README 等 GUI 走查后再写
