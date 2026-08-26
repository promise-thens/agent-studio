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

## 进度（2026-08-25）

主路径与 P0/P1 缺口已落地：用户附件输入、Runtime 图片输出入库、对话媒体、ChangeSet 媒体预览、sandbox 拖放、Finder 剪贴板和 admission 失败回滚。2026-08-25 自动验证：`pnpm test` 123 个文件、1063 项通过，`pnpm typecheck`、`pnpm build`、`git diff --check` 通过，ESLint 0 error / 10 条格式 warning；开发版已验证截图粘贴、仅附件发送、用户气泡预览与 Runtime 识图。

### 已完成

- 白名单分类器与上限（`src/shared/task-attachment.ts`）
- Task inbox 落盘、draft/bound、预览缩略图（`src/main/agent/task-attachment-inbox.ts`）
- 附件 IPC：选文件 / 拖放路径 / 剪贴板 / 列表 / 删除 draft / inbox 预览
- `startTurn({ taskId, prompt, attachmentIds })`；空正文+附件可发
- ACP 组块：声明识图走 `Image`，否则 `Resource`；不发 `ResourceLink`
- Composer：回形针、芯片、粘贴、拖放、识图提示
- 用户气泡用 `ConversationMedia` 预览 inbox 附件
- Turn 历史可选 `attachmentIds`
- Runtime `Image` 严格解码后直接以 `source: 'runtime'`、`binding: 'bound'` 入库，并发布 `agent-attachment`
- 助手图片进入 Timeline / Conversation，图片落盘队列先于后续文本和 Turn 终态完成
- ChangeSet 图片/PDF 预览只允许当前变更路径，且 `realpath` 必须留在 execution root
- sandbox 拖放使用 Preload `webUtils.getPathForFile`；Finder 文件剪贴板支持 `NSFilenamesPboardType`
- 新执行链真实绑定附件、读取字节并传给 Adapter；admission 未提交时恢复用户 draft
- 缩略图使用 CSP 已允许的受限 `data:image/*;base64`，不放宽 `img-src`
- Composer 横向截图缩略图使用 `object-fit: contain`，避免方形容器裁掉两侧后误显示为破图
- Composer 图片附件改为无文件名的大图卡片，删除按钮悬浮在右上角；非图片附件仍保留名称
- 图片附件点击后可在灯箱中查看大图，支持遮罩、关闭按钮和 `Esc` 退出

### 未完成（按优先级）

**P2 — 剩余走查与自动化**

1. 开发版 GUI 仍需补跑：Finder 文件复制、真实文件拖放、Runtime 实际输出图片、ChangeSet 真实图片/PDF 卡片。
2. 受控 e2e 尚未覆盖附件输入与 Runtime 图片输出。
3. README 暂不写附件能力，等上述 GUI / e2e 边界验证后再描述为已支持。

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
- [x] `task-attachment-ipc.test.ts` 已覆盖固定通道、发送方门禁和预览投影
- [x] `getChangeMediaPreview` 已在 `index.ts` 注入安全实现

### Task 4: startTurn 带附件

**Files:**
- Modify: agent-service `startTurn`、adapter `AgentRuntimeTurnContext`、grok-acp-adapter prompt 组块、ipc readStartTurnRequest

- [x] startTurn / ACP 组块已接

### Task 5: Runtime image 块 → agent-attachment

**Files:**
- Modify: grok-acp-mappers / adapter session update；shared AgentEvent 联合

- [x] Runtime `Image` 已严格解析、原子入库、发布事件并进入助手媒体块

### Task 6: Composer UI

**Files:**
- Modify: TaskComposer.vue、task-composer-actions、App.vue、main.css

- [x] 回形针 / 芯片 / 粘贴 / 拖放已接（未拆 `ComposerAttachments.vue`）
- [x] sandbox 拖放路径、Finder 剪贴板文件、admission 失败 draft 回滚已收口

### Task 7: 对话与变更媒体

**Files:**
- Modify: conversation-turn-view、ConversationTurn.vue、task-timeline-reducer、TaskChangeCard、task-changes-presentation

- [x] 用户气泡可预览 inbox 附件
- [x] 助手 `agent-attachment` 块
- [x] 实时 admission 带 `attachmentIds`
- [x] ChangeSet 缩略图 / TaskChangeCard

### Task 8: 文档快照

**Files:**
- Modify: Agents.md / Claude.md 第 15 节进度；README 仅写已验证能力

- [x] Agents.md / Claude.md 进度已更新
- [x] Agents.md / Claude.md 同步到当前完成边界
- [ ] README 等剩余 GUI / e2e 走查后再写
