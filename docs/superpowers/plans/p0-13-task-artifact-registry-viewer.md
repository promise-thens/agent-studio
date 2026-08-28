# P0-13 基础 Task Artifact Registry 与 Viewer 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0-B / 权重 4（在应用内查看首批真实任务产物）

**目标：** 建立 Local Task 级 Artifact 注册表和统一 Viewer，让 Agent 生成的文本、Markdown、图片与 Diff 可以在应用内安全审阅，并追溯到 Project、Task、Turn 和受限文件来源。

**核心数据流：** Agent 事件、Git Review 或用户显式选择向主进程 ArtifactRegistry 提交候选文件引用；Registry 校验 Local execution root、类型、大小和信任级别后生成 opaque `artifactId`；TaskStore 只持久化描述符与受限引用；Renderer 通过固定 Artifact IPC 按类型获取有限内容。

**约束与边界：** 本计划首次验收只支持 Local 环境的纯文本、Markdown、PNG/JPEG/WebP/GIF 图片和 P0-12 Diff；不是通用文件管理器或编辑器，也不接受任意路径输入。HTML 由 P0-16 使用独立 `WebContentsView` 实现，Worktree 集成由 P0-14 回归，PDF、Office、视频和跨站登录态后续单独规划。

**主要风险：** Markdown 原始 HTML、SVG、伪装 MIME、超大图片、符号链接和过期文件引用可能造成 XSS、内存耗尽或任意文件读取；使用 opaque ID、真实路径边界、MIME/扩展双校验、内容哈希、大小/像素上限和统一净化。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、Markdown sanitizer。

---

## 实施范围

**前置依赖：**
- 依赖 P0-06、P0-09、P0-10、P0-12；首次实现和验收限定 Local ExecutionEnvironmentRef。

**文件范围：**
- 创建 `src/main/artifact/artifact-registry.ts`、`artifact-content-service.ts` 及就近测试。
- 创建 `src/shared/artifact.ts`、固定 Artifact IPC 和窄 Preload API。
- 创建 `src/renderer/src/components/TaskArtifactsPanel.vue`、`ArtifactViewer.vue`、`TextArtifactViewer.vue`、`MarkdownArtifactViewer.vue`、`ImageArtifactViewer.vue` 和 `DiffArtifactViewer.vue`。
- 修改 TaskStore、Timeline/ResultReview 和 TaskInspector；不创建 HTML protocol 或 WebContents。

**安全策略：**
- Renderer 只持有 artifactId，不持有可扩大读取范围的绝对路径；主进程每次读取重新校验 Task、environment、真实路径和文件状态。
- Markdown 禁止原始危险 HTML，或统一经过严格 sanitizer 处理；链接协议使用白名单且默认不在应用内导航，SVG 不作为图片内联。
- 图片读取限制文件字节、解码像素和尺寸；未知、超限、损坏或扩展/MIME 冲突只展示安全元数据。
- Diff 只复用 P0-12 的受限查询/引用，不复制第二套 Git 读取和归因逻辑。

### 任务 1: 定义 ArtifactDescriptor 与 Local 注册规则

**任务目标：**
- 建立可追溯、可持久化但不泄漏任意文件读取能力的 Artifact 模型。

**涉及范围：**
- `src/shared/artifact.ts`、ArtifactRegistry 和 schema 测试。

**前置依赖：**
- P0-06 的 Task/Turn/Local Environment 身份和 P0-12 的 Diff 引用已稳定。

- [x] **第 1 步: 定义描述符**
说明：包含 artifactId、projectId、taskId、turnId、kind、title、mimeType、source、environmentId、受限相对路径或 diffRef、size、contentHash、createdAt、trustLevel、availability 和 revision。
预期：描述符足以审阅和重新验证，不包含 Provider Secret、任意 URL 凭据、原始绝对路径或文件内容。

- [x] **第 2 步: 实现候选注册校验**
说明：从 TaskStore 解析 Local execution root 和真实路径，拒绝符号链接逃逸、目录、设备文件、超限内容和扩展/MIME 冲突；生成不可预测 artifactId。
预期：同文件新内容生成新 revision/hash，Renderer 不能用相对路径或 artifactId 猜测读取其它文件。

- [x] **第 3 步: 关联 TaskStore 与历史**
说明：Task 历史只保存 ArtifactDescriptor 和受限引用；删除历史记录不删除项目文件。重启后重新验证 source path/hash 并更新 availability。
预期：Artifact 列表可恢复，源文件消失或变化时保留元数据并显示 missing/changed，而不是继续显示旧可信状态。

### 任务 2: 实现安全内容服务

**任务目标：**
- 按基础 Artifact 类型返回最小、安全、有限的数据。

**涉及范围：**
- content service、Artifact IPC、Preload 和测试。

**前置依赖：**
- 依赖任务 1 的注册表。

- [x] **第 1 步: 提供文本与 Markdown 内容**
说明：按 artifactId 读取有限 UTF-8 文本，检测二进制、BOM 和编码异常；Markdown 统一净化，禁用脚本、事件属性、危险 URL 和任意内联对象。
预期：超长或异常内容返回截断/unsupported 状态，错误不泄漏其它路径。

- [x] **第 2 步: 提供受限图片**
说明：只允许经签名/MIME 验证的 PNG、JPEG、WebP、GIF，读取前检查字节和像素上限；SVG、伪装扩展、损坏和超大图片安全降级。
预期：Renderer 获得有限 blob/data，而不是 file URL 或任意磁盘路径。

- [x] **第 3 步: 复用 P0-12 Diff**
说明：Diff Artifact 仅保存 TaskChangeSet/file diff 引用，查询时继续由 P0-12 校验 taskId、environmentId、路径、归因和截断状态。
预期：Artifact 与 Changes 面板看到同一 Diff 事实，不会出现两套基线或归因结果。

### 任务 3: 建立可用性、缓存与失效语义

**任务目标：**
- 让用户区分当前可信内容、外部变化、缺失和过期引用。

**涉及范围：**
- ArtifactRegistry、content cache、Task 历史恢复和测试。

**前置依赖：**
- 依赖任务 1、任务 2。

- [x] **第 1 步: 读取前重新验证**
说明：每次打开比较 projectId、taskId、environmentId、真实路径、kind、size 和 contentHash；文件变化后更新 revision/availability，不复用旧可信缓存。
预期：外部编辑、删除、替换为符号链接和权限变化立即降级，不返回旧内容冒充当前结果。

- [x] **第 2 步: 实现有界缓存**
说明：缓存键包含 artifactId/revision/hash，按总字节和最近使用淘汰；Markdown 净化结果与原内容 hash 绑定，图片 blob 关闭 Viewer 后可释放。
预期：连续切换 Artifact 不串内容，大文件不会长期占用主进程或 Renderer 内存。

- [x] **第 3 步: 固定 Local 首次验收边界**
说明：覆盖 Local 文件存在、变化、删除、项目移动/权限变化和应用重启；Worktree availability 与清理影响在 P0-14 接入后追加集成回归，不在本计划提前伪造。
预期：P0-13 可以独立在 Local 环境验收，且不会错误依赖尚未实现的 Worktree 生命周期。

### 任务 4: 实现基础 Artifact Viewer

**任务目标：**
- 在 Task 工作台按类型打开、切换和追溯首批产物。

**涉及范围：**
- TaskArtifactsPanel、ArtifactViewer、四种类型组件和组件测试。

**前置依赖：**
- 依赖任务 2、任务 3。

- [x] **第 1 步: 展示 Artifact 列表**
说明：按 Turn、类型和时间展示标题、来源、大小、trust、availability 和 revision；从 Timeline/ResultReview 可定位对应 Artifact。
预期：用户知道每个产物由哪一轮生成，失效或变化不会继续显示为已验证。

- [x] **第 2 步: 实现类型化查看器**
说明：文本、Markdown、图片和 Diff 分别使用专用 Viewer，统一加载、空态、失败、截断和重新验证交互；未知类型只显示元数据，不提供任意路径输入框。
预期：切换 Artifact 不串内容，键盘焦点和 `focus-visible` 保留，小窗口可以安全滚动。

- [ ] **第 3 步: 完成安全与体验走查**
说明：验证正常文本/Markdown/图片/Diff、恶意 Markdown、危险链接、SVG、伪装 MIME、路径逃逸、超大内容、源文件变化和应用重启。
预期：应用内能查看真实基础产物，所有不可信或超限内容安全降级。

## 验收标准

- [x] Artifact 通过 opaque artifactId 注册和读取，绑定 Project、Task、Turn 与 Local Execution Environment，Renderer 无法任意读盘。
- [x] 文本、Markdown、PNG/JPEG/WebP/GIF 图片和 Diff 均有明确类型、大小、净化、截断与失效策略；HTML 不在本计划实现。
- [x] Task 重启后可恢复 Artifact 元数据；源文件变化、删除、替换或权限变化不会继续显示旧可信内容。
- [x] Diff Artifact 复用 P0-12 的基线、归因和查询，不创建第二套 Git 事实源。
- [ ] 目标 ESLint、相关 Vitest/组件与安全测试、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过，并完成四类 Local Artifact 的 Electron 走查。
