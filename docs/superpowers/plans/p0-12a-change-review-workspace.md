# P0-12A 两层变更审阅工作区 实施计划

> **致执行者：** 本计划在 P0-12 数据层已落地的前提下，把审阅体验做成对话卡片 + 独立 Diff 工作区。步骤使用复选框跟踪。

**优先级：** P0-A / 权重 4（P0-12 的审阅入口与工作区；不改 Git 安全边界）

**目标：** 用户在对话里看到紧凑的「已编辑 N 个文件 +X −Y」卡片（撤销 / 审核），点审核后打开宽审阅工作区：文件树 + 大 Diff，可按文件看差异并走现有 latest-turn 撤销。

**非目标：**

- 不引入语法高亮库。
- 不把未包含在 unified diff 里的上下文行假装成可展开全文。
- 不改基线、归因、检查点、Permission Broker、禁止 git reset/checkout/clean/stash 的恢复实现。
- 不加回「继续任务」。
- 不把检查器改成第三列常驻栅格；仍是 overlay，仅 Changes 标签加宽。

**核心数据流：** `getChangeSet` 为每条路径附带可选 `added`/`deleted`（来自一次 `git diff --numstat HEAD`，未跟踪文件有界数行）。Renderer 用同一份 `TaskChangeSetQueryResult` 生成对话卡和工作区。`审核` 只打开检查器 Changes；`撤销` 仍走 `previewLatestTurnRestore` / `restoreLatestTurn`。

**安全边界：**

- 行数是摘要数字，不是文件正文；IPC 仍只传相对 posix 路径。
- Diff 仍按现有字节/二进制/越界限制。
- 未修改行摘要只根据 hunk 行号推算缺口，不另读工作区文件。
- 撤销条件与 P0-12 完全一致。

**文件范围：**

- 修改 `src/shared/git-review.ts` 及测试：路径可选 `added`/`deleted`。
- 修改 `src/main/git/git-review-service.ts` 及测试：numstat / 未跟踪行数。
- 修改 `src/renderer/src/task-changes-presentation.ts` 及测试：卡片、文件树、未修改行摘要。
- 修改 `src/renderer/src/task-inspector.ts` 及测试：Changes 为审阅工作区。
- 新建 `src/renderer/src/components/TaskChangeCard.vue`。
- 修改 `TaskChangesPanel.vue`、`FileDiffViewer.vue`、`TaskConversation.vue`、`TaskInspector.vue`、`TaskResultReview.vue`、`App.vue`、`main.css`。
- 更新 `Agents.md` / `Claude.md` 进度快照与 roadmap 索引。

---

## 任务 1: 变更集带每文件行数

- [x] **第 1 步:** `TaskChangePath` 增加可选非负整数 `added`/`deleted`；投影拒绝负数和非整数，缺省保持兼容。
- [x] **第 2 步:** Git 仓库对工作树跑一次只读 `diff --numstat HEAD`，映射到 execution root 相对路径；二进制 `-\t-` 不加行数。
- [x] **第 3 步:** 未跟踪文本按现有哈希上限数行，记为 `added`、`deleted: 0`；过大/二进制不加。
- [x] **第 4 步:** 归因测试覆盖修改/新增/删除的行数，且结果不含绝对路径。

## 任务 2: 对话变更卡视图

- [x] **第 1 步:** `presentChangeCard`：不含 pre-existing；标题「已编辑 N 个文件」；合计与每文件 +/-；`canRestore` 仍只看 latest-turn。
- [x] **第 2 步:** 无本 Task/未知路径时卡片不可见。
- [x] **第 3 步:** `TaskChangeCard` 放在最新一轮对话下；`审核` 打开 Changes 工作区，点文件同时选中该路径；`撤销` 打开工作区并走现有预览确认。
- [x] **第 4 步:** 有变更卡时结果审阅隐藏「修改路径」计数；不出现「继续任务」。

## 任务 3: 审阅工作区

- [x] **第 1 步:** Changes 标签给检查器 `is-review-workspace`，宽度约 `min(780px, 64%)`，主列仍 overlay。
- [x] **第 2 步:** 面板改为文件树 + 筛选 | 大 Diff；加载后自动选中第一个文件。
- [x] **第 3 步:** Diff 在 hunk 缺口插入「N 行未修改」只读摘要，不请求全文。
- [x] **第 4 步:** 验证与撤销收进工作区页脚；撤销文案与 P0-12 谓词不变。
- [x] **第 5 步:** `useTaskChanges` 提升到 App，对话卡与面板共享，关闭检查器不丢掉选中文件。

## 验收标准

- 对话卡展示文件数、+/-、文件列表、撤销/审核。
- 审核打开宽 Changes 工作区，树和 Diff 并排，对话仍可见。
- 撤销仍只在 latest-turn 且无漂移时可用，预览后确认。
- 自动验证：相关 Vitest、ESLint、typecheck、build、`git diff --check` 已过。开发版 GUI 走查未跑。
