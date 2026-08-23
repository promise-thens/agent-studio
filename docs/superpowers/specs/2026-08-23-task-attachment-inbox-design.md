# Task 附件柜与对话媒体 设计

> 状态：已确认，按方案 A 实施；主路径已落地，剩余见计划「未完成」
> 日期：2026-08-23
> 计划：[p0-18-task-attachment-inbox.md](../plans/p0-18-task-attachment-inbox.md)

## 1. 目标

Composer 支持上传、拖放、粘贴图片与白名单文件；每个 Task 在 App 目录有独立 inbox。对话展示：用户附件、Runtime 推送的 image 块、本轮 Agent 写入 execution root 的图片/PDF 预览。

## 2. 非目标

- 不实现 P0-14 Worktree 创建/清理/导出。本期 AI 产出预览绑在 `environmentId` / execution root 上，Worktree 落地后换根即可。
- 不把用户附件写入 Project canonical root 或未来 Worktree。
- 不渲染助手 Markdown 的 `![](url)` 热链。
- 不做 SVG、视频、音频、文件夹整棵拖入、任意 URL。
- 不广告未实现的 client 能力（GACP-05）。
- 不把 inbox 暴露给 Bash/工具子进程环境。
- 不在本计划实现 P0-13 Artifact Registry。

## 3. 产品决策（已锁定）

- 输入 + 输出都要：用户可贴图/传文件，对话能出图。
- 白名单：PNG / JPEG / WebP / GIF、常见文本/源码、PDF。
- 附件只当本轮上下文，不进用户 Git。
- 每个 Task 有 App 侧 inbox，不是整份项目拷贝。
- Worktree 与 AI 产出不冲突：Agent 写 execution root；用户材料进 inbox。
- 本期做 inbox + 对话预览；Worktree 仍走 P0-14。

## 4. 三套目录

```text
Project canonical root     用户仓库。Git 真相。
Task execution root        Agent cwd。今天 = Local 项目根；P0-14 后 = 受管 Worktree。
Task inbox                 用户/Runtime 媒体。App userData，不进 Git。
```

路径：

```text
userData/history/v1/projects/<projectId>/tasks/<taskId>/inbox/<attachmentId>/file
userData/history/v1/projects/<projectId>/tasks/<taskId>/inbox/<attachmentId>/meta.json
```

目录 `0700`，文件 `0600`。删 Task 时 inbox 一并删除。

## 5. 数据模型

```ts
type TaskAttachmentKind = 'image' | 'text' | 'pdf'
type TaskAttachmentSource = 'user' | 'runtime'
type TaskAttachmentBinding = 'draft' | 'bound'

interface TaskAttachmentDescriptor {
  attachmentId: string
  taskId: string
  originalName: string
  storedName: string
  kind: TaskAttachmentKind
  mimeType: string
  byteSize: number
  contentHash: string
  source: TaskAttachmentSource
  binding: TaskAttachmentBinding
  turnId?: string
  createdAt: string
  availability: 'ready' | 'missing' | 'invalid'
}
```

Renderer 不得获得绝对路径或完整原图。Turn 历史增加可选 `attachmentIds: string[]`。
`promptDisplayText` 仍是文本：有正文用正文；仅附件时用 `附件：<第一个文件名>`。

助手 image 块写入 inbox，`source: 'runtime'`，`binding: 'bound'`，并产生 `agent-attachment` 事件（只带 attachmentId / kind / originalName）。

## 6. 白名单与上限

**图片（扩展名 + 魔数一致）**

| 扩展名 | MIME | 魔数 |
| --- | --- | --- |
| `.png` | `image/png` | `89 50 4E 47` |
| `.jpg` `.jpeg` | `image/jpeg` | `FF D8 FF` |
| `.webp` | `image/webp` | `RIFF....WEBP` |
| `.gif` | `image/gif` | `GIF87a` / `GIF89a` |

**PDF：** `.pdf` + `%PDF` → `application/pdf`

**文本：** 扩展名白名单 + UTF-8（无 NUL）。MIME `text/plain`，`.json` 用 `application/json`，`.md` 用 `text/markdown`，`.csv` 用 `text/csv`。

文本扩展名：`.txt` `.md` `.markdown` `.json` `.csv` `.log` `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` `.vue` `.py` `.go` `.rs` `.java` `.kt` `.c` `.h` `.cpp` `.hpp` `.cs` `.rb` `.php` `.swift` `.sh` `.bash` `.zsh` `.toml` `.yaml` `.yml` `.xml` `.css` `.scss` `.sql` `.graphql` `.proto` `.html`

**一律拒绝：** SVG、`.env`、`.pem`、`.key`、`.p12`、可执行文件、目录、符号链接、扩展名/魔数冲突、空文件、未知二进制。

**上限**

- 每轮最多 8 个
- 单文件 10 MiB
- 本轮合计 20 MiB
- 单 Task inbox 200 MiB
- 图片像素 ≤ 20_000_000（主进程 `nativeImage`）
- 预览最长边 256px

## 7. 数据流

```text
选文件 / 拖放 / 粘贴
  → 主进程校验并写入 inbox（draft）
  → Renderer 只拿 descriptor
  → startTurn({ taskId, prompt, attachmentIds })
  → 主进程读 inbox、绑定 turnId
  → Adapter 组 ACP ContentBlock
  → 对话预览走受限 IPC
```

三个入口：

| 入口 | 做法 |
| --- | --- |
| 按钮 | 主进程 `showOpenDialog`（多选、过滤白名单） |
| 拖放 | Renderer 只传本地绝对路径；主进程 realpath 后拷贝 |
| 粘贴 | Composer 发现剪贴板有图/文件则 preventDefault，主进程读系统剪贴板。纯文本保持现状。图+字：附件入库，文字仍进 textarea |

`startTurn` 只传 ID，不传 base64。现有文本 Prompt 64KB 限额不变。

## 8. ACP 组块

`AgentRuntimeTurnContext` 增加：

```ts
attachments: Array<{
  fileName: string
  mimeType: string
  kind: TaskAttachmentKind
  bytes: Buffer
}>
```

组块顺序：

1. 文本。用户正文为空时使用 `请查看附件。`
2. 仅当握手 `promptCapabilities.image === true` 时，图片走 `ContentBlock::Image`（base64、mimeType）
3. 文本 / PDF / 未声明识图的图片走 `ContentBlock::Resource`（embeddedContext；Grok 已声明 true）
4. 禁止未声明时发 `Image`；禁止 `ResourceLink` 指向 `userData`

`AgentRuntimeStatus.promptMedia?: { image: boolean; embeddedContext: boolean }` 来自握手，不改 P0-03 固定能力 ID 表。Composer 在 `image === false` 时提示「当前 Runtime 未声明识图，将按文件附件发送」，不禁用输入。

## 9. IPC

Task 通道新增：

- `task:pick-attachments` `{ taskId }` → `TaskAttachmentDescriptor[]`
- `task:import-dropped-paths` `{ taskId, paths: string[] }` → `TaskAttachmentDescriptor[]`
- `task:import-clipboard` `{ taskId }` → `TaskAttachmentDescriptor[]`
- `task:list-draft-attachments` `{ taskId }` → `TaskAttachmentDescriptor[]`
- `task:remove-attachment` `{ taskId, attachmentId }` → `null`（仅 draft）
- `task:get-attachment-preview` `{ taskId, attachmentId }` → `{ descriptor, thumbnailBytes?: Uint8Array, thumbnailMime?: string }`
- `task:get-change-media-preview` `{ taskId, path }` → 同上形态；path 必须在该 Task 当前 ChangeSet 且 realpath 落在 execution root

`agent:start-turn` 请求变为 `{ taskId, prompt, attachmentIds?: string[] }`。`prompt` 允许空白，但 `prompt` 与 `attachmentIds` 不能同时空。

## 10. Composer / 对话

Composer：textarea 上附件芯片（缩略图或文件名、可移除）；footer 发送按钮左侧回形针；拖入高亮；`canSend` = 有正文或有 draft 附件。

用户气泡：正文 + 附件预览。助手：现有 Markdown 文本；`agent-attachment` 显示图片/文件卡。本轮 ChangeSet 中扩展名属于图片/PDF 的路径，在变更卡上出缩略图，点文件仍进 Changes。

## 11. 安全

- Renderer 无通用读文件、无 `file://`、无绝对路径。
- 拖入路径必须是普通文件；禁止把 inbox 当拖入源套娃。
- 每次写入、预览、发送都重新做魔数/大小/绑定校验。
- 错误脱敏，不回传其它文件路径。
- 测试只用假文件和本地字节，不用真实密钥。

## 12. 测试

- 分类器：PNG/JPEG/WebP/GIF/PDF/文本通过；SVG 伪装、扩展名冲突、空文件、`.env`、超限拒绝。
- Inbox：写入 draft、绑定 turn、删除 draft、Task 删除级联、200MiB 上限。
- IPC：startTurn 只收 ID；空 prompt+附件准入；空 prompt 无附件拒绝。
- Adapter：image 能力 true 发 Image；false 发 Resource；不发 ResourceLink。
- Composer：有附件无正文可发送。
- 对话投影：user 带 attachmentIds；agent-attachment 成块。
- 变更媒体：不在 ChangeSet 或逃出 execution root 的路径拒绝。

## 13. 剩余（相对本文）

完整清单以计划「未完成」为准。相对本 spec 仍缺：

- 助手 image 块 → inbox + `agent-attachment` 事件 + 对话渲染（§5、§10）
- `task:get-change-media-preview` 的主进程实现与变更卡缩略图（§9、§10）
- 拖放 `webUtils.getPathForFile`、macOS Finder 剪贴板文件名（§7）
- 实时 admission 带 `attachmentIds`；发送失败后 draft bind 回滚
- GUI 走查与附件 e2e；README 在验证前不宣称已支持
