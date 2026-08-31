# P0-19c 一轮回退（对话 rewind / 文件 restore）实施计划

> **致执行者：** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。
>
> **状态：** 待开始。
>
> **插入点：** [P0-19](p0-19-grok-host-capability-polish.md) 在 Sandbox 之后。文件侧复用 P0-12 已有 `task:preview-latest-turn-restore` / `task:restore-latest-turn`，禁止 `git reset` / `checkout`。

**优先级：** P0-A / 权重 4（用户以为「撤销」是一件事，实际是两件）

**Goal：** 提供诚实的「回退上一轮」：对话回退走 Grok `/rewind`（若已广告）；文件恢复走已有 latest-turn 检查点。两件事分开展示，漂移则拒绝改盘。

**Architecture：** Renderer 一张「回退上一轮」卡，两行独立动作：

1. **对话：** 若命令快照有 `rewind` 或 `undo`，空闲时 `startTurn("/rewind")`（或观察确认的等价发送）。
2. **文件：** 现有 preview IPC，用户确认后再 restore。无检查点、有外部漂移、非最新轮，只读说明原因。

**Tech Stack：** 现有 slash 快照、P0-12 Git review IPC、Permission Broker（文件恢复已走 git/write）。

**Spec：** [P0-19](p0-19-grok-host-capability-polish.md) 第 6 节。

## Global Constraints

- 沿用 P0-19。
- 自动恢复仅 latest-turn 且无漂移；检查点只存哈希。
- 禁止把 `/rewind` 包装成桌面自己的 session 编辑。
- 执行中禁止回退。
- 不实现任意历史轮次的文件时光机。

---

## 非目标

- 不做 `/fork`。
- 不恢复应用重启前的终端 scrollback。
- 不把对话 rewind 失败伪装成文件已恢复，反之亦然。

## 数据流

```text
用户点「回退上一轮」
  → 主进程 preview-latest-turn-restore
  → UI 展示两块：
        对话：Grok 是否广告 rewind；说明「只影响 Grok 上下文，不改磁盘」
        文件：可恢复路径摘要 / 不可恢复原因
  → 用户可只勾对话、只勾文件、或两项都要（默认两项都选但分开发送）
  → 文件：restore-latest-turn（Broker）
  → 对话：startTurn("/rewind") 仅当广告存在
  → 任一步失败：已成功的那步保持，失败步报脱敏错误，不回滚另一侧
```

## 安全边界

- 文件恢复继续走 P0-12：路径必须在 execution root；Broker 审批写/删。
- 对话 rewind 的 prompt 必须是快照里的真命令名，禁止拼 `undo` 别名除非快照含该 name。
- 预览不得把文件全文送到 Renderer，只给路径、变更类型、有限行数摘要（沿用 Changes 限长）。

## 文件范围

- 修改：Changes 面板或 Task 头的撤销入口（现在 latest-turn 入口若已存在则改文案，不并行第三颗按钮）
- 修改：`slash-command-palette.ts` 允许产品动作调用 rewind 命令
- 测试：preview 失败不调用 startTurn；无 rewind 命令时对话勾选禁用；漂移拒绝 restore
- 不修改 Git 检查点存储格式

### 任务 1: 分清两个动词

- [ ] **第 1 步: 盘点现有 UI**

说明：找到 P0-12 的撤销按钮/文案，列出它今天承诺了什么。若文案是笼统「撤销」，本任务必须改成「恢复上一轮文件」之类。

- [ ] **第 2 步: 真机 /rewind**

说明：看命令快照 name 是 `rewind` 还是 `undo`。发一次，观察是否只改会话、是否触发写文件权限。写入 observations 短记。

### 任务 2: 预览卡

- [ ] **第 1 步: 组合预览模型**

说明：共享类型例如 `TurnRewindPreview { conversation: 'available' | 'command-missing' | 'busy'; files: RestorePreview }`。Renderer 只渲染该模型。

- [ ] **第 2 步: 测试**

说明：command-missing 时对话 checkbox disabled；files.blocked 时文件按钮 disabled 且显示漂移/无检查点原因。

### 任务 3: 执行顺序与失败

- [ ] **第 1 步: 先文件后对话（推荐）**

说明：文件失败则默认不再发 `/rewind`，避免上下文和磁盘各退一步。用户若只勾对话则不碰磁盘。

- [ ] **第 2 步: 走查**

说明：有漂移的脏文件 → 文件拒绝、对话可选；干净 latest-turn → 文件恢复成功；有 rewind 命令 → 下一句 Grok 不再拿被退掉的轮次当事实。

## 验收标准

- [ ] UI 上能看出对话回退和文件恢复是两件事。
- [ ] 无检查点或漂移时不改盘。
- [ ] 无 rewind 广告时不发送伪造命令。
- [ ] 自动验证 + 开发版走查。
